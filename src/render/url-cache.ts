export interface SignedUrlCacheEntry {
  url: string;
  expireAt: number;
}

/** 签名 URL 缓存：过期前 60 秒视为失效以避免边界抖动 */
export class SignedUrlCache {
  private readonly map = new Map<string, SignedUrlCacheEntry>();
  private readonly maxSize: number;
  private readonly safetyMarginMs = 60 * 1000;

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }

  get(key: string): string | null {
    return this.getEntry(key)?.url ?? null;
  }

  getEntry(key: string): SignedUrlCacheEntry | null {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() + this.safetyMarginMs >= e.expireAt) {
      this.map.delete(key);
      return null;
    }
    // LRU touch
    this.map.delete(key);
    this.map.set(key, e);
    return e;
  }

  set(key: string, url: string, expireAt: number): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { url, expireAt });
  }

  clear(): void {
    this.map.clear();
  }
}
