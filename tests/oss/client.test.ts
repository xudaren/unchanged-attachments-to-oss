import assert from "node:assert/strict";
import test from "node:test";
import { setRequestUrlHandler } from "obsidian";
import { OssClient } from "../../src/oss/client";
import type { PluginSettings } from "../../src/types";

function settings(): PluginSettings {
  return {
    region: "oss-cn-shanghai",
    bucketName: "example-bucket",
    accessKeyId: "test-id",
    accessKeySecret: "test-secret",
    endpoint: "oss-cn-shanghai.aliyuncs.com",
    objectKeyPrefix: "vault",
    signedUrlExpireSeconds: 3600,
    autoUpload: true,
    pendingUploads: {},
  };
}

test("credential verification probes one random key without listing objects", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  setRequestUrlHandler(async (request) => {
    requests.push({ url: String(request.url), method: String(request.method) });
    return {
      status: 404,
      text: "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>",
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      json: {},
    };
  });

  await new OssClient(settings()).verifyCredentials();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
  assert.match(
    requests[0].url,
    /^https:\/\/example-bucket\.oss-cn-shanghai\.aliyuncs\.com\/vault\/\.oss-plugin-probe\/[0-9a-f-]+$/,
  );
  assert.doesNotMatch(requests[0].url, /list-type|max-keys/);
});

test("credential verification rejects a missing bucket instead of accepting every 404", async () => {
  setRequestUrlHandler(async () => ({
    status: 404,
    text: "<Error><Code>NoSuchBucket</Code><Message>missing</Message></Error>",
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    json: {},
  }));

  await assert.rejects(
    () => new OssClient(settings()).verifyCredentials(),
    /OSS 校验失败/,
  );
});

test("object deletion uses the standard bucket host", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  setRequestUrlHandler(async (request) => {
    requests.push({ url: String(request.url), method: String(request.method) });
    return { status: 204, text: "", headers: {}, arrayBuffer: new ArrayBuffer(0), json: {} };
  });

  await new OssClient(settings()).deleteObject("vault/file.pdf");

  assert.deepEqual(requests, [{
    url: "https://example-bucket.oss-cn-shanghai.aliyuncs.com/vault/file.pdf",
    method: "DELETE",
  }]);
});

test("multipart listing uses the standard bucket host", async () => {
  const urls: string[] = [];
  setRequestUrlHandler(async (request) => {
    urls.push(String(request.url));
    return { status: 200, text: "<ListMultipartUploadsResult/>", headers: {}, arrayBuffer: new ArrayBuffer(0), json: {} };
  });

  await new OssClient(settings()).listMultipartUploads();

  assert.deepEqual(urls, [
    "https://example-bucket.oss-cn-shanghai.aliyuncs.com/?uploads",
  ]);
});

test("signed object URLs use the same standard bucket host", () => {
  assert.equal(
    new OssClient(settings()).signedUrlHost,
    "example-bucket.oss-cn-shanghai.aliyuncs.com",
  );
});
