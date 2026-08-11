import { parseOssUrl } from "../reference/codec";

/** Convert Obsidian/Electron's normalized oss:// image URL back to the OSS object key. */
export function ossKeyFromImageSource(source: string): string | null {
  return parseOssUrl(source);
}
