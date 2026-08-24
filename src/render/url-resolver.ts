import { encodeObjectKey } from "../reference/codec";
import { signedGetUrl } from "../oss/signer";
import { SignedUrlCache } from "./url-cache";

export interface SignedUrlContext {
  bucket: string;
  host: string;
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  expireSeconds: number;
  publicRead: boolean;
}

type SignResult = { url: string; expireAt: number };
type Signer = (input: SignedUrlContext & { key: string }) => Promise<SignResult>;

export interface SignedUrlLease extends SignResult {
  generation: number;
}

export interface LeaseUrlResolver {
  readonly isDisposed?: boolean;
  resolve(key: string): Promise<string>;
  resolveLease?(key: string): Promise<SignedUrlLease>;
  isLeaseCurrent?(lease: SignedUrlLease, safetyMarginMs?: number): boolean;
}

export class SignedUrlResolverDisposedError extends Error {
  constructor() {
    super("OSS 签名服务已停止");
    this.name = "SignedUrlResolverDisposedError";
  }
}

export function isUrlResolverDisposed(resolver: LeaseUrlResolver): boolean {
  return resolver.isDisposed === true;
}

/** Resolve a lease while keeping small test/custom resolvers source-compatible. */
export async function resolveUrlLease(
  resolver: LeaseUrlResolver,
  key: string,
  previous?: SignedUrlLease,
): Promise<SignedUrlLease> {
  if (isUrlResolverDisposed(resolver)) throw new SignedUrlResolverDisposedError();
  if (previous && isUrlLeaseCurrent(resolver, previous)) return previous;
  const lease = resolver.resolveLease
    ? await resolver.resolveLease(key)
    : {
      url: await resolver.resolve(key),
      expireAt: Number.POSITIVE_INFINITY,
      generation: 0,
    };
  if (isUrlResolverDisposed(resolver)) throw new SignedUrlResolverDisposedError();
  return lease;
}

export function isUrlLeaseCurrent(
  resolver: LeaseUrlResolver,
  lease: SignedUrlLease,
  safetyMarginMs = 60_000,
): boolean {
  if (isUrlResolverDisposed(resolver)) return false;
  if (resolver.isLeaseCurrent) return resolver.isLeaseCurrent(lease, safetyMarginMs);
  return Date.now() + safetyMarginMs < lease.expireAt;
}

/** Shared signed-URL lookup with configuration-aware caching and in-flight deduplication. */
export class SignedUrlResolver {
  private readonly pending = new Map<string, Promise<SignedUrlLease>>();
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly getContext: () => SignedUrlContext,
    private readonly cache: SignedUrlCache,
    private readonly sign: Signer = signedGetUrl,
  ) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  resolve(key: string): Promise<string> {
    return this.resolveLease(key).then((lease) => lease.url);
  }

  resolveLease(key: string): Promise<SignedUrlLease> {
    if (this.disposed) return Promise.reject(new SignedUrlResolverDisposedError());
    const context = this.getContext();
    if (!context.bucket || !context.host) {
      return Promise.reject(new Error("OSS 未配置：请填写 Bucket / AK / SK"));
    }
    // Public-read rendering never signs: the durable public URL is valid
    // forever, needs no AK/SK and stays usable while credentials are locked.
    if (!context.publicRead && (!context.region || !context.accessKeyId || !context.accessKeySecret)) {
      return Promise.reject(new Error("OSS 未配置：请填写 Bucket / AK / SK"));
    }
    const identity = cacheIdentity(context, key);
    const cached = this.cache.getEntry(identity);
    if (cached) return Promise.resolve({ ...cached, generation: this.generation });

    if (context.publicRead) {
      const url = `https://${context.host}/${encodeObjectKey(key)}`;
      const expireAt = Number.POSITIVE_INFINITY;
      this.cache.set(identity, url, expireAt);
      return Promise.resolve({ url, expireAt, generation: this.generation });
    }

    const active = this.pending.get(identity);
    if (active) return active;

    const generation = this.generation;
    const request = this.sign({ ...context, key })
      .then(
        ({ url, expireAt }) => {
          if (this.disposed) throw new SignedUrlResolverDisposedError();
          if (generation !== this.generation) return this.resolveLease(key);
          this.cache.set(identity, url, expireAt);
          return { url, expireAt, generation };
        },
        (error: unknown) => {
          if (this.disposed) throw new SignedUrlResolverDisposedError();
          if (generation !== this.generation) return this.resolveLease(key);
          throw error;
        },
      )
      .finally(() => {
        if (this.pending.get(identity) === request) this.pending.delete(identity);
      });
    this.pending.set(identity, request);
    return request;
  }

  isLeaseCurrent(lease: SignedUrlLease, safetyMarginMs = 60_000): boolean {
    return !this.disposed &&
      lease.generation === this.generation &&
      Date.now() + safetyMarginMs < lease.expireAt;
  }

  /** Configuration switch: invalidate leases while keeping this resolver usable. */
  clear(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.pending.clear();
    this.cache.clear();
  }

  /** Plugin unload: permanently reject old and future consumers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.pending.clear();
    this.cache.clear();
  }
}

function cacheIdentity(context: SignedUrlContext, key: string): string {
  return JSON.stringify([context.bucket, context.host, key, context.publicRead]);
}
