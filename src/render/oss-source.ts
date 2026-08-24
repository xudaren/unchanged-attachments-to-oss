import { parseOssReferenceUrl } from "../reference/codec";

/** Convert Obsidian/Electron's normalized oss:// image URL or an unsigned public URL back to the OSS object key. */
export function ossKeyFromImageSource(source: string): string | null {
  return parseOssReferenceUrl(source);
}
