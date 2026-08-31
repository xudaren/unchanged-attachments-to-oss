> 本文是配置功能的下钻文档；全局约束仍以 [`CLAUDE.md`](../CLAUDE.md) 为准。

# 是什么

提供 OSS 连接、存储位置、自定义访问域名、签名有效期、公共读开关、主密码加密和自动上传状态的配置与保存入口。

# 为什么

在首次上传前验证配置可用性，并保持存储身份稳定，避免无效凭证、平台限制或静默切换导致上传失败和历史引用失效；同时提供可选的自定义访问域名，规避阿里云默认域名对浏览器直开图片等类型的强制下载策略。

# 怎么样

## 流程

用户在设置页填写：`region`（V4 签名地域，如 `cn-hangzhou`；兼容输入旧格式 `oss-cn-hangzhou` 并归一化）、`bucketName`、`accessKeyId`、`accessKeySecret`、`endpoint`（可选且只允许 hostname）、`customDomain`（可选自定义访问域名，需为合法 hostname）、`objectKeyPrefix`（默认 vault 名且禁止为空）、`signedUrlExpireSeconds`（默认 3600，范围 `61..604800`）、`autoUpload`（默认 true）、`publicRead`（Bucket 级公共读开关，默认 false）和主密码。保存前必须通过 V4 凭证校验，禁止持久化无效凭证。`publicRead` 与 `customDomain` 均不参与存储身份，也不影响凭证探针；它们的变更是纯访问决策，不触发存储身份锁定，即时保存生效。

AK/SK 使用 Web Crypto `PBKDF2-SHA256` 从主密码与随机 salt 派生不可导出的 AES-256 密钥，再以 `AES-GCM` 和随机 96-bit IV 加密。`data.json` 只保存带版本的密文、salt、IV、迭代次数和非敏感配置；禁止保存主密码、派生密钥与明文 AK/SK。插件每次加载后保持锁定，并在布局就绪后主动展示主密码解锁弹窗；用户关闭弹窗时保持锁定，可稍后从设置页解锁。解密后的凭证和派生密钥只存在于当前插件实例内存，卸载或热重载时丢弃。密码错误必须保持锁定且禁止 OSS 请求。

旧版明文配置只允许作为一次性迁移输入留在内存；插件必须在启动后主动展示设置主密码的迁移弹窗。用户设置主密码、OSS 校验与密文持久化全部成功后，必须从下一份 `data.json` 中移除明文字段。任一步失败都不得覆盖原持久化配置。忘记主密码时无法解密，只能重新填写 AK/SK 并建立新密文；插件禁止提供可绕过主密码的恢复路径。

保存时插件用已填凭证对 `{objectKeyPrefix}/.oss-plugin-probe/{randomUUID}` 发送签名 GET。随机 Key 不应存在，因此 `404 NoSuchKey` 是预期成功。`objectKeyPrefix` 禁止以 `/` 开头，首段禁止为占位命名 `uploading`，任一段禁止为内部探针命名 `.oss-plugin-probe` 或 URL 点路径 `.` / `..`。禁止用 ListObjects 作为凭证探针，避免要求枚举 Bucket 对象名称的权限。其他响应均 Notice 报错并阻止保存。`autoUpload` 变为 false 时，新拦截与 `vault.on('create')` 补传立即跳过，已开始的自动任务在下一次 Initiate/Part/Complete 前安全暂停并保留恢复状态；已有 OSS 引用的渲染和显式删除不受影响。

Bucket 级公共读开关只改变渲染 URL 的生成方式：开启时渲染直接使用未签名公共 URL `https://{访问域名}/{percentEncodedKey}`，不依赖 AK/SK，凭证锁定状态也能渲染；关闭时插件拦截同 host 引用并动态追加 V4 签名参数后渲染。开关切换瞬时生效、双向零文档改写，签名 URL 只存在于渲染期，禁止写回文档；开启时 `signedUrlExpireSeconds` 不生效。开关开启但 Bucket 或对象实际不可公开读时，渲染按现有失败语义保留源地址并显示错误标记。

自定义访问域名 `customDomain` 是统一的浏览器访问域名（访问域名）：配置后签名 URL、公共 URL 与新上传引用的 host 全部改用该域名，因为阿里云对默认域名的浏览器访问会按地域与 Bucket 创建时间强制下载图片等类型；未配置时访问域名为默认 `{bucket}.{endpoint}`。该字段只做 hostname 格式校验，禁止网络探测，因为私有 Bucket 无法匿名探测且探测必然误判；域名已绑定 Bucket 并完成 ICP 备案由用户自行保证，填错可随时清空回退默认域名。变更访问域名时必须先清空签名缓存并刷新全部渲染会话；旧域名转为退役访问域名并随配置持久化，其存量引用保留渲染、删除与核验识别能力，但新引用不再写入该域名；设置页必须提示变更后运行「将所有引用归一到当前访问域名」（设置页维护章节按钮或命令面板命令）完成迁移。

所有 OSS 数据 API、管理 API 与凭证探针统一使用标准 `{bucket}.{endpoint}` Host，默认 Endpoint 为 `oss-{region}.aliyuncs.com`；浏览器访问 URL（签名 URL 与公共 URL）统一使用访问域名。所有请求和预签名 URL 必须使用 OSS Signature V4（`OSS4-HMAC-SHA256`），禁止继续生成 V1 `Authorization: OSS ...` 或 HMAC-SHA1 URL；V4 预签名将 Host 作为附加签名 Header（`x-oss-additional-headers: host`）纳入签名，Region 由配置显式传入而不从 host 推断，因此签名 URL 可直接以自定义域名生成并被浏览器接受。

标准公网 Endpoint 的产品覆盖边界必须如实展示：2025 年 3 月 20 日前已开通 OSS 服务的用户不受影响；非中国内地 Region 不受这项公网策略影响。该日期后新开通 OSS 服务的用户访问中国内地 Bucket 时，阿里云会阻断默认公网域名上的数据类 API 并返回 `400 PublicEndpointForbidden`，当前版本因此不支持这组配置。凭证探针遇到该错误必须阻止保存并明确提示“当前配置无法通过标准公网 Endpoint 访问，请在首次配置时改用非中国内地 Region”；已有引用不得直接切换存储身份。

Bucket、Endpoint、Region 与 Object Key 前缀共同构成不可变的存储身份。Object Key 前缀中的可见空格属于真实 Key，旧配置不得在加载或轮换凭证时静默 `trim`；任何会改变前缀字节的归一化都必须视为存储身份迁移。未完成任务必须持久化该身份并只用原身份续传；存在任务时禁止把旧 `uploadId` 或已完成 Object 提交到新身份。当前 `oss://` 格式不携带 Bucket，因此设置页变更存储身份时必须显式阻止或走专用迁移流程，禁止静默切换导致历史引用失效。新格式公共 URL 引用内嵌写入时的访问域名；存储身份锁定保证默认域名形态的引用永久有效，访问域名变更不属于存储身份变更；旧域名转为退役访问域名后仍保留识别能力，存量引用经命令「将所有引用归一到当前访问域名」完成迁移。公共读开关与 AccessKey 轮换均不改变引用。AccessKey 可在同一存储身份内轮换。
