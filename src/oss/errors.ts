export interface OssErrorDetails {
  status: number;
  code: string;
  message: string;
  requestId: string;
  argumentName: string;
  argumentValue: string;
}

export type CredentialVerificationStage = "oss";

export class CredentialVerificationError extends Error {
  constructor(
    public readonly stage: CredentialVerificationStage,
    public readonly host: string,
    public readonly cause: unknown,
  ) {
    super(`OSS 校验失败（${host}）`);
    this.name = "CredentialVerificationError";
  }
}

export class OssError extends Error {
  readonly code: string;
  /** Message returned inside the OSS XML body; Error.message stays actionable. */
  readonly ossMessage: string;
  readonly requestId: string;
  readonly argumentName: string;
  readonly argumentValue: string;

  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly method: string,
    public readonly key: string,
  ) {
    const details = parseOssErrorXml(status, body);
    super(`OSS ${method} /${key} → ${status}: ${details.code || details.message || "未知错误"}`);
    this.name = "OssError";
    this.code = details.code;
    this.ossMessage = details.message;
    this.requestId = details.requestId;
    this.argumentName = details.argumentName;
    this.argumentValue = details.argumentValue;
  }
}

export function parseOssErrorXml(status: number, body: string): OssErrorDetails {
  return {
    status,
    code: extractXmlTag(body, "Code"),
    message: extractXmlTag(body, "Message"),
    requestId: extractXmlTag(body, "RequestId"),
    argumentName: extractXmlTag(body, "ArgumentName"),
    argumentValue: extractXmlTag(body, "ArgumentValue"),
  };
}

export function formatCredentialError(error: unknown, fallbackHost = "OSS"): string {
  const verification = isVerificationError(error) ? error : null;
  const cause = verification?.cause ?? error;
  const host = verification?.host ?? fallbackHost;
  const prefix = "OSS 校验失败";

  const details = asOssErrorDetails(cause);
  if (details) {
    const reason = formatOssReason(details);
    const requestId = details.requestId ? `；RequestId: ${details.requestId}` : "";
    return `${prefix}（${host}）：${reason}${requestId}`;
  }

  const rawMessage = cause instanceof Error ? cause.message : String(cause ?? "");
  const networkReason = classifyNetworkError(rawMessage);
  if (networkReason) return `${prefix}（${host}）：${networkReason}`;

  return `${prefix}（${host}）：未知错误，请打开开发者控制台查看详情`;
}

export function formatCredentialNotice(error: unknown): string {
  return `凭证校验失败，未保存：${formatCredentialError(error)}`;
}

function formatOssReason(details: OssErrorDetails): string {
  switch (details.code) {
    case "InvalidAccessKeyId":
      return "AccessKey ID 不存在或已禁用";
    case "SignatureDoesNotMatch":
      return "AccessKey Secret、Region 或签名配置不匹配";
    case "AccessDenied":
      return "凭证有效，但缺少探针 Key 的 oss:GetObject 权限";
    case "NoSuchBucket":
      return "Bucket 不存在，或 Bucket 与 Region/Endpoint 不匹配";
    case "PublicEndpointForbidden":
      return "阿里云已阻止当前账号通过中国内地 Bucket 的默认公网 Endpoint 调用数据 API；请在首次配置时改用非中国内地 Region（已有引用请勿直接切换存储身份）";
    case "InvalidArgument": {
      const argument = details.argumentName
        ? `（${details.argumentName}${details.argumentValue ? `=${details.argumentValue}` : ""}）`
        : "";
      return `请求参数错误${argument}${details.message ? `：${details.message}` : ""}`;
    }
    default:
      return `OSS 返回 HTTP ${details.status}${details.code ? ` / ${details.code}` : ""}${details.message ? `：${details.message}` : ""}`;
  }
}

function classifyNetworkError(message: string): string | null {
  if (/ERR_CONNECTION_CLOSED|ECONNRESET|socket hang up/i.test(message)) {
    return "连接被关闭，请检查网络、代理、域名绑定和 HTTPS 配置";
  }
  if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED|could not resolve|dns/i.test(message)) {
    return "域名无法解析，请检查 DNS 或 Endpoint";
  }
  if (/timed?\s*out|ETIMEDOUT|ERR_CONNECTION_TIMED_OUT/i.test(message)) {
    return "连接超时，请检查网络、防火墙或 Endpoint";
  }
  if (/certificate|CERT_|SSL|TLS|ERR_SSL/i.test(message)) {
    return "HTTPS 证书或 TLS 校验失败，请检查证书有效期和域名匹配";
  }
  return null;
}

function isVerificationError(error: unknown): error is CredentialVerificationError {
  return error instanceof CredentialVerificationError;
}

function asOssErrorDetails(error: unknown): OssErrorDetails | null {
  if (error instanceof OssError) {
    return {
      status: error.status,
      code: error.code,
      message: error.ossMessage,
      requestId: error.requestId,
      argumentName: error.argumentName,
      argumentValue: error.argumentValue,
    };
  }
  if (!error || typeof error !== "object") return null;
  const value = error as Partial<OssErrorDetails>;
  if (typeof value.status !== "number" || typeof value.code !== "string") return null;
  return {
    status: value.status,
    code: value.code,
    message: typeof value.message === "string" ? value.message : "",
    requestId: typeof value.requestId === "string" ? value.requestId : "",
    argumentName: typeof value.argumentName === "string" ? value.argumentName : "",
    argumentValue: typeof value.argumentValue === "string" ? value.argumentValue : "",
  };
}

function extractXmlTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : "";
}
