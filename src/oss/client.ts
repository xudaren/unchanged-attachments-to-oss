import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { PluginSettings } from "../types";
import { normalizeBucketName, normalizeOssEndpoint } from "../config";
import {
  canonicalQueryString,
  encodeKey,
  formatV4Timestamp,
  normalizeSigningRegion,
  OssHttpMethod,
  signV4Request,
} from "./signer";
import { CredentialVerificationError, OssError } from "./errors";

export { OssError } from "./errors";

export interface OssRequestOptions {
  method: OssHttpMethod;
  key: string;
  query?: Record<string, string>;
  body?: ArrayBuffer | string;
  contentType?: string;
  extraHeaders?: Record<string, string>;
  /** Request-local gate, e.g. automatic-upload pause, checked after signing. */
  beforeSend?: () => void;
}

export interface OssConnectionSnapshot {
  readonly region: string;
  readonly bucketName: string;
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly endpoint: string;
  readonly objectKeyPrefix: string;
}

export interface InitiateMultipartResult {
  uploadId: string;
}

export interface CompleteMultipartResult {
  key: string | null;
  etag: string | null;
  requestId: string | null;
}

export interface ListedMultipartUpload {
  key: string;
  uploadId: string;
  initiated: string;
}

export interface ListedObject {
  key: string;
  lastModified: string;
  size: number;
}

interface ListedMultipartPage {
  uploads: ListedMultipartUpload[];
  isTruncated: boolean;
  nextKeyMarker: string | null;
  nextUploadIdMarker: string | null;
}

/** OSS REST client. Every instance captures one immutable storage/credential snapshot. */
export class OssClient {
  private readonly connection: Readonly<OssConnectionSnapshot>;

  constructor(
    settings: PluginSettings,
    private readonly sendRequest: typeof requestUrl = requestUrl,
    private readonly now: () => Date = () => new Date(),
    private readonly beforeSend: () => void = () => undefined,
  ) {
    const region = normalizeSigningRegion(settings.region);
    this.connection = Object.freeze({
      region,
      bucketName: normalizeBucketName(settings.bucketName),
      accessKeyId: settings.accessKeyId,
      accessKeySecret: settings.accessKeySecret,
      endpoint: normalizeOssEndpoint(settings.endpoint, region),
      objectKeyPrefix: settings.objectKeyPrefix,
    });
  }

  get connectionSnapshot(): Readonly<OssConnectionSnapshot> {
    return this.connection;
  }

  /** All data, management and presigned requests use the standard bucket host. */
  private get standardHost(): string {
    return `${this.connection.bucketName}.${this.connection.endpoint}`;
  }

  get signedUrlHost(): string {
    return this.standardHost;
  }

  get signedUrlRegion(): string {
    return this.connection.region;
  }

  private buildUrl(key: string, query?: Record<string, string>): string {
    const qs = canonicalQueryString(query);
    return `https://${this.standardHost}/${encodeKey(key)}${qs ? `?${qs}` : ""}`;
  }

  private async doRequest(opts: OssRequestOptions): Promise<RequestUrlResponse> {
    // Reject an unloaded generation or invalid runtime configuration before
    // even deriving a signature. The same gate runs again after the async
    // Web Crypto work to close the hot-reload race immediately before I/O.
    this.beforeSend();
    const requestHeaders: Record<string, string> = { ...(opts.extraHeaders ?? {}) };
    if (opts.contentType) requestHeaders["Content-Type"] = opts.contentType;
    const signature = await signV4Request({
      method: opts.method,
      bucket: this.connection.bucketName,
      key: opts.key,
      region: this.connection.region,
      accessKeyId: this.connection.accessKeyId,
      accessKeySecret: this.connection.accessKeySecret,
      query: opts.query,
      headers: requestHeaders,
      timestamp: formatV4Timestamp(this.now()),
    });
    const headers: Record<string, string> = {
      ...requestHeaders,
      ...signature.requiredHeaders,
      Authorization: signature.authorization,
    };
    const req: RequestUrlParam = {
      url: this.buildUrl(opts.key, opts.query),
      method: opts.method,
      headers,
      body: opts.body,
      throw: false,
    };
    // Signing is asynchronous. Re-check the owning plugin generation at the
    // last possible point so a hot-reloaded instance cannot start a late OSS
    // request with stale credentials or stale task state.
    this.beforeSend();
    opts.beforeSend?.();
    const resp = await this.sendRequest(req);
    if (resp.status < 200 || resp.status >= 300) {
      throw new OssError(resp.status, resp.text, opts.method, opts.key);
    }
    return resp;
  }

  async initiateMultipart(
    key: string,
    contentType: string,
    beforeSend?: () => void,
  ): Promise<InitiateMultipartResult> {
    const resp = await this.doRequest({
      method: "POST",
      key,
      query: { uploads: "" },
      contentType,
      beforeSend,
    });
    const uploadId = extractXmlTag(resp.text, "UploadId");
    if (!uploadId) throw new Error(`InitiateMultipartUpload 缺少 UploadId：${resp.text}`);
    return { uploadId: decodeXml(uploadId) };
  }

  async uploadPart(params: {
    key: string;
    uploadId: string;
    partNumber: number;
    body: ArrayBuffer;
    beforeSend?: () => void;
  }): Promise<{ etag: string }> {
    const resp = await this.doRequest({
      method: "PUT",
      key: params.key,
      query: { partNumber: String(params.partNumber), uploadId: params.uploadId },
      body: params.body,
      beforeSend: params.beforeSend,
    });
    const etag = getHeader(resp.headers, "etag");
    if (!etag) throw new Error(`UploadPart 缺少 ETag：partNumber=${params.partNumber}`);
    return { etag };
  }

  async completeMultipart(params: {
    key: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
    beforeSend?: () => void;
  }): Promise<CompleteMultipartResult> {
    const sorted = [...params.parts].sort((a, b) => a.partNumber - b.partNumber);
    const xml =
      "<CompleteMultipartUpload>" +
      sorted
        .map((part) =>
          `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`)
        .join("") +
      "</CompleteMultipartUpload>";
    const resp = await this.doRequest({
      method: "POST",
      key: params.key,
      query: { uploadId: params.uploadId },
      body: xml,
      contentType: "application/xml",
      beforeSend: params.beforeSend,
    });
    return {
      key: decodeXmlNullable(extractXmlTagRaw(resp.text, "Key")),
      etag: decodeXmlNullable(extractXmlTag(resp.text, "ETag")),
      requestId: getHeader(resp.headers, "x-oss-request-id"),
    };
  }

  async headObject(key: string, beforeSend?: () => void): Promise<boolean> {
    try {
      await this.doRequest({ method: "HEAD", key, beforeSend });
      return true;
    } catch (error) {
      if (error instanceof OssError && error.status === 404 && error.code === "NoSuchKey") {
        return false;
      }
      // HEAD responses commonly have no XML body, so a bare 404 cannot safely
      // distinguish NoSuchKey from NoSuchBucket. A one-byte ranged GET keeps the
      // confirmation bounded while returning OSS's structured error document.
      if (error instanceof OssError && error.status === 404 && !error.code) {
        try {
          await this.doRequest({
            method: "GET",
            key,
            extraHeaders: { Range: "bytes=0-0" },
            beforeSend,
          });
          return true;
        } catch (confirmationError) {
          if (
            confirmationError instanceof OssError &&
            confirmationError.status === 404 &&
            confirmationError.code === "NoSuchKey"
          ) return false;
          throw confirmationError;
        }
      }
      throw error;
    }
  }

  async abortMultipart(key: string, uploadId: string, beforeSend?: () => void): Promise<void> {
    await this.doRequest({
      method: "DELETE",
      key,
      query: { uploadId },
      beforeSend,
    });
  }

  async deleteObject(key: string): Promise<void> {
    await this.doRequest({ method: "DELETE", key });
  }

  /** Prefix-scoped, fully paginated ListMultipartUploads. */
  async listMultipartUploads(prefix: string): Promise<ListedMultipartUpload[]> {
    const scopedPrefix = normalizeRequiredPrefix(prefix);
    const uploads: ListedMultipartUpload[] = [];
    let keyMarker: string | null = null;
    let uploadIdMarker: string | null = null;
    const seenMarkers = new Set<string>();
    for (;;) {
      const query: Record<string, string> = {
        uploads: "",
        prefix: scopedPrefix,
        "max-uploads": "1000",
        "encoding-type": "url",
      };
      if (keyMarker !== null) {
        query["key-marker"] = keyMarker;
        query["upload-id-marker"] = uploadIdMarker ?? "";
      }
      const resp = await this.doRequest({ method: "GET", key: "", query });
      const page = parseUploadsXml(resp.text);
      uploads.push(...page.uploads);
      if (!page.isTruncated) break;
      if (!page.nextKeyMarker || page.nextUploadIdMarker === null) {
        throw new Error("ListMultipartUploads 返回截断结果但缺少双 Marker");
      }
      const markerPair = JSON.stringify([page.nextKeyMarker, page.nextUploadIdMarker]);
      if (seenMarkers.has(markerPair)) throw new Error("ListMultipartUploads 返回重复 Marker");
      seenMarkers.add(markerPair);
      keyMarker = page.nextKeyMarker;
      uploadIdMarker = page.nextUploadIdMarker;
    }
    return uploads;
  }

  /** Fully paginated ListObjectsV2 under the caller-selected prefix. */
  async listObjects(prefix: string): Promise<ListedObject[]> {
    const objects: ListedObject[] = [];
    let continuationToken: string | null = null;
    const seenTokens = new Set<string>();
    do {
      const query: Record<string, string> = {
        "list-type": "2",
        prefix,
        "max-keys": "1000",
        "encoding-type": "url",
      };
      if (continuationToken) query["continuation-token"] = continuationToken;
      const resp = await this.doRequest({ method: "GET", key: "", query });
      const page = parseObjectsXml(resp.text);
      objects.push(...page.objects);
      const nextToken = page.isTruncated ? page.nextContinuationToken : null;
      if (page.isTruncated && !nextToken) {
        throw new Error("ListObjectsV2 返回截断结果但缺少 NextContinuationToken");
      }
      if (page.isTruncated && nextToken) {
        if (seenTokens.has(nextToken)) {
          throw new Error("ListObjectsV2 返回重复 ContinuationToken");
        }
        seenTokens.add(nextToken);
      }
      continuationToken = nextToken;
    } while (continuationToken);
    return objects;
  }

  /** A random missing GetObject validates bucket, V4 signature and GetObject permission. */
  async verifyCredentials(): Promise<boolean> {
    const prefix = this.connection.objectKeyPrefix.replace(/^\/+|\/+$/g, "");
    const probeKey = `${prefix ? `${prefix}/` : ""}.oss-plugin-probe/${crypto.randomUUID()}`;
    try {
      await this.doRequest({ method: "GET", key: probeKey });
    } catch (error) {
      if (error instanceof OssError && error.status === 404 && error.code === "NoSuchKey") return true;
      throw new CredentialVerificationError("oss", this.standardHost, error);
    }
    return true;
  }
}

function extractXmlTag(xml: string, tag: string): string | null {
  const value = extractXmlTagRaw(xml, tag);
  return value === null ? null : value.trim();
}

/** Object Keys are opaque bytes; their XML text must not be whitespace-trimmed. */
function extractXmlTagRaw(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] : null;
}

function parseUploadsXml(xml: string): ListedMultipartPage {
  const urlEncoded = extractXmlTag(xml, "EncodingType") === "url";
  const uploads: ListedMultipartUpload[] = [];
  const blocks = /<Upload>([\s\S]*?)<\/Upload>/g;
  let match: RegExpExecArray | null;
  while ((match = blocks.exec(xml)) !== null) {
    const key = extractXmlTagRaw(match[1], "Key");
    const uploadId = extractXmlTag(match[1], "UploadId");
    const initiated = extractXmlTag(match[1], "Initiated");
    if (key && uploadId && initiated) {
      uploads.push({
        key: decodeListedKey(key, urlEncoded),
        uploadId: decodeXml(uploadId),
        initiated,
      });
    }
  }
  return {
    uploads,
    isTruncated: extractXmlTag(xml, "IsTruncated") === "true",
    nextKeyMarker: decodeListedKeyNullable(extractXmlTagRaw(xml, "NextKeyMarker"), urlEncoded),
    nextUploadIdMarker: decodeXmlNullable(extractXmlTag(xml, "NextUploadIdMarker")),
  };
}

function parseObjectsXml(xml: string): {
  objects: ListedObject[];
  isTruncated: boolean;
  nextContinuationToken: string | null;
} {
  const urlEncoded = extractXmlTag(xml, "EncodingType") === "url";
  const objects: ListedObject[] = [];
  const blocks = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = blocks.exec(xml)) !== null) {
    const key = extractXmlTagRaw(match[1], "Key");
    const lastModified = extractXmlTag(match[1], "LastModified");
    const size = Number(extractXmlTag(match[1], "Size"));
    if (key && lastModified && Number.isFinite(size)) {
      objects.push({ key: decodeListedKey(key, urlEncoded), lastModified, size });
    }
  }
  return {
    objects,
    isTruncated: extractXmlTag(xml, "IsTruncated") === "true",
    nextContinuationToken: decodeXmlNullable(extractXmlTag(xml, "NextContinuationToken")),
  };
}

function normalizeRequiredPrefix(value: string): string {
  const prefix = value.replace(/\/+$/g, "");
  if (!prefix.trim()) throw new Error("ListMultipartUploads 必须指定非空 Object Key 前缀");
  if (prefix.startsWith("/")) throw new Error("ListMultipartUploads 的 Object Key 前缀不能以 / 开头");
  return `${prefix}/`;
}

function decodeListedKeyNullable(value: string | null, urlEncoded: boolean): string | null {
  return value === null ? null : decodeListedKey(value, urlEncoded);
}

function decodeListedKey(value: string, urlEncoded: boolean): string {
  const decodedXml = decodeXml(value);
  if (!urlEncoded) return decodedXml;
  try {
    return decodeURIComponent(decodedXml);
  } catch {
    throw new Error("OSS 列表返回了无效的 URL 编码 Object Key，已中止本次操作");
  }
}

function decodeXmlNullable(value: string | null): string | null {
  return value === null ? null : decodeXml(value);
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getHeader(headers: Record<string, string>, name: string): string | null {
  const expected = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === expected) return value;
  }
  return null;
}
