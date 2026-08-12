import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultObjectKeyPrefix,
  resolveLoadedObjectKeyPrefix,
  establishedStorageIdentityKey,
  normalizeBucketName,
  normalizeObjectKeyPrefix,
  normalizeOssConfig,
  normalizeOssEndpoint,
  normalizeSignedUrlExpiry,
  storageIdentityKey,
} from "../src/config";

test("normalizes a legacy Region and resolves the standard Endpoint", () => {
  const config = normalizeOssConfig({
    region: " OSS-CN-HANGZHOU ",
    bucketName: "my-bucket",
    accessKeyId: " ak ",
    accessKeySecret: " secret ",
    endpoint: "",
    objectKeyPrefix: "My Vault/",
    signedUrlExpireSeconds: 3600,
  });
  assert.deepEqual(config, {
    region: "cn-hangzhou",
    bucketName: "my-bucket",
    accessKeyId: "ak",
    accessKeySecret: "secret",
    endpoint: "oss-cn-hangzhou.aliyuncs.com",
    objectKeyPrefix: "My Vault",
    signedUrlExpireSeconds: 3600,
  });
});

test("loaded prefix preserves legacy effective namespace without trimming real bytes", () => {
  assert.equal(resolveLoadedObjectKeyPrefix(false, undefined, [], "My Vault"), "My Vault");
  assert.equal(resolveLoadedObjectKeyPrefix(true, "", [], "My Vault"), "obsidian");
  assert.equal(resolveLoadedObjectKeyPrefix(true, undefined, [], "My Vault"), "My Vault");
  assert.equal(resolveLoadedObjectKeyPrefix(true, undefined, ["legacy/task"], "My Vault"), "legacy/task");
  assert.equal(resolveLoadedObjectKeyPrefix(true, "  real prefix  ", [], "My Vault"), "  real prefix  ");
});

test("rejects invalid storage identity and expiry values before persistence", () => {
  assert.throws(() => normalizeBucketName("Bad_Bucket"), /Bucket/);
  assert.throws(() => normalizeOssEndpoint("https://oss-cn-hangzhou.aliyuncs.com", "cn-hangzhou"), /Endpoint/);
  assert.throws(() => normalizeOssEndpoint("example.com", "cn-hangzhou"), /Endpoint/);
  assert.throws(() => normalizeOssEndpoint("ecs.aliyuncs.com", "cn-hangzhou"), /Endpoint/);
  assert.throws(() => normalizeOssEndpoint("oss-cn-beijing.aliyuncs.com", "cn-hangzhou"), /Region/);
  assert.equal(
    normalizeOssEndpoint("oss-cn-hangzhou-internal.aliyuncs.com", "cn-hangzhou"),
    "oss-cn-hangzhou-internal.aliyuncs.com",
  );
  assert.equal(
    normalizeOssEndpoint("cn-hangzhou.oss.aliyuncs.com", "cn-hangzhou"),
    "cn-hangzhou.oss.aliyuncs.com",
  );
  assert.equal(normalizeOssEndpoint("oss-accelerate.aliyuncs.com", "cn-hangzhou"), "oss-accelerate.aliyuncs.com");
  assert.throws(() => normalizeObjectKeyPrefix("   "), /不能为空/);
  assert.throws(() => normalizeObjectKeyPrefix("/vault"), /不能以 \/ 开头/);
  assert.throws(() => normalizeObjectKeyPrefix("vault/../archive"), /路径段/);
  assert.throws(() => normalizeObjectKeyPrefix("uploading/archive"), /内部命名/);
  assert.throws(() => normalizeObjectKeyPrefix("vault/.oss-plugin-probe/archive"), /内部命名/);
  assert.throws(() => normalizeObjectKeyPrefix("vault\u0000archive"), /控制字符/);
  assert.throws(() => normalizeObjectKeyPrefix("vault\u001farchive"), /控制字符/);
  assert.throws(() => normalizeObjectKeyPrefix("vault\u007farchive"), /控制字符/);
  assert.throws(() => normalizeSignedUrlExpiry(60), /61/);
  assert.throws(() => normalizeSignedUrlExpiry(604801), /604800/);
  assert.equal(defaultObjectKeyPrefix("uploading"), "uploading-attachments");
});

test("storage identity excludes credentials and is deterministic", () => {
  const identity = {
    region: "cn-hangzhou",
    bucketName: "my-bucket",
    endpoint: "oss-cn-hangzhou.aliyuncs.com",
    objectKeyPrefix: "My Vault",
  };
  assert.equal(storageIdentityKey(identity), storageIdentityKey({ ...identity }));
  assert.equal(establishedStorageIdentityKey(identity), storageIdentityKey(identity));
  assert.equal(establishedStorageIdentityKey({ ...identity, bucketName: "" }), null);
});

test("preserves meaningful prefix spaces and detects legacy namespace changes", () => {
  assert.equal(normalizeObjectKeyPrefix(" / My Vault / "), " / My Vault / ");

  const identity = {
    region: "cn-hangzhou",
    bucketName: "my-bucket",
    endpoint: "oss-cn-hangzhou.aliyuncs.com",
    objectKeyPrefix: " My Vault ",
  };
  assert.equal(
    establishedStorageIdentityKey(identity),
    storageIdentityKey({ ...identity }),
  );

  const legacyLeadingSlash = { ...identity, objectKeyPrefix: "/My Vault/" };
  assert.notEqual(
    establishedStorageIdentityKey(legacyLeadingSlash),
    storageIdentityKey({ ...identity, objectKeyPrefix: "My Vault" }),
  );
  assert.notEqual(
    establishedStorageIdentityKey({ ...identity, objectKeyPrefix: "uploading" }),
    null,
  );
  assert.notEqual(
    establishedStorageIdentityKey({ ...identity, objectKeyPrefix: "   " }),
    null,
  );
});
