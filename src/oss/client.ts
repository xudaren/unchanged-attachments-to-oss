import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { PluginSettings } from "../types";
import { encodeKey, sign } from "./signer";
import { CredentialVerificationError, OssError } from "./errors";

export { OssError } from "./errors";

export interface OssRequestOptions {
  method: "GET" | "PUT" | "POST" | "DELETE" | "HEAD";
  key: string;
  query?: Record<string, string>;
  body?: ArrayBuffer | string;
  contentType?: string;
  extraHeaders?: Record<string, string>;
}

export interface InitiateMultipartResult {
  uploadId: string;
}

export interface ListedMultipartUpload {
  key: string;
  uploadId: string;
  initiated: string;
}

/** OSS REST 客户端，全部走 requestUrl，跨平台且绕 CORS。 */
export class OssClient {
  constructor(
    private readonly settings: PluginSettings,
    private readonly sendRequest: typeof requestUrl = requestUrl,
  ) {}

  /** 所有 OSS 请求与签名访问统一使用标准 Bucket Host。 */
  private get standardHost(): string {
    const endpoint = this.settings.endpoint || `${this.settings.region}.aliyuncs.com`;
    return `${this.settings.bucketName}.${endpoint}`;
  }

  /** GetObject 的签名 host。 */
  get signedUrlHost(): string {
    return this.standardHost;
  }

  /** 拼装完整 URL。query 顺序不影响签名，但影响可读性 */
  private buildUrl(key: string, query?: Record<string, string>, host = this.standardHost): string {
    const qs = query
      ? "?" +
        Object.entries(query)
          .map(([k, v]) => (v === "" ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`))
          .join("&")
      : "";
    return `https://${host}/${encodeKey(key)}${qs}`;
  }

  /** OSS API 始终走标准 Bucket Host。 */
  private async doRequest(opts: OssRequestOptions, host = this.standardHost): Promise<RequestUrlResponse> {
    const date = new Date().toUTCString();
    const ossHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) {
      if (k.toLowerCase().startsWith("x-oss-")) ossHeaders[k.toLowerCase()] = v;
    }
    const signature = await sign(
      {
        method: opts.method,
        bucket: this.settings.bucketName,
        key: opts.key,
        contentType: opts.contentType,
        dateOrExpires: date,
        ossHeaders,
        query: opts.query,
      },
      this.settings.accessKeySecret,
    );
    const headers: Record<string, string> = {
      Date: date,
      Authorization: `OSS ${this.settings.accessKeyId}:${signature}`,
      ...(opts.extraHeaders ?? {}),
    };
    if (opts.contentType) headers["Content-Type"] = opts.contentType;

    const req: RequestUrlParam = {
      url: this.buildUrl(opts.key, opts.query, host),
      method: opts.method,
      headers,
      body: opts.body,
      throw: false,
    };
    const resp = await this.sendRequest(req);
    if (resp.status < 200 || resp.status >= 300) {
      throw new OssError(resp.status, resp.text, opts.method, opts.key);
    }
    return resp;
  }

  async initiateMultipart(key: string, contentType: string): Promise<InitiateMultipartResult> {
    const resp = await this.doRequest({
      method: "POST",
      key,
      query: { uploads: "" },
      contentType,
    });
    const uploadId = extractXmlTag(resp.text, "UploadId");
    if (!uploadId) throw new Error(`InitiateMultipartUpload 缺少 UploadId：${resp.text}`);
    return { uploadId };
  }

  async uploadPart(params: {
    key: string;
    uploadId: string;
    partNumber: number;
    body: ArrayBuffer;
  }): Promise<{ etag: string }> {
    const resp = await this.doRequest({
      method: "PUT",
      key: params.key,
      query: { partNumber: String(params.partNumber), uploadId: params.uploadId },
      body: params.body,
    });
    const etag = resp.headers["etag"] ?? resp.headers["ETag"];
    if (!etag) throw new Error(`UploadPart 缺少 ETag：partNumber=${params.partNumber}`);
    return { etag };
  }

  async completeMultipart(params: {
    key: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<void> {
    const sorted = [...params.parts].sort((a, b) => a.partNumber - b.partNumber);
    const xml =
      "<CompleteMultipartUpload>" +
      sorted
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
        .join("") +
      "</CompleteMultipartUpload>";
    await this.doRequest({
      method: "POST",
      key: params.key,
      query: { uploadId: params.uploadId },
      body: xml,
      contentType: "application/xml",
    });
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.doRequest({
      method: "DELETE",
      key,
      query: { uploadId },
    });
  }

  async deleteObject(key: string): Promise<void> {
    await this.doRequest({ method: "DELETE", key });
  }

  /** 列出全部未完成的 MultipartUpload（单页，最多 1000 条，够用） */
  async listMultipartUploads(): Promise<ListedMultipartUpload[]> {
    const resp = await this.doRequest({
      method: "GET",
      key: "",
      query: { uploads: "" },
    });
    return parseUploadsXml(resp.text);
  }

  /** 对随机不存在 Key 发送签名 GET；NoSuchKey 证明 Bucket、签名和 GetObject 权限有效。 */
  async verifyCredentials(): Promise<boolean> {
    const prefix = this.settings.objectKeyPrefix.replace(/^\/+|\/+$/g, "");
    const probeKey = `${prefix ? `${prefix}/` : ""}.oss-plugin-probe/${crypto.randomUUID()}`;
    const request: OssRequestOptions = {
      method: "GET",
      key: probeKey,
    };

    try {
      await this.doRequest(request, this.standardHost);
    } catch (error) {
      if (error instanceof OssError && error.status === 404 && error.code === "NoSuchKey") return true;
      throw new CredentialVerificationError("oss", this.standardHost, error);
    }

    return true;
  }
}

function extractXmlTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function parseUploadsXml(xml: string): ListedMultipartUpload[] {
  const results: ListedMultipartUpload[] = [];
  const re = /<Upload>([\s\S]*?)<\/Upload>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const key = extractXmlTag(block, "Key");
    const uploadId = extractXmlTag(block, "UploadId");
    const initiated = extractXmlTag(block, "Initiated");
    if (key && uploadId && initiated) results.push({ key, uploadId, initiated });
  }
  return results;
}
