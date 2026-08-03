import assert from "node:assert/strict";
import test from "node:test";
import { setRequestUrlHandler } from "obsidian";
import { OssClient } from "../../src/oss/client";
import type { PluginSettings } from "../../src/types";

function settings(cname = ""): PluginSettings {
  return {
    region: "oss-cn-shanghai",
    bucketName: "example-bucket",
    accessKeyId: "test-id",
    accessKeySecret: "test-secret",
    endpoint: "oss-cn-shanghai.aliyuncs.com",
    cname,
    objectKeyPrefix: "vault",
    signedUrlExpireSeconds: 3600,
    autoUpload: true,
    pendingUploads: {},
  };
}

test("credential verification uses the standard host and a legal max-keys value", async () => {
  const urls: string[] = [];
  setRequestUrlHandler(async (request) => {
    urls.push(String(request.url));
    return { status: 200, text: "", headers: {}, arrayBuffer: new ArrayBuffer(0), json: {} };
  });

  await new OssClient(settings()).verifyCredentials();

  assert.deepEqual(urls, [
    "https://example-bucket.oss-cn-shanghai.aliyuncs.com/?list-type=2&max-keys=1",
  ]);
});

test("credential verification checks the standard host before CNAME", async () => {
  const urls: string[] = [];
  setRequestUrlHandler(async (request) => {
    urls.push(String(request.url));
    return { status: 200, text: "", headers: {}, arrayBuffer: new ArrayBuffer(0), json: {} };
  });

  await new OssClient(settings("cdn.example.com")).verifyCredentials();

  assert.deepEqual(urls, [
    "https://example-bucket.oss-cn-shanghai.aliyuncs.com/?list-type=2&max-keys=1",
    "https://cdn.example.com/?list-type=2&max-keys=1",
  ]);
});

test("CNAME failure reports that standard credentials already passed", async () => {
  let call = 0;
  setRequestUrlHandler(async () => {
    call += 1;
    if (call === 2) throw new Error("net::ERR_CONNECTION_CLOSED");
    return { status: 200, text: "", headers: {}, arrayBuffer: new ArrayBuffer(0), json: {} };
  });

  await assert.rejects(
    () => new OssClient(settings("cdn.example.com")).verifyCredentials(),
    /OSS 凭证有效，但 CNAME 校验失败/,
  );
});
