import assert from "node:assert/strict";
import test from "node:test";
import { setRequestUrlHandler } from "obsidian";
import { OssClient, OssError } from "../../src/oss/client";
import type { PluginSettings } from "../../src/types";

const FIXED_NOW = new Date("2025-04-11T06:41:24.000Z");

function settings(): PluginSettings {
  return {
    region: "oss-cn-shanghai",
    bucketName: "example-bucket",
    accessKeyId: "test-id",
    accessKeySecret: "test-secret",
    endpoint: "",
    objectKeyPrefix: "vault",
    signedUrlExpireSeconds: 3600,
    autoUpload: true,
    pendingUploads: {},
  };
}

function client(config = settings()): OssClient {
  return new OssClient(config, undefined, () => FIXED_NOW);
}

function response(status: number, text = "", headers: Record<string, string> = {}) {
  return { status, text, headers, arrayBuffer: new ArrayBuffer(0), json: {} };
}

test("credential verification uses one V4 GetObject probe without listing objects", async () => {
  const requests: any[] = [];
  setRequestUrlHandler(async (request) => {
    requests.push(request);
    return response(404, "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>");
  });

  await client().verifyCredentials();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
  assert.match(
    String(requests[0].url),
    /^https:\/\/example-bucket\.oss-cn-shanghai\.aliyuncs\.com\/vault\/\.oss-plugin-probe\/[0-9a-f-]+$/,
  );
  assert.doesNotMatch(String(requests[0].url), /list-type|max-keys/);
  assert.equal(requests[0].headers["x-oss-date"], "20250411T064124Z");
  assert.equal(requests[0].headers["x-oss-content-sha256"], "UNSIGNED-PAYLOAD");
  assert.match(
    requests[0].headers.Authorization,
    /^OSS4-HMAC-SHA256 Credential=test-id\/20250411\/cn-shanghai\/oss\/aliyun_v4_request,Signature=[0-9a-f]{64}$/,
  );
  assert.doesNotMatch(requests[0].headers.Authorization, /^OSS /);
});

test("credential verification rejects a missing bucket instead of accepting every 404", async () => {
  setRequestUrlHandler(async () => response(
    404,
    "<Error><Code>NoSuchBucket</Code><Message>missing</Message></Error>",
  ));

  await assert.rejects(() => client().verifyCredentials(), /OSS 校验失败/);
});

test("captures an immutable connection snapshot with a canonical region and default endpoint", async () => {
  const config = settings();
  const oss = client(config);
  config.region = "oss-cn-beijing";
  config.bucketName = "mutated-bucket";
  config.accessKeyId = "mutated-id";
  config.accessKeySecret = "mutated-secret";
  const requests: any[] = [];
  setRequestUrlHandler(async (request) => {
    requests.push(request);
    return response(204);
  });

  await oss.deleteObject("vault/file.pdf");

  assert.deepEqual(oss.connectionSnapshot, {
    region: "cn-shanghai",
    bucketName: "example-bucket",
    accessKeyId: "test-id",
    accessKeySecret: "test-secret",
    endpoint: "oss-cn-shanghai.aliyuncs.com",
    objectKeyPrefix: "vault",
  });
  assert.equal(
    requests[0].url,
    "https://example-bucket.oss-cn-shanghai.aliyuncs.com/vault/file.pdf",
  );
  assert.match(requests[0].headers.Authorization, /Credential=test-id\/20250411\/cn-shanghai\//);
});

test("rejects invalid bucket and non-standard endpoint before any request can be signed or sent", () => {
  assert.throws(() => new OssClient({ ...settings(), bucketName: "Bad_Bucket" }), /Bucket/);
  assert.throws(() => new OssClient({ ...settings(), endpoint: "evil.example.com" }), /Endpoint/);
});

test("checks lifecycle immediately before sending every OSS request", async () => {
  let sends = 0;
  const oss = new OssClient(
    settings(),
    async () => {
      sends++;
      return response(204);
    },
    () => FIXED_NOW,
    () => { throw new Error("quiescing"); },
  );

  await assert.rejects(() => oss.deleteObject("vault/file.pdf"), /quiescing/);
  assert.equal(sends, 0);
});

test("checks request-local automatic pause guard after asynchronous signing", async () => {
  let sends = 0;
  let automaticEnabled = true;
  const oss = new OssClient(
    settings(),
    async () => {
      sends++;
      return response(200, "<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>");
    },
    () => FIXED_NOW,
  );

  const request = oss.initiateMultipart("vault/file.pdf", "application/pdf", () => {
    if (!automaticEnabled) throw new Error("automatic upload paused");
  });
  automaticEnabled = false;

  await assert.rejects(request, /automatic upload paused/);
  assert.equal(sends, 0);
});

test("CompleteMultipartUpload returns confirmation metadata and XML-escapes ETags", async () => {
  let captured: any;
  setRequestUrlHandler(async (request) => {
    captured = request;
    return response(
      200,
      "<CompleteMultipartUploadResult><Key>vault/a&amp;b.pdf</Key><ETag>&quot;done&quot;</ETag></CompleteMultipartUploadResult>",
      { "x-oss-request-id": "REQ-COMPLETE" },
    );
  });

  const result = await client().completeMultipart({
    key: "vault/a&b.pdf",
    uploadId: "upload-1",
    parts: [{ partNumber: 1, etag: "\"part&one\"" }],
  });

  assert.deepEqual(result, {
    key: "vault/a&b.pdf",
    etag: "\"done\"",
    requestId: "REQ-COMPLETE",
  });
  assert.match(String(captured.body), /<ETag>&quot;part&amp;one&quot;<\/ETag>/);
  assert.match(captured.headers.Authorization, /^OSS4-HMAC-SHA256 /);
});

test("HeadObject distinguishes an existing object from explicit NoSuchKey", async () => {
  setRequestUrlHandler(async (request) => String(request.url).includes("missing")
    ? response(404, "<Error><Code>NoSuchKey</Code></Error>")
    : response(200, "", { ETag: "\"etag\"" }));

  assert.equal(await client().headObject("vault/present.pdf"), true);
  assert.equal(await client().headObject("vault/missing.pdf"), false);
});

test("HeadObject does not collapse NoSuchBucket into a missing object", async () => {
  setRequestUrlHandler(async () => response(404, "<Error><Code>NoSuchBucket</Code></Error>"));

  await assert.rejects(
    () => client().headObject("vault/file.pdf"),
    (error: unknown) => error instanceof OssError && error.code === "NoSuchBucket",
  );
});

test("HeadObject disambiguates a bodyless HEAD 404 with a one-byte GET", async () => {
  const methods: string[] = [];
  setRequestUrlHandler(async (request) => {
    methods.push(String(request.method));
    if (request.method === "HEAD") return response(404);
    assert.equal(request.headers?.Range, "bytes=0-0");
    return response(404, "<Error><Code>NoSuchKey</Code></Error>");
  });

  assert.equal(await client().headObject("vault/missing.pdf"), false);
  assert.deepEqual(methods, ["HEAD", "GET"]);
});

test("HeadObject keeps a bodyless 404 unsafe when ranged GET says NoSuchBucket", async () => {
  setRequestUrlHandler(async (request) => request.method === "HEAD"
    ? response(404)
    : response(404, "<Error><Code>NoSuchBucket</Code></Error>"));

  await assert.rejects(
    () => client().headObject("vault/file.pdf"),
    (error: unknown) => error instanceof OssError && error.code === "NoSuchBucket",
  );
});

test("DeleteObject exposes a 404 instead of treating it as success", async () => {
  setRequestUrlHandler(async () => response(
    404,
    "<Error><Code>NoSuchKey</Code><RequestId>REQ-DELETE</RequestId></Error>",
  ));

  await assert.rejects(
    () => client().deleteObject("vault/missing.pdf"),
    (error: unknown) =>
      error instanceof OssError &&
      error.status === 404 &&
      error.code === "NoSuchKey" &&
      error.requestId === "REQ-DELETE",
  );
});

test("multipart listing requires a non-empty ownership prefix", async () => {
  let requests = 0;
  setRequestUrlHandler(async () => {
    requests++;
    return response(200, "<ListMultipartUploadsResult/>");
  });

  await assert.rejects(() => client().listMultipartUploads(""), /非空 Object Key 前缀/);
  await assert.rejects(() => client().listMultipartUploads("///"), /非空 Object Key 前缀/);
  await assert.rejects(() => client().listMultipartUploads("/vault/"), /不能以 \/ 开头/);
  assert.equal(requests, 0);
});

test("multipart listing is prefix-scoped, decodes XML/URL keys and follows both markers", async () => {
  const urls: string[] = [];
  setRequestUrlHandler(async (request) => {
    const url = String(request.url);
    urls.push(url);
    const second = url.includes("key-marker=");
    return response(200, second
      ? "<ListMultipartUploadsResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>" +
        "<Upload><Key>vault%2Fb%26c.pdf</Key><UploadId>upload-2</UploadId><Initiated>2026-08-01T00:00:00.000Z</Initiated></Upload>" +
        "</ListMultipartUploadsResult>"
      : "<ListMultipartUploadsResult><EncodingType>url</EncodingType><IsTruncated>true</IsTruncated>" +
        "<NextKeyMarker>vault%2Fa%26b.pdf</NextKeyMarker><NextUploadIdMarker>upload&amp;1</NextUploadIdMarker>" +
        "<Upload><Key>vault%2Fa%26b.pdf</Key><UploadId>upload&amp;1</UploadId><Initiated>2026-08-01T00:00:00.000Z</Initiated></Upload>" +
        "</ListMultipartUploadsResult>");
  });

  const uploads = await client().listMultipartUploads("vault/");

  assert.deepEqual(uploads.map(({ key, uploadId }) => ({ key, uploadId })), [
    { key: "vault/a&b.pdf", uploadId: "upload&1" },
    { key: "vault/b&c.pdf", uploadId: "upload-2" },
  ]);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /prefix=vault%2F/);
  assert.match(urls[0], /(?:\?|&)uploads(?:&|$)/);
  assert.match(urls[1], /key-marker=vault%2Fa%26b\.pdf/);
  assert.match(urls[1], /upload-id-marker=upload%261/);
});

test("multipart listing rejects truncated pages without both continuation markers", async () => {
  setRequestUrlHandler(async () => response(
    200,
    "<ListMultipartUploadsResult><IsTruncated>true</IsTruncated><NextKeyMarker>vault/a</NextKeyMarker></ListMultipartUploadsResult>",
  ));

  await assert.rejects(() => client().listMultipartUploads("vault"), /缺少双 Marker/);
});

test("multipart listing rejects a repeated continuation marker", async () => {
  let requests = 0;
  setRequestUrlHandler(async () => {
    requests++;
    return response(
      200,
      "<ListMultipartUploadsResult><IsTruncated>true</IsTruncated>" +
        "<NextKeyMarker>vault/a</NextKeyMarker><NextUploadIdMarker>upload-1</NextUploadIdMarker>" +
        "</ListMultipartUploadsResult>",
    );
  });

  await assert.rejects(() => client().listMultipartUploads("vault"), /重复 Marker/);
  assert.equal(requests, 2);
});

test("multipart listing rejects a continuation marker cycle", async () => {
  let requests = 0;
  setRequestUrlHandler(async () => {
    requests++;
    const odd = requests % 2 === 1;
    return response(
      200,
      "<ListMultipartUploadsResult><IsTruncated>true</IsTruncated>" +
        `<NextKeyMarker>${odd ? "vault/a" : "vault/b"}</NextKeyMarker>` +
        `<NextUploadIdMarker>${odd ? "upload-a" : "upload-b"}</NextUploadIdMarker>` +
        "</ListMultipartUploadsResult>",
    );
  });

  await assert.rejects(() => client().listMultipartUploads("vault"), /重复 Marker/);
  assert.equal(requests, 3);
});

test("object listing follows ListObjectsV2 continuation tokens", async () => {
  const urls: string[] = [];
  setRequestUrlHandler(async (request) => {
    const url = String(request.url);
    urls.push(url);
    const second = url.includes("continuation-token=");
    return response(200, second
      ? "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>vault/b&amp;c.pdf</Key><LastModified>2026-08-01T00:00:00.000Z</LastModified><Size>20</Size></Contents></ListBucketResult>"
      : "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next/token</NextContinuationToken><Contents><Key>vault/a.pdf</Key><LastModified>2026-08-01T00:00:00.000Z</LastModified><Size>10</Size></Contents></ListBucketResult>");
  });

  const objects = await client().listObjects("vault/");

  assert.deepEqual(objects.map((object) => object.key), ["vault/a.pdf", "vault/b&c.pdf"]);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /list-type=2/);
  assert.match(urls[0], /encoding-type=url/);
  assert.match(urls[0], /prefix=vault%2F/);
  assert.match(urls[1], /continuation-token=next%2Ftoken/);
});

test("object listing rejects a repeated continuation token", async () => {
  let requests = 0;
  setRequestUrlHandler(async () => {
    requests++;
    return response(
      200,
      "<ListBucketResult><IsTruncated>true</IsTruncated>" +
        "<NextContinuationToken>same-token</NextContinuationToken></ListBucketResult>",
    );
  });

  await assert.rejects(() => client().listObjects("vault/"), /重复 ContinuationToken/);
  assert.equal(requests, 2);
});

test("object listing rejects a continuation token cycle", async () => {
  let requests = 0;
  setRequestUrlHandler(async () => {
    requests++;
    return response(
      200,
      "<ListBucketResult><IsTruncated>true</IsTruncated>" +
        `<NextContinuationToken>${requests % 2 === 1 ? "token-a" : "token-b"}</NextContinuationToken>` +
        "</ListBucketResult>",
    );
  });

  await assert.rejects(() => client().listObjects("vault/"), /重复 ContinuationToken/);
  assert.equal(requests, 3);
});

test("object listing fails closed on malformed URL-encoded keys", async () => {
  setRequestUrlHandler(async () => response(
    200,
    "<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>" +
      "<Contents><Key>vault%2Fbad%escape.pdf</Key><LastModified>2026-08-01T00:00:00.000Z</LastModified><Size>1</Size></Contents>" +
      "</ListBucketResult>",
  ));

  await assert.rejects(() => client().listObjects("vault/"), /无效的 URL 编码/);
});

test("listing preserves Object Key edge spaces and URL/XML encoding exactly", async () => {
  setRequestUrlHandler(async (request) => {
    const url = String(request.url);
    if (url.includes("list-type=2")) {
      return response(
        200,
        "<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>" +
          "<Contents><Key>%20vault%2Fa%26b.pdf%20</Key><LastModified>2026-08-01T00:00:00.000Z</LastModified><Size>1</Size></Contents>" +
          "</ListBucketResult>",
      );
    }
    return response(
      200,
      "<ListMultipartUploadsResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>" +
        "<Upload><Key>%20vault%2Fa%26b.pdf%20</Key><UploadId>upload-1</UploadId><Initiated>2026-08-01T00:00:00.000Z</Initiated></Upload>" +
        "</ListMultipartUploadsResult>",
    );
  });

  const [objects, uploads] = await Promise.all([
    client().listObjects(" vault/"),
    client().listMultipartUploads(" vault/"),
  ]);
  assert.equal(objects[0].key, " vault/a&b.pdf ");
  assert.equal(uploads[0].key, " vault/a&b.pdf ");
});

test("signed object URL context exposes the standard host and canonical region", () => {
  const oss = client();
  assert.equal(oss.signedUrlHost, "example-bucket.oss-cn-shanghai.aliyuncs.com");
  assert.equal(oss.signedUrlRegion, "cn-shanghai");
});
