/** Convert Obsidian/Electron's normalized oss:// image URL back to the OSS object key. */
export function ossKeyFromImageSource(source: string): string | null {
  if (!source.startsWith("oss://")) return null;
  const encodedKey = source.slice("oss://".length).replace(/^\/+/, "");
  if (!encodedKey) return null;
  try {
    return decodeURIComponent(encodedKey);
  } catch {
    return encodedKey;
  }
}
