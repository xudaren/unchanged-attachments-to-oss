import assert from "node:assert/strict";
import test from "node:test";
import {
  CredentialVerificationError,
  formatCredentialError,
  formatCredentialNotice,
  parseOssErrorXml,
} from "../../src/oss/errors";

test("parses actionable OSS error fields", () => {
  const details = parseOssErrorXml(400, `<?xml version="1.0"?>
    <Error><Code>InvalidArgument</Code><Message>max-keys must be positive</Message>
    <RequestId>REQ123</RequestId><ArgumentName>max-keys</ArgumentName><ArgumentValue>0</ArgumentValue></Error>`);

  assert.deepEqual(details, {
    status: 400,
    code: "InvalidArgument",
    message: "max-keys must be positive",
    requestId: "REQ123",
    argumentName: "max-keys",
    argumentValue: "0",
  });
});

test("formats OSS error codes as actionable credential messages", () => {
  const cases = [
    ["InvalidAccessKeyId", "AccessKey ID 不存在或已禁用"],
    ["SignatureDoesNotMatch", "AccessKey Secret、Region 或签名配置不匹配"],
    ["AccessDenied", "缺少探针 Key 的 oss:GetObject 权限"],
    ["NoSuchBucket", "Bucket 不存在，或 Bucket 与 Region/Endpoint 不匹配"],
  ] as const;

  for (const [code, expected] of cases) {
    const error = { status: 403, code, message: "server detail", requestId: "REQ456" };
    assert.match(formatCredentialError(error, "bucket.example.com"), new RegExp(expected));
    assert.match(formatCredentialError(error, "bucket.example.com"), /REQ456/);
  }
});

test("formats invalid arguments with the rejected name and value", () => {
  const error = {
    status: 400,
    code: "InvalidArgument",
    message: "invalid value",
    requestId: "REQ789",
    argumentName: "max-keys",
    argumentValue: "0",
  };
  assert.match(formatCredentialError(error, "bucket.example.com"), /请求参数错误.*max-keys=0/);
});

test("classifies connection, DNS, timeout and TLS errors", () => {
  const cases = [
    ["net::ERR_CONNECTION_CLOSED", "连接被关闭"],
    ["getaddrinfo ENOTFOUND bad.example.com", "域名无法解析"],
    ["request timed out", "连接超时"],
    ["certificate has expired", "HTTPS 证书或 TLS 校验失败"],
  ] as const;

  for (const [message, expected] of cases) {
    const formatted = formatCredentialError(new Error(message), "bad.example.com");
    assert.match(formatted, new RegExp(expected));
    assert.match(formatted, /bad\.example\.com/);
  }
});

test("does not include unrelated secret text", () => {
  const formatted = formatCredentialError(new Error("net::ERR_CONNECTION_CLOSED secret-value"), "safe.example.com");
  assert.doesNotMatch(formatted, /secret-value/);
});

test("formats the final unsaved OSS notice", () => {
  const ossError = new CredentialVerificationError(
    "oss",
    "bucket.oss-cn-shanghai.aliyuncs.com",
    { status: 403, code: "AccessDenied", message: "denied", requestId: "REQ-OSS" },
  );
  assert.match(formatCredentialNotice(ossError), /^凭证校验失败，未保存：OSS 校验失败/);
});
