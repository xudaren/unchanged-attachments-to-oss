const encoder = new TextEncoder();

export type V4SigningKeyDeriver = (
  secret: string,
  date: string,
  region: string,
) => Promise<CryptoKey>;

async function hmacSha256(key: Uint8Array, message: string): Promise<Uint8Array> {
  const rawKey = Uint8Array.from(key).buffer;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)),
  );
}

/** Derive the OSS Signature V4 key for one UTC date and signing region. */
async function deriveV4SigningKey(
  secret: string,
  date: string,
  region: string,
): Promise<CryptoKey> {
  const dateKey = await hmacSha256(encoder.encode(`aliyun_v4${secret}`), date);
  const regionKey = await hmacSha256(dateKey, region);
  const serviceKey = await hmacSha256(regionKey, "oss");
  const signingKey = await hmacSha256(serviceKey, "aliyun_v4_request");
  const rawSigningKey = Uint8Array.from(signingKey).buffer;
  return crypto.subtle.importKey(
    "raw",
    rawSigningKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * Reuses the active V4 derived key. Concurrent callers share one derivation;
 * failures are never cached. A date or region change derives a fresh key.
 */
export class V4SigningKeyCache {
  private secret: string | null = null;
  private date: string | null = null;
  private region: string | null = null;
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(private readonly deriver: V4SigningKeyDeriver = deriveV4SigningKey) {}

  get(secret: string, date: string, region: string): Promise<CryptoKey> {
    if (
      this.secret === secret &&
      this.date === date &&
      this.region === region &&
      this.keyPromise
    ) {
      return this.keyPromise;
    }

    this.secret = secret;
    this.date = date;
    this.region = region;
    const keyPromise = Promise.resolve().then(() => this.deriver(secret, date, region));
    this.keyPromise = keyPromise;
    void keyPromise.catch(() => {
      if (this.keyPromise === keyPromise) this.clear();
    });
    return keyPromise;
  }

  clear(): void {
    this.secret = null;
    this.date = null;
    this.region = null;
    this.keyPromise = null;
  }
}
