import { MAX_PRESIGNED_URL_EXPIRES_SECONDS, normalizeSigningRegion } from "./oss/signer";

export const MIN_SIGNED_URL_EXPIRES_SECONDS = 61;

export interface EditableOssConfig {
  region: string;
  bucketName: string;
  accessKeyId: string;
  accessKeySecret: string;
  endpoint: string;
  objectKeyPrefix: string;
  signedUrlExpireSeconds: number;
}

export interface NormalizedOssConfig extends EditableOssConfig {
  /** Always the effective standard OSS endpoint, never an empty fallback marker. */
  endpoint: string;
}

export interface StorageIdentityConfig {
  region: string;
  bucketName: string;
  endpoint: string;
  objectKeyPrefix: string;
}

export type NormalizedStorageIdentity = Readonly<StorageIdentityConfig>;

/** Normalize and validate every field that affects signing or stored Object identity. */
export function normalizeOssConfig(input: EditableOssConfig): NormalizedOssConfig {
  const storage = normalizeStorageIdentity(input);
  return {
    ...storage,
    accessKeyId: requireValue(input.accessKeyId, "AccessKey ID"),
    accessKeySecret: requireValue(input.accessKeySecret, "AccessKey Secret"),
    signedUrlExpireSeconds: normalizeSignedUrlExpiry(input.signedUrlExpireSeconds),
  };
}

export function normalizeStorageIdentity(input: StorageIdentityConfig): NormalizedStorageIdentity {
  const region = normalizeSigningRegion(input.region);
  return {
    region,
    bucketName: normalizeBucketName(input.bucketName),
    endpoint: normalizeOssEndpoint(input.endpoint, region),
    objectKeyPrefix: normalizeObjectKeyPrefix(input.objectKeyPrefix),
  };
}

export function normalizeBucketName(value: string): string {
  const bucket = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("Bucket 名称无效：需为 3–63 位小写字母、数字或连字符，且不能以连字符开头或结尾");
  }
  return bucket;
}

export function normalizeOssEndpoint(value: string, region: string): string {
  const normalizedRegion = normalizeSigningRegion(region);
  const endpoint = value.trim().toLowerCase() || `oss-${normalizedRegion}.aliyuncs.com`;
  const allowed = new Set([
    `oss-${normalizedRegion}.aliyuncs.com`,
    `oss-${normalizedRegion}-internal.aliyuncs.com`,
    `${normalizedRegion}.oss.aliyuncs.com`,
    "oss-accelerate.aliyuncs.com",
    "oss-accelerate-overseas.aliyuncs.com",
  ]);
  if (!allowed.has(endpoint)) {
    throw new Error(
      `Endpoint 无效或与 Region 不匹配：请填写 ${normalizedRegion} 的标准 OSS hostname`,
    );
  }
  return endpoint;
}

export function normalizeObjectKeyPrefix(value: string): string {
  // Spaces are real Object Key bytes. Never trim them: doing so would silently
  // move an existing Vault to another storage namespace during an AK rotation.
  if (/^\/+/.test(value)) {
    throw new Error("Object Key 前缀不能以 / 开头");
  }
  // Released versions already ignored trailing slashes, so this normalization
  // is identity-preserving for both legacy and newly verified configurations.
  const prefix = value.replace(/\/+$/g, "");
  if (!prefix.trim()) throw new Error("Object Key 前缀不能为空");
  if (/[\u0000-\u001f\u007f]/.test(prefix)) {
    throw new Error("Object Key 前缀不能包含控制字符");
  }
  const segments = prefix.split("/");
  if (segments.includes(".") || segments.includes("..")) {
    throw new Error("Object Key 前缀不能包含 . 或 .. 路径段");
  }
  if (segments[0] === "uploading" || segments.includes(".oss-plugin-probe")) {
    throw new Error("Object Key 前缀占用了插件内部命名：请勿使用 uploading 或 .oss-plugin-probe");
  }
  return prefix;
}

export function defaultObjectKeyPrefix(vaultName: string): string {
  const candidate = vaultName.trim() ? vaultName : "obsidian";
  try {
    return normalizeObjectKeyPrefix(candidate);
  } catch {
    return normalizeObjectKeyPrefix(`${candidate}-attachments`);
  }
}

/**
 * Resolve the one legacy namespace ambiguity without trimming real Key bytes.
 * Released builds used `obsidian` whenever a persisted empty/missing prefix was
 * loaded. Only a truly new install (no data.json yet) receives the Vault name.
 */
export function resolveLoadedObjectKeyPrefix(
  hasStoredData: boolean,
  storedPrefix: unknown,
  pendingIdentityPrefixes: readonly string[],
  vaultName: string,
): string {
  if (!hasStoredData) return defaultObjectKeyPrefix(vaultName);
  if (typeof storedPrefix === "string" && storedPrefix !== "") return storedPrefix;
  const known = [...new Set(pendingIdentityPrefixes.filter((prefix) => prefix !== ""))];
  if (known.length === 1) return known[0];
  // An explicitly persisted empty value used the old UploadManager fallback.
  // A missing field predating that setting follows the documented Vault-name default.
  return storedPrefix === "" ? "obsidian" : defaultObjectKeyPrefix(vaultName);
}

export function normalizeSignedUrlExpiry(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_SIGNED_URL_EXPIRES_SECONDS ||
    value > MAX_PRESIGNED_URL_EXPIRES_SECONDS
  ) {
    throw new Error(
      `签名 URL 有效期必须是 ${MIN_SIGNED_URL_EXPIRES_SECONDS}–${MAX_PRESIGNED_URL_EXPIRES_SECONDS} 秒的整数`,
    );
  }
  return value;
}

/** Stable identity used to decide whether an unfinished upload may use current settings. */
export function storageIdentityKey(input: NormalizedStorageIdentity): string {
  return JSON.stringify([
    input.region,
    input.bucketName,
    input.endpoint,
    input.objectKeyPrefix,
  ]);
}

/** Existing storage identity is independent from credentials and URL lease settings. */
export function establishedStorageIdentityKey(input: StorageIdentityConfig): string | null {
  try {
    if (!input.objectKeyPrefix) return null;
    const region = normalizeSigningRegion(input.region);
    // Identity recognition deliberately does not use the stricter new-prefix
    // validator. A legacy reserved/space/leading-slash prefix may still own
    // real objects and must lock the settings even though new uploads are blocked.
    const existingPrefix = input.objectKeyPrefix.replace(/\/+$/g, "");
    return storageIdentityKey({
      region,
      bucketName: normalizeBucketName(input.bucketName),
      endpoint: normalizeOssEndpoint(input.endpoint, region),
      objectKeyPrefix: existingPrefix,
    });
  } catch {
    return null;
  }
}

function requireValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} 不能为空`);
  return normalized;
}
