> 本文是配置功能的下钻文档；全局约束仍以 [`CLAUDE.md`](../CLAUDE.md) 为准。

# 是什么

提供 OSS 连接、存储位置、签名有效期和自动上传状态的配置与保存入口。

# 为什么

在首次上传前验证配置可用性，并保持存储身份稳定，避免无效凭证、平台限制或静默切换导致上传失败和历史引用失效。

# 怎么样

## 流程

用户在设置页填写：`region`（V4 签名地域，如 `cn-hangzhou`；兼容输入旧格式 `oss-cn-hangzhou` 并归一化）、`bucketName`、`accessKeyId`、`accessKeySecret`、`endpoint`（可选且只允许 hostname）、`objectKeyPrefix`（默认 vault 名且禁止为空）、`signedUrlExpireSeconds`（默认 3600，范围 `61..604800`）、`autoUpload`（默认 true）。保存前必须通过 V4 凭证校验，禁止持久化无效凭证。当前配置明文存 `data.json`。

保存时插件用已填凭证对 `{objectKeyPrefix}/.oss-plugin-probe/{randomUUID}` 发送签名 GET。随机 Key 不应存在，因此 `404 NoSuchKey` 是预期成功。`objectKeyPrefix` 禁止以 `/` 开头，首段禁止为占位命名 `uploading`，任一段禁止为内部探针命名 `.oss-plugin-probe` 或 URL 点路径 `.` / `..`。禁止用 ListObjects 作为凭证探针，避免要求枚举 Bucket 对象名称的权限。其他响应均 Notice 报错并阻止保存。`autoUpload` 变为 false 时，新拦截与 `vault.on('create')` 补传立即跳过，已开始的自动任务在下一次 Initiate/Part/Complete 前安全暂停并保留恢复状态；已有 `oss://` 链接的渲染和显式删除不受影响。

所有 OSS 数据 API、管理 API 和附件签名访问 URL 统一使用标准 `{bucket}.{endpoint}` Host，默认 Endpoint 为 `oss-{region}.aliyuncs.com`。所有请求和预签名 URL 必须使用 OSS Signature V4（`OSS4-HMAC-SHA256`），禁止继续生成 V1 `Authorization: OSS ...` 或 HMAC-SHA1 URL。

标准公网 Endpoint 的产品覆盖边界必须如实展示：2025 年 3 月 20 日前已开通 OSS 服务的用户不受影响；非中国内地 Region 不受这项公网策略影响。该日期后新开通 OSS 服务的用户访问中国内地 Bucket 时，阿里云会阻断默认公网域名上的数据类 API 并返回 `400 PublicEndpointForbidden`，当前版本因此不支持这组配置。凭证探针遇到该错误必须阻止保存并明确提示“当前配置无法通过标准公网 Endpoint 访问，请在首次配置时改用非中国内地 Region”；已有引用不得直接切换存储身份。

Bucket、Endpoint、Region 与 Object Key 前缀共同构成不可变的存储身份。Object Key 前缀中的可见空格属于真实 Key，旧配置不得在加载或轮换凭证时静默 `trim`；任何会改变前缀字节的归一化都必须视为存储身份迁移。未完成任务必须持久化该身份并只用原身份续传；存在任务时禁止把旧 `uploadId` 或已完成 Object 提交到新身份。当前 `oss://` 格式不携带 Bucket，因此设置页变更存储身份时必须显式阻止或走专用迁移流程，禁止静默切换导致历史引用失效。AccessKey 可在同一存储身份内轮换。
