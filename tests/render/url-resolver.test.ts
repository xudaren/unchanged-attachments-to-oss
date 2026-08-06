import assert from "node:assert/strict";
import test from "node:test";
import { SignedUrlCache } from "../../src/render/url-cache";
import { SignedUrlResolver } from "../../src/render/url-resolver";

function context(host: string) {
  return {
    bucket: "bucket-a",
    host,
    accessKeyId: "ak",
    accessKeySecret: "sk",
    expireSeconds: 3600,
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
      accessKeyId: "",
      accessKeySecret: "",
      expireSeconds: 3600,
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

test("updating an existing LRU entry does not evict another cached URL", () => {
  const cache = new SignedUrlCache(2);
  const expireAt = Date.now() + 3_600_000;

  cache.set("first", "https://signed/first", expireAt);
  cache.set("second", "https://signed/second", expireAt);
  cache.set("second", "https://signed/second-new", expireAt);

  assert.equal(cache.get("first"), "https://signed/first");
  assert.equal(cache.get("second"), "https://signed/second-new");
});
