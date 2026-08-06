import { signedGetUrl } from "../oss/signer";
import { SignedUrlCache } from "./url-cache";

export interface SignedUrlContext {
  bucket: string;
  host: string;
  accessKeyId: string;
  accessKeySecret: string;
  expireSeconds: number;
}

type SignResult = { url: string; expireAt: number };
type Signer = (input: SignedUrlContext & { key: string }) => Promise<SignResult>;

/** Shared signed-URL lookup with configuration-aware caching and in-flight deduplication. */
export class SignedUrlResolver {
  private readonly pending = new Map<string, Promise<string>>();
  private generation = 0;

  constructor(
    private readonly getContext: () => SignedUrlContext,
    private readonly cache: SignedUrlCache,
    private readonly sign: Signer = signedGetUrl,
  ) {}

  resolve(key: string): Promise<string> {
    const context = this.getContext();
    if (!context.bucket || !context.host || !context.accessKeyId || !context.accessKeySecret) {
      return Promise.reject(new Error("OSS 未配置：请填写 Bucket / AK / SK"));
    }
    const identity = cacheIdentity(context, key);
    const cached = this.cache.get(identity);
    if (cached) return Promise.resolve(cached);

    const active = this.pending.get(identity);
    if (active) return active;

    const generation = this.generation;
    const request = this.sign({ ...context, key })
      .then(
        ({ url, expireAt }) => {
          if (generation !== this.generation) return this.resolve(key);
          this.cache.set(identity, url, expireAt);
          return url;
        },
        (error: unknown) => {
          if (generation !== this.generation) return this.resolve(key);
          throw error;
        },
      )
      .finally(() => {
        if (this.pending.get(identity) === request) this.pending.delete(identity);
      });
    this.pending.set(identity, request);
    return request;
  }

  clear(): void {
    this.generation += 1;
    this.pending.clear();
    this.cache.clear();
  }
}

function cacheIdentity(context: SignedUrlContext, key: string): string {
  return JSON.stringify([context.bucket, context.host, key]);
}
