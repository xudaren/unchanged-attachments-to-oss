export const STAGING_DIR = ".oss-plugin-staging";

const MOBILE_IN_MEMORY_LIMIT = 128 * 1024 * 1024;

export interface CapturedAttachment {
  name: string;
  type: string;
  size: number;
  blob: Blob;
}

export function clipboardFiles(event: ClipboardEvent): File[] {
  const data = event.clipboardData;
  const itemFiles = Array.from(data?.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  const listed = Array.from(data?.files ?? []);
  const combined = itemFiles.length > 0 ? [...itemFiles, ...listed] : listed;
  return combined.filter((file, index) => combined.indexOf(file) === index);
}

export function isInternalStagingPath(path: string): boolean {
  return path === STAGING_DIR || path.startsWith(`${STAGING_DIR}/`);
}

export function attachmentExtension(name: string, mime: string): string {
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase();
  const byMime: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/svg+xml": "svg",
    "video/quicktime": "mov",
    "video/x-matroska": "mkv",
    "video/ogg": "ogv",
    "video/x-m4v": "m4v",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/opus": "opus",
  };
  if (byMime[mime.toLowerCase()]) return byMime[mime.toLowerCase()];
  return mime.match(/\/([\w.+-]+)$/)?.[1]?.toLowerCase() ?? "";
}

export function shouldKeepInputLocal(files: File[]): boolean {
  return isMobileUi() && files.reduce((sum, file) => sum + file.size, 0) > MOBILE_IN_MEMORY_LIMIT;
}

export function isOversizedOnMobile(size: number): boolean {
  return isMobileUi() && size > MOBILE_IN_MEMORY_LIMIT;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export async function captureAttachment(file: File): Promise<CapturedAttachment> {
  const bytes = await file.arrayBuffer();
  const blob = new Blob([bytes], { type: file.type });
  return { name: file.name, type: file.type, size: blob.size, blob };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatInputReadError(error: unknown): string {
  const message = errorMessage(error);
  if (
    (error instanceof DOMException && error.name === "NotReadableError") ||
    /requested file could not be read|permission problems.*reference to a file/i.test(message)
  ) {
    return "无法读取附件：文件可能仅存在云盘（如 iCloud、OneDrive 等），请先下载到本地后重试";
  }
  return `无法读取输入附件：${message}`;
}

export function formatInputReadFailureMarker(fileName: string): string {
  const safeName = fileName
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_[\]<>])/g, "\\$1");
  return `⚠ 附件读取失败：${safeName}（请下载到本地后重新粘贴）`;
}

function isMobileUi(): boolean {
  return typeof document !== "undefined" && document.body?.classList.contains("is-mobile") === true;
}
