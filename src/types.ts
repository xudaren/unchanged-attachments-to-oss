import type { EncryptedCredentials } from "./credentials";

/** 插件运行时配置；saveSettings 会剔除 AK/SK 明文后再持久化。 */
export interface PluginSettings {
  region: string;
  bucketName: string;
  accessKeyId: string;
  accessKeySecret: string;
  /** Vault 中唯一允许持久化的凭证形态。AK/SK 明文仅驻留运行时内存。 */
  encryptedCredentials?: EncryptedCredentials;
  /** 可选：自定义 endpoint（不填则由 region 拼出 oss-{region}.aliyuncs.com） */
  endpoint: string;
  /** 存储路径前缀，默认 vault 名 */
  objectKeyPrefix: string;
  /** 签名 URL 过期秒数 */
  signedUrlExpireSeconds: number;
  /** 自动上传开关，关闭后暂停拦截与补传 */
  autoUpload: boolean;
  /** 未完成 MultipartUpload：{tempId → 状态} */
  pendingUploads: Record<string, PendingUpload>;
}

export type UploadPhase =
  | "staged"
  | "uploading"
  | "completing"
  | "uploaded"
  | "reference_committing"
  | "cleanup_pending";

/** Storage target captured when a task is created. Access keys may rotate independently. */
export interface StorageIdentity {
  region: string;
  bucketName: string;
  endpoint: string;
  objectKeyPrefix: string;
}

export interface PendingReferenceLocator {
  kind: "placeholder" | "attachment";
  sourcePath: string;
  /** Exact source token captured while planning. */
  original: string;
  start: number;
  end: number;
  alt: string;
  before: string;
  after: string;
}

export interface PendingUpload {
  tempId: string;
  objectKey: string;
  /** Empty while a durably staged task has not initiated MultipartUpload yet. */
  uploadId: string;
  ext: string;
  size: number;
  /** 已成功上传的分片：{partNumber, etag} */
  parts: UploadedPart[];
  /** Durable upload/reference/cleanup state. Missing means legacy `uploading`. */
  phase?: UploadPhase;
  /** 关联的 md 文件路径（用于失败回写） */
  sourcePath: string;
  /** 同一本地附件的引用实例标识；每个实例独占 Object Key */
  occurrenceId?: string;
  /** 已落地附件路径；用于插件重启后的安全续传 */
  localPath?: string;
  /** Direct-input durable copy under `.oss-plugin-staging/`. */
  stagingPath?: string;
  /** Original semantic file name used when committing Markdown. */
  displayName?: string;
  /** Exact placeholder or resolved local-attachment occurrence to commit. */
  locator?: PendingReferenceLocator;
  /** Bucket/Endpoint/Region/prefix identity this UploadId belongs to. */
  storageIdentity?: StorageIdentity;
  /** Source mtime captured for local attachment identity validation. */
  sourceMtime?: number;
  createdAt: number;
  updatedAt: number;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  region: "cn-hangzhou",
  bucketName: "",
  accessKeyId: "",
  accessKeySecret: "",
  endpoint: "",
  objectKeyPrefix: "",
  signedUrlExpireSeconds: 3600,
  autoUpload: true,
  pendingUploads: {},
};

/** 支持的附件扩展名白名单 → mime */
export const ATTACHMENT_MIME: Record<string, string> = {
  // image
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  // video
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  ogv: "video/ogg",
  m4v: "video/x-m4v",
  // audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/ogg",
  // doc
  pdf: "application/pdf",
};

export function isSupportedExt(ext: string): boolean {
  return Object.prototype.hasOwnProperty.call(ATTACHMENT_MIME, ext.toLowerCase());
}

export function mimeOf(ext: string): string {
  return ATTACHMENT_MIME[ext.toLowerCase()] ?? "application/octet-stream";
}
