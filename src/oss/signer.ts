/**
 * 阿里云 OSS V1 签名
 *
 * 官方签名规范:
 *   StringToSign = HTTP-Verb + "\n" + Content-MD5 + "\n" + Content-Type + "\n" +
 *                  Date-Or-Expires + "\n" + CanonicalizedOSSHeaders + CanonicalizedResource
 *   Signature    = base64(HMAC-SHA1(AccessKeySecret, StringToSign))
 *
 * 全部使用 Web Crypto，兼容 Obsidian 移动端。
 */

import { HmacKeyCache } from "./hmac-key-cache";

const encoder = new TextEncoder();
const hmacKeyCache = new HmacKeyCache();

/** 参与签名的 OSS 子资源白名单（按字母序） */
const SIGNED_SUBRESOURCES = new Set([
  "acl", "append", "bucketInfo", "callback", "callback-var", "cname",
  "comp", "cors", "delete", "endTime", "img", "lifecycle", "live",
  "location", "logging", "objectMeta", "partNumber", "position",
  "qos", "referer", "replication", "replicationLocation", "replicationProgress",
  "response-cache-control", "response-content-disposition",
  "response-content-encoding", "response-content-language",
  "response-content-type", "response-expires", "restore", "security-token",
  "startTime", "status", "style", "styleName", "symlink", "tagging",
  "udf", "udfApplication", "udfApplicationLog", "udfImage", "udfImageDesc",
  "udfName", "uploadId", "uploads", "vod", "website", "x-oss-process",
]);

export interface SignInput {
  method: "GET" | "PUT" | "POST" | "DELETE" | "HEAD";
  bucket: string;
  /** 不含前导 / 的 object key，空字符串代表 bucket-level 请求 */
  key: string;
  contentMd5?: string;
  contentType?: string;
  /** header 签名用 Date（RFC 1123 GMT），URL 签名用 Expires（unix 秒） */
  dateOrExpires: string;
  /** x-oss-* 头（key 小写） */
  ossHeaders?: Record<string, string>;
  /** 全部 query 参数（含子资源与非子资源） */
  query?: Record<string, string>;
}

function canonicalizedOssHeaders(h: Record<string, string> | undefined): string {
  if (!h) return "";
  const entries = Object.entries(h)
    .map(([k, v]) => [k.toLowerCase(), v.trim()] as const)
    .filter(([k]) => k.startsWith("x-oss-"))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}:${v}\n`).join("");
}

function canonicalizedResource(bucket: string, key: string, query: Record<string, string> | undefined): string {
  const base = key ? `/${bucket}/${key}` : `/${bucket}/`;
  if (!query) return base;
  const subs = Object.entries(query)
    .filter(([k]) => SIGNED_SUBRESOURCES.has(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => (v === "" ? k : `${k}=${v}`));
  return subs.length ? `${base}?${subs.join("&")}` : base;
}

export function buildStringToSign(input: SignInput): string {
  return [
    input.method,
    input.contentMd5 ?? "",
    input.contentType ?? "",
    input.dateOrExpires,
    canonicalizedOssHeaders(input.ossHeaders) + canonicalizedResource(input.bucket, input.key, input.query),
  ].join("\n");
}

/** HMAC-SHA1 + base64，返回签名字符串 */
export async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const cryptoKey = await hmacKeyCache.get(secret);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return arrayBufferToBase64(sig);
}

/** Drop the in-memory imported key when the plugin unloads. */
export function clearHmacKeyCache(): void {
  hmacKeyCache.clear();
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export async function sign(input: SignInput, accessKeySecret: string): Promise<string> {
  const stringToSign = buildStringToSign(input);
  return hmacSha1Base64(accessKeySecret, stringToSign);
}

/** 生成 GetObject 的签名 URL（仅私有 bucket 需要） */
export async function signedGetUrl(params: {
  bucket: string;
  key: string;
  host: string;
  accessKeyId: string;
  accessKeySecret: string;
  expireSeconds: number;
}): Promise<{ url: string; expireAt: number }> {
  const expires = Math.floor(Date.now() / 1000) + params.expireSeconds;
  const sig = await sign(
    {
      method: "GET",
      bucket: params.bucket,
      key: params.key,
      dateOrExpires: String(expires),
    },
    params.accessKeySecret,
  );
  const url =
    `https://${params.host}/${encodeKey(params.key)}` +
    `?OSSAccessKeyId=${encodeURIComponent(params.accessKeyId)}` +
    `&Expires=${expires}` +
    `&Signature=${encodeURIComponent(sig)}`;
  return { url, expireAt: expires * 1000 };
}

/** object key 每段做 percent-encoding，保留 / 分隔符 */
export function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}
