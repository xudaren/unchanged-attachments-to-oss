/** Aliyun OSS Signature V4, implemented only with Web Crypto for mobile parity. */

import { V4SigningKeyCache } from "./hmac-key-cache";

export const OSS_V4_ALGORITHM = "OSS4-HMAC-SHA256";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const MAX_PRESIGNED_URL_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

const encoder = new TextEncoder();
const signingKeyCache = new V4SigningKeyCache();

export type OssHttpMethod = "GET" | "PUT" | "POST" | "DELETE" | "HEAD";

export interface V4RequestSignInput {
  method: OssHttpMethod;
  bucket: string;
  key: string;
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** Optional non-required headers that must also be signed. */
  additionalHeaderNames?: string[];
  /** ISO 8601 basic UTC timestamp, injected by tests or one request snapshot. */
  timestamp?: string;
}

export interface V4RequestSignature {
  authorization: string;
  timestamp: string;
  signature: string;
  canonicalRequest: string;
  stringToSign: string;
  /** Mandatory headers that the caller must put on the actual request. */
  requiredHeaders: Record<string, string>;
}

export interface V4CanonicalRequestInput {
  method: OssHttpMethod;
  bucket: string;
  key: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  additionalHeaderNames?: string[];
  hashedPayload?: string;
}

/** Accept both cn-hangzhou and the legacy UI value oss-cn-hangzhou. */
export function normalizeSigningRegion(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^oss-/, "");
  if (!normalized || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(normalized)) {
    throw new Error("OSS V4 签名 Region 无效，请填写如 cn-hangzhou");
  }
  return normalized;
}

export function formatV4Timestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("OSS V4 签名时间无效");
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export function buildV4CanonicalRequest(input: V4CanonicalRequestInput): {
  canonicalRequest: string;
  additionalHeaders: string;
} {
  const normalizedHeaders = normalizeHeaders(input.headers);
  const additionalNames = normalizeAdditionalHeaderNames(
    input.additionalHeaderNames,
    normalizedHeaders,
  );
  const signedHeaderNames = new Set<string>();
  for (const name of Object.keys(normalizedHeaders)) {
    if (name === "content-type" || name === "content-md5" || name.startsWith("x-oss-")) {
      signedHeaderNames.add(name);
    }
  }
  for (const name of additionalNames) signedHeaderNames.add(name);

  const canonicalHeaders = [...signedHeaderNames]
    .sort(compareEncoded)
    .map((name) => `${name}:${normalizedHeaders[name].trim()}\n`)
    .join("");
  const additionalHeaders = additionalNames.join(";");
  const canonicalRequest = [
    input.method,
    canonicalResourcePath(input.bucket, input.key),
    canonicalQueryString(input.query),
    canonicalHeaders,
    additionalHeaders,
    input.hashedPayload ?? UNSIGNED_PAYLOAD,
  ].join("\n");
  return { canonicalRequest, additionalHeaders };
}

export async function signV4Request(input: V4RequestSignInput): Promise<V4RequestSignature> {
  const region = normalizeSigningRegion(input.region);
  const timestamp = input.timestamp ?? formatV4Timestamp(new Date());
  assertV4Timestamp(timestamp);
  const date = timestamp.slice(0, 8);
  const scope = `${date}/${region}/oss/aliyun_v4_request`;
  const requiredHeaders = {
    "x-oss-content-sha256": UNSIGNED_PAYLOAD,
    "x-oss-date": timestamp,
  };
  const headers = {
    ...(input.headers ?? {}),
    ...requiredHeaders,
  };
  const { canonicalRequest, additionalHeaders } = buildV4CanonicalRequest({
    method: input.method,
    bucket: input.bucket,
    key: input.key,
    query: input.query,
    headers,
    additionalHeaderNames: input.additionalHeaderNames,
  });
  const stringToSign = [
    OSS_V4_ALGORITHM,
    timestamp,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = await signWithDerivedKey(
    input.accessKeySecret,
    date,
    region,
    stringToSign,
  );
  const fields = [`Credential=${input.accessKeyId}/${scope}`];
  if (additionalHeaders) fields.push(`AdditionalHeaders=${additionalHeaders}`);
  fields.push(`Signature=${signature}`);
  return {
    authorization: `${OSS_V4_ALGORITHM} ${fields.join(",")}`,
    timestamp,
    signature,
    canonicalRequest,
    stringToSign,
    requiredHeaders,
  };
}

/** Generate a V4 presigned GetObject URL. */
export async function signedGetUrl(params: {
  bucket: string;
  key: string;
  host: string;
  accessKeyId: string;
  accessKeySecret: string;
  expireSeconds: number;
  /** Required for V4; temporarily inferred from a standard host for old callers. */
  region?: string;
  now?: Date;
}): Promise<{ url: string; expireAt: number }> {
  const expireSeconds = normalizeExpires(params.expireSeconds);
  const now = params.now ?? new Date();
  const timestamp = formatV4Timestamp(now);
  const date = timestamp.slice(0, 8);
  const region = params.region
    ? normalizeSigningRegion(params.region)
    : inferSigningRegionFromHost(params.host);
  const scope = `${date}/${region}/oss/aliyun_v4_request`;
  const query: Record<string, string> = {
    "x-oss-additional-headers": "host",
    "x-oss-credential": `${params.accessKeyId}/${scope}`,
    "x-oss-date": timestamp,
    "x-oss-expires": String(expireSeconds),
    "x-oss-signature-version": OSS_V4_ALGORITHM,
  };
  const { canonicalRequest } = buildV4CanonicalRequest({
    method: "GET",
    bucket: params.bucket,
    key: params.key,
    query,
    headers: { host: params.host },
    additionalHeaderNames: ["host"],
  });
  const stringToSign = [
    OSS_V4_ALGORITHM,
    timestamp,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = await signWithDerivedKey(
    params.accessKeySecret,
    date,
    region,
    stringToSign,
  );
  const signedQuery = canonicalQueryString({ ...query, "x-oss-signature": signature });
  const signedAt = Math.floor(now.getTime() / 1000) * 1000;
  return {
    url: `https://${params.host}/${encodeKey(params.key)}?${signedQuery}`,
    expireAt: signedAt + expireSeconds * 1000,
  };
}

export function clearHmacKeyCache(): void {
  signingKeyCache.clear();
}

/** RFC 3986 encoding required by OSS V4; object path separators stay literal. */
export function encodeKey(key: string): string {
  return key.split("/").map(uriEncodePathSegment).join("/");
}

export function canonicalQueryString(query: Record<string, string> | undefined): string {
  if (!query) return "";
  return Object.entries(query)
    .map(([key, value]) => [uriEncode(key), uriEncode(value), value === ""] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      compareEncoded(leftKey, rightKey) || compareEncoded(leftValue, rightValue))
    .map(([key, value, empty]) => (empty ? key : `${key}=${value}`))
    .join("&");
}

function canonicalResourcePath(bucket: string, key: string): string {
  const resource = key ? `/${bucket}/${key}` : `/${bucket}/`;
  return resource.split("/").map(uriEncodePathSegment).join("/");
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    normalized[name.trim().toLowerCase()] = value;
  }
  return normalized;
}

function normalizeAdditionalHeaderNames(
  names: string[] | undefined,
  headers: Record<string, string>,
): string[] {
  const normalized = [...new Set((names ?? []).map((name) => name.trim().toLowerCase()))]
    .filter(Boolean)
    .sort(compareEncoded);
  for (const name of normalized) {
    if (!(name in headers)) throw new Error(`OSS V4 附加签名 Header 缺失：${name}`);
    if (name === "content-type" || name === "content-md5" || name.startsWith("x-oss-")) {
      throw new Error(`OSS V4 必选 Header 不应列入 AdditionalHeaders：${name}`);
    }
  }
  return normalized;
}

function uriEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%[0-9a-f]{2}/g, (encoded) => encoded.toUpperCase());
}

function uriEncodePathSegment(value: string): string {
  if (value === "." || value === "..") {
    throw new Error("OSS Object Key 不能包含 . 或 .. URL 路径段");
  }
  return uriEncode(value);
}

function compareEncoded(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function signWithDerivedKey(
  secret: string,
  date: string,
  region: string,
  value: string,
): Promise<string> {
  const key = await signingKeyCache.get(secret, date, region);
  return bytesToHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertV4Timestamp(value: string): void {
  if (!/^\d{8}T\d{6}Z$/.test(value)) {
    throw new Error("OSS V4 签名时间必须使用 YYYYMMDDTHHMMSSZ");
  }
}

function normalizeExpires(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PRESIGNED_URL_EXPIRES_SECONDS) {
    throw new Error("OSS V4 签名 URL 有效期必须在 1 到 604800 秒之间");
  }
  return value;
}

function inferSigningRegionFromHost(host: string): string {
  const match = host.toLowerCase().match(/(?:^|\.)oss-([a-z0-9-]+)\.aliyuncs\.com(?::\d+)?$/);
  if (!match) throw new Error("OSS V4 签名需要明确的 Region");
  return normalizeSigningRegion(match[1].replace(/-(?:internal|intranet)$/, ""));
}
