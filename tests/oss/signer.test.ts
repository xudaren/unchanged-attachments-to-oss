import assert from "node:assert/strict";
import test from "node:test";
import { V4SigningKeyCache } from "../../src/oss/hmac-key-cache";
import {
  buildV4CanonicalRequest,
  canonicalQueryString,
  encodeKey,
  normalizeSigningRegion,
  signV4Request,
  signedGetUrl,
} from "../../src/oss/signer";

// https://help.aliyun.com/en/oss/developer-reference/recommend-to-use-signature-version-4
test("matches the official OSS V4 PutObject canonical vector", async () => {
  const result = await signV4Request({
    method: "PUT",
    bucket: "examplebucket",
    key: "exampleobject",
    region: "cn-hangzhou",
    accessKeyId: "LTAI****************",
    accessKeySecret: "yourAccessKeySecret",
    timestamp: "20250411T064124Z",
    headers: {
      "Content-Disposition": "attachment",
      "Content-Length": "3",
      "Content-MD5": "ICy5YqxZB1uWSwcVLSNLcA==",
      "Content-Type": "text/plain",
    },
    additionalHeaderNames: ["content-disposition", "content-length"],
  });

  assert.equal(result.canonicalRequest, [
    "PUT",
    "/examplebucket/exampleobject",
    "",
    "content-disposition:attachment\n" +
      "content-length:3\n" +
      "content-md5:ICy5YqxZB1uWSwcVLSNLcA==\n" +
      "content-type:text/plain\n" +
      "x-oss-content-sha256:UNSIGNED-PAYLOAD\n" +
      "x-oss-date:20250411T064124Z\n",
    "content-disposition;content-length",
    "UNSIGNED-PAYLOAD",
  ].join("\n"));
  assert.equal(result.stringToSign, [
    "OSS4-HMAC-SHA256",
    "20250411T064124Z",
    "20250411/cn-hangzhou/oss/aliyun_v4_request",
    "c46d96390bdbc2d739ac9363293ae9d710b14e48081fcb22cd8ad54b63136eca",
  ].join("\n"));
  assert.equal(
    result.signature,
    // Independently verified with Node HMAC-SHA256. The documentation publishes
    // a redacted credential signature that cannot be reproduced from its placeholder secret.
    "d3694c2dfc5371ee6acd35e88c4871ac95a7ba01d3a2f476768fe61218590097",
  );
  assert.equal(
    result.authorization,
    "OSS4-HMAC-SHA256 Credential=LTAI****************/20250411/cn-hangzhou/oss/aliyun_v4_request," +
      "AdditionalHeaders=content-disposition;content-length," +
      "Signature=d3694c2dfc5371ee6acd35e88c4871ac95a7ba01d3a2f476768fe61218590097",
  );
});

test("canonicalizes V4 paths, query values and header names", () => {
  assert.equal(
    encodeKey("目录/a b!()*.txt"),
    "%E7%9B%AE%E5%BD%95/a%20b%21%28%29%2A.txt",
  );
  assert.throws(() => encodeKey("vault/.././file.pdf"), /路径段/);
  assert.equal(
    canonicalQueryString({ z: "last", "a b": "space/value", acl: "", "a!": "punctuation" }),
    "a%20b=space%2Fvalue&a%21=punctuation&acl&z=last",
  );
  const built = buildV4CanonicalRequest({
    method: "GET",
    bucket: "examplebucket",
    key: "目录/a b!()*.txt",
    query: { uploads: "", prefix: "目录/" },
    headers: {
      " X-OSS-Meta-Name ": "  kept edges only  ",
      HOST: "examplebucket.oss-cn-hangzhou.aliyuncs.com",
    },
    additionalHeaderNames: ["HOST"],
  });
  assert.match(built.canonicalRequest, /\/examplebucket\/%E7%9B%AE%E5%BD%95\/a%20b%21%28%29%2A\.txt/);
  assert.match(built.canonicalRequest, /prefix=%E7%9B%AE%E5%BD%95%2F&uploads/);
  assert.match(built.canonicalRequest, /host:examplebucket\.oss-cn-hangzhou\.aliyuncs\.com/);
  assert.match(built.canonicalRequest, /x-oss-meta-name:kept edges only/);
  assert.equal(built.additionalHeaders, "host");
});

test("normalizes legacy region input and rejects malformed regions", () => {
  assert.equal(normalizeSigningRegion("oss-cn-hangzhou"), "cn-hangzhou");
  assert.equal(normalizeSigningRegion(" CN-HANGZHOU "), "cn-hangzhou");
  assert.throws(() => normalizeSigningRegion(""), /Region 无效/);
  assert.throws(() => normalizeSigningRegion("https://oss-cn-hangzhou.aliyuncs.com"), /Region 无效/);
});

// https://help.aliyun.com/en/oss/developer-reference/add-signatures-to-urls
test("creates a deterministic V4 presigned GET URL without V1 parameters", async () => {
  const result = await signedGetUrl({
    bucket: "examplebucket",
    key: "exampleobject",
    host: "examplebucket.oss-cn-hangzhou.aliyuncs.com",
    region: "oss-cn-hangzhou",
    accessKeyId: "LTAIEXAMPLE",
    accessKeySecret: "yourAccessKeySecret",
    expireSeconds: 86400,
    now: new Date("2024-12-03T03:23:07.000Z"),
  });

  assert.equal(result.url, "https://examplebucket.oss-cn-hangzhou.aliyuncs.com/exampleobject?" +
    "x-oss-additional-headers=host&" +
    "x-oss-credential=LTAIEXAMPLE%2F20241203%2Fcn-hangzhou%2Foss%2Faliyun_v4_request&" +
    "x-oss-date=20241203T032307Z&" +
    "x-oss-expires=86400&" +
    "x-oss-signature=e6ce8dfe76caa37da0280ae4876a88013b44a26fd9cdded34d6caf31b28b9488&" +
    "x-oss-signature-version=OSS4-HMAC-SHA256");
  assert.equal(result.expireAt, Date.parse("2024-12-04T03:23:07.000Z"));
  assert.doesNotMatch(result.url, /OSSAccessKeyId|[?&]Expires=|[?&]Signature=/);
});

test("rejects V4 presigned URL expiry outside the OSS seven-day limit", async () => {
  const base = {
    bucket: "examplebucket",
    key: "exampleobject",
    host: "examplebucket.oss-cn-hangzhou.aliyuncs.com",
    region: "cn-hangzhou",
    accessKeyId: "id",
    accessKeySecret: "secret",
  };
  await assert.rejects(signedGetUrl({ ...base, expireSeconds: 0 }), /1 到 604800/);
  await assert.rejects(signedGetUrl({ ...base, expireSeconds: 604801 }), /1 到 604800/);
});

test("reuses a derived V4 key for the same secret, date and region", async () => {
  let derivations = 0;
  const cache = new V4SigningKeyCache(async () => {
    derivations++;
    return { sequence: derivations } as unknown as CryptoKey;
  });
  const [first, second] = await Promise.all([
    cache.get("secret", "20250411", "cn-hangzhou"),
    cache.get("secret", "20250411", "cn-hangzhou"),
  ]);
  const third = await cache.get("secret", "20250411", "cn-hangzhou");

  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(derivations, 1);
});

test("derives a new V4 key after date, region or cache changes", async () => {
  let derivations = 0;
  const cache = new V4SigningKeyCache(async () =>
    ({ sequence: ++derivations }) as unknown as CryptoKey);

  const first = await cache.get("secret", "20250411", "cn-hangzhou");
  const second = await cache.get("secret", "20250412", "cn-hangzhou");
  const third = await cache.get("secret", "20250412", "cn-shanghai");
  cache.clear();
  const fourth = await cache.get("secret", "20250412", "cn-shanghai");

  assert.notEqual(first, second);
  assert.notEqual(second, third);
  assert.notEqual(third, fourth);
  assert.equal(derivations, 4);
});

test("does not retain a rejected V4 key derivation", async () => {
  let derivations = 0;
  const cache = new V4SigningKeyCache(async () => {
    if (++derivations === 1) throw new Error("temporary derivation failure");
    return {} as CryptoKey;
  });

  await assert.rejects(cache.get("secret", "20250411", "cn-hangzhou"), /temporary/);
  await cache.get("secret", "20250411", "cn-hangzhou");
  assert.equal(derivations, 2);
});
