import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { PluginSettings } from "../types";
import { encodeKey, sign } from "./signer";

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
  constructor(private readonly settings: PluginSettings) {}

  /** 请求 host：优先 CNAME，其次 bucket.endpoint */
  private get host(): string {
    if (this.settings.cname) return this.settings.cname;
    const endpoint = this.settings.endpoint || `${this.settings.region}.aliyuncs.com`;
    return `${this.settings.bucketName}.${endpoint}`;
  }

  /** GetObject 的签名 host（可能是 CNAME） */
  get signedUrlHost(): string {
    return this.host;
  }

  /** 拼装完整 URL。query 顺序不影响签名，但影响可读性 */
  private buildUrl(key: string, query?: Record<string, string>): string {
    const qs = query
      ? "?" +
        Object.entries(query)
          .map(([k, v]) => (v === "" ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`))
          .join("&")
      : "";
    return `https://${this.host}/${encodeKey(key)}${qs}`;
  }

  private async doRequest(opts: OssRequestOptions): Promise<RequestUrlResponse> {
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
      url: this.buildUrl(opts.key, opts.query),
      method: opts.method,
      headers,
      body: opts.body,
      throw: false,
    };
    const resp = await requestUrl(req);
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

  /**
   * 轻量凭证校验：ListObjectsV2 max-keys=0，验证 Bucket 可达 + AK/SK 有效。
   * 正常返回 true；签名/网络/权限异常则抛出 OssError。
   */
  async verifyCredentials(): Promise<boolean> {
    await this.doRequest({
      method: "GET",
      key: "",
      query: { "list-type": "2", "max-keys": "0" },
    });
    return true;
  }
}

export class OssError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    method: string,
    key: string,
  ) {
    super(`OSS ${method} /${key} → ${status}: ${extractXmlTag(body, "Code") ?? body.slice(0, 200)}`);
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
