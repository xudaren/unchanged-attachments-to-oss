import assert from "node:assert/strict";
import test from "node:test";
import { SignedUrlCache } from "../../src/render/url-cache";
import { SignedUrlResolver } from "../../src/render/url-resolver";

function context(host: string, overrides: Partial<ReturnType<typeof baseContext>> = {}) {
  return { ...baseContext(host), ...overrides };
}

function baseContext(host: string) {
  return {
    bucket: "bucket-a",
    host,
    region: "cn-shanghai",
    accessKeyId: "ak",
    accessKeySecret: "sk",
    expireSeconds: 3600,
    publicRead: false,
  };
}

test("deduplicates concurrent signing for the same bucket, host and key", async () => {
  let calls = 0;
  const resolver = new SignedUrlResolver(
    () => context("bucket-a.oss-cn-shanghai.aliyuncs.com"),
    new SignedUrlCache(),
    async () => {
      calls += 1;
      await Promise.resolve();
      return { url: "https://signed/a.jpg", expireAt: Date.now() + 3_600_000 };
    },
  );

  const [first, second] = await Promise.all([
    resolver.resolve("vault/a.jpg"),
    resolver.resolve("vault/a.jpg"),
  ]);

  assert.equal(calls, 1);
  assert.equal(first, second);
});

test("leases expose expiry and generation and become stale after clear", async () => {
  const expireAt = Date.now() + 3_600_000;
  const resolver = new SignedUrlResolver(
    () => context("bucket-a.oss-cn-shanghai.aliyuncs.com"),
    new SignedUrlCache(),
    async () => ({ url: "https://signed/a.jpg", expireAt }),
  );

  const first = await resolver.resolveLease("vault/a.jpg");
  assert.deepEqual(first, { url: "https://signed/a.jpg", expireAt, generation: 0 });
  assert.equal(resolver.isLeaseCurrent(first), true);

  resolver.clear();
  assert.equal(resolver.isLeaseCurrent(first), false);
  const second = await resolver.resolveLease("vault/a.jpg");
  assert.equal(second.generation, 1);
});

test("does not reuse a cached URL after the signed host changes", async () => {
  let host = "old.example.com";
  let calls = 0;
  const resolver = new SignedUrlResolver(
    () => context(host),
    new SignedUrlCache(),
    async (input) => {
      calls += 1;
      return { url: `https://${input.host}/a.jpg`, expireAt: Date.now() + 3_600_000 };
    },
  );

  assert.equal(await resolver.resolve("vault/a.jpg"), "https://old.example.com/a.jpg");
  host = "new.example.com";
  assert.equal(await resolver.resolve("vault/a.jpg"), "https://new.example.com/a.jpg");
  assert.equal(calls, 2);
});

test("clear redirects older in-flight consumers to the current generation", async () => {
  let releaseOld!: (value: { url: string; expireAt: number }) => void;
  let calls = 0;
  const resolver = new SignedUrlResolver(
    () => context("bucket-a.oss-cn-shanghai.aliyuncs.com"),
    new SignedUrlCache(),
    async () => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => { releaseOld = resolve; });
      }
      return { url: "https://signed/new.jpg", expireAt: Date.now() + 3_600_000 };
    },
  );

  const oldRequest = resolver.resolve("vault/a.jpg");
  resolver.clear();
  assert.equal(await resolver.resolve("vault/a.jpg"), "https://signed/new.jpg");
  releaseOld({ url: "https://signed/old.jpg", expireAt: Date.now() + 3_600_000 });
  assert.equal(await oldRequest, "https://signed/new.jpg");
  assert.equal(await resolver.resolve("vault/a.jpg"), "https://signed/new.jpg");
  assert.equal(calls, 2);
});

test("rejects incomplete AK/SK configuration before invoking the signer", async () => {
  let calls = 0;
  const resolver = new SignedUrlResolver(
    () => ({
      bucket: "",
      host: "",
      region: "",
      accessKeyId: "",
      accessKeySecret: "",
      expireSeconds: 3600,
      publicRead: false,
    }),
    new SignedUrlCache(),
    async () => {
      calls += 1;
      return { url: "https://invalid", expireAt: Date.now() + 3_600_000 };
    },
  );

  await assert.rejects(resolver.resolve("vault/a.jpg"), /OSS 未配置/);
  assert.equal(calls, 0);
});

test("clear redirects an older failed signature to the current generation", async () => {
  let rejectOld!: (error: Error) => void;
  let host = "old.example.com";
  let calls = 0;
  const resolver = new SignedUrlResolver(
    () => context(host),
    new SignedUrlCache(),
    async (input) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_resolve, reject) => { rejectOld = reject; });
      }
      return { url: `https://${input.host}/a.jpg`, expireAt: Date.now() + 3_600_000 };
    },
  );

  const oldRequest = resolver.resolve("vault/a.jpg");
  host = "new.example.com";
  resolver.clear();
  rejectOld(new Error("old endpoint failed"));

  assert.equal(await oldRequest, "https://new.example.com/a.jpg");
  assert.equal(calls, 2);
});

test("dispose permanently rejects in-flight and future signing without restarting it", async () => {
  let release!: (value: { url: string; expireAt: number }) => void;
  let calls = 0;
  const resolver = new SignedUrlResolver(
    () => context("bucket-a.oss-cn-shanghai.aliyuncs.com"),
    new SignedUrlCache(),
    async () => {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  );

  const inFlight = resolver.resolve("vault/a.jpg");
  resolver.dispose();
  release({ url: "https://stale.example/a.jpg", expireAt: Date.now() + 3_600_000 });

  await assert.rejects(inFlight, { name: "SignedUrlResolverDisposedError" });
  await assert.rejects(resolver.resolve("vault/a.jpg"), { name: "SignedUrlResolverDisposedError" });
  assert.equal(calls, 1);
});

test("updating an existing LRU entry does not evict another cached URL", () => {
  const cache = new SignedUrlCache(2);
  const expireAt = Date.now() + 3_600_000;

  cache.set("first", "https://signed/first", expireAt);
  cache.set("second", "https://signed/second", expireAt);
  cache.set("second", "https://signed/second-new", expireAt);

  assert.equal(cache.get("first"), "https://signed/first");
  assert.equal(cache.get("second"), "https://signed/second-new");
});

test("public read resolves the unsigned public URL without AK/SK and without signing", async () => {
  let signCalls = 0;
  const resolver = new SignedUrlResolver(
    () => context("bucket-a.oss-cn-shanghai.aliyuncs.com", {
      publicRead: true,
      accessKeyId: "",
      accessKeySecret: "",
    }),
    new SignedUrlCache(),
    async () => {
      signCalls += 1;
      return { url: "https://signed/a.jpg", expireAt: Date.now() + 3_600_000 };
    },
  );

  const lease = await resolver.resolveLease("vault/报告 a.jpg");
  assert.equal(lease.url, "https://bucket-a.oss-cn-shanghai.aliyuncs.com/vault/%E6%8A%A5%E5%91%8A%20a.jpg");
  assert.equal(lease.expireAt, Number.POSITIVE_INFINITY);
  assert.equal(resolver.isLeaseCurrent(lease), true);
  assert.equal(signCalls, 0);
});

test("public read cache entries are distinct from signed entries for the same key", async () => {
  let publicRead = false;
  let signCalls = 0;
  const resolver = new SignedUrlResolver(
    () => context("bucket-a.oss-cn-shanghai.aliyuncs.com", { publicRead }),
    new SignedUrlCache(),
    async () => {
      signCalls += 1;
      return { url: "https://signed/a.jpg", expireAt: Date.now() + 3_600_000 };
    },
  );

  assert.equal(await resolver.resolve("vault/a.jpg"), "https://signed/a.jpg");
  // Flip the toggle without clear(): the cache key must keep the two forms apart.
  publicRead = true;
  assert.equal(
    await resolver.resolve("vault/a.jpg"),
    "https://bucket-a.oss-cn-shanghai.aliyuncs.com/vault/a.jpg",
  );
  assert.equal(signCalls, 1);
});

test("public read still rejects an incomplete storage identity", async () => {
  const resolver = new SignedUrlResolver(
    () => context("", { publicRead: true, bucket: "" }),
    new SignedUrlCache(),
    async () => ({ url: "https://invalid", expireAt: Date.now() + 3_600_000 }),
  );

  await assert.rejects(resolver.resolve("vault/a.jpg"), /OSS 未配置/);
});
