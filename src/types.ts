/** 插件持久化配置。全部明文存 data.json。 */
export interface PluginSettings {
  region: string;
  bucketName: string;
  accessKeyId: string;
  accessKeySecret: string;
  /** 可选：自定义 endpoint（不填则由 region 拼出 oss-{region}.aliyuncs.com） */
  endpoint: string;
  /** 可选：CNAME 自定义域名。填了则请求与生成的签名 URL host 都用它 */
  cname: string;
  /** 存储路径前缀，默认 vault 名 */
  objectKeyPrefix: string;
  /** 签名 URL 过期秒数 */
  signedUrlExpireSeconds: number;
  /** 自动上传开关，关闭后暂停拦截与补传 */
  autoUpload: boolean;
  /** 未完成 MultipartUpload：{tempId → 状态} */
  pendingUploads: Record<string, PendingUpload>;
}

export interface PendingUpload {
  tempId: string;
  objectKey: string;
  uploadId: string;
  ext: string;
  size: number;
  /** 已成功上传的分片：{partNumber, etag} */
  parts: UploadedPart[];
  /** 关联的 md 文件路径（用于失败回写） */
  sourcePath: string;
  createdAt: number;
  updatedAt: number;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  region: "oss-cn-hangzhou",
  bucketName: "",
  accessKeyId: "",
  accessKeySecret: "",
  endpoint: "",
  cname: "",
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
  svg: "image/svg+xml",
  bmp: "image/bmp",
  // video
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  // audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  // doc
  pdf: "application/pdf",
};

export function isSupportedExt(ext: string): boolean {
  return Object.prototype.hasOwnProperty.call(ATTACHMENT_MIME, ext.toLowerCase());
}

export function mimeOf(ext: string): string {
  return ATTACHMENT_MIME[ext.toLowerCase()] ?? "application/octet-stream";
}

/** md 中占位链接匹配：![](oss://path/to/uuid.ext) */
export const OSS_URL_REGEX = /!\[[^\]]*\]\(oss:\/\/([^)\s]+)\)/g;

/** 单个 key 的匹配，用于替换 */
export function extractOssKey(url: string): string | null {
  const m = url.match(/^oss:\/\/(.+)$/);
  return m ? m[1] : null;
}
