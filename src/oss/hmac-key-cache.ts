export type HmacKeyImporter = (secret: string) => Promise<CryptoKey>;

const encoder = new TextEncoder();

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
}

/**
 * Keeps only the active secret's imported Web Crypto key.
 * Concurrent callers share the same import Promise; failures are never cached.
 */
export class HmacKeyCache {
  private secret: string | null = null;
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(private readonly importer: HmacKeyImporter = importHmacKey) {}

  get(secret: string): Promise<CryptoKey> {
    if (this.secret === secret && this.keyPromise) return this.keyPromise;

    this.secret = secret;
    const keyPromise = Promise.resolve().then(() => this.importer(secret));
    this.keyPromise = keyPromise;
    void keyPromise.catch(() => {
      if (this.keyPromise === keyPromise) this.clear();
    });
    return keyPromise;
  }

  clear(): void {
    this.secret = null;
    this.keyPromise = null;
  }
}
