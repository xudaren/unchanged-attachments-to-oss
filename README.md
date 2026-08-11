# Unchanged Attachments to OSS

【Obsidian 插件】将常用不可变附件（图片/视频/音频/PDF）自动上传到阿里云 OSS，以永久 `oss://` 引用保存，并在渲染时动态生成临时签名 URL，解决多端同步和共享问题。

## 功能特性

- **自动上传**：粘贴、拖入附件自动上传到 OSS，无需手动操作
- **V4 动态签名**：私有 Bucket 安全访问，签名 URL 自动缓存并在使用前续期
- **多端兼容**：PC（Windows/macOS）+ 移动端（iOS/Android）均可使用
- **断点续传**：网络、超时和 OSS 5xx 中断会保留本地 staging 与分片状态，可从任务入口恢复
- **显式删除**：附件右键菜单和文档文件菜单提供联动删除，原生删除不会静默操作 OSS
- **迁移工具**：支持一键迁移全部或指定文件夹的本地附件到 OSS
- **状态栏指示**：显示自动上传状态和上传进度，支持点击开关

支持的附件格式：图片（png/jpg/jpeg/gif/webp/avif/svg/bmp）、视频（mp4/mov/webm/mkv/ogv/m4v）、音频（mp3/wav/m4a/ogg/flac/aac/opus）和 PDF。Markdown、Canvas 与 Base 保留在 Vault 中，不上传 OSS。

## 使用范围限制

当前版本只使用 OSS 标准公网 Endpoint。根据[阿里云官方策略变更公告](https://www.alibabacloud.com/zh/notice/oss_update_notice_policy_change_in_calling_data_api_operations_via_the_default_public_domain_name_45a)，2025 年 3 月 20 日后新开通 OSS 服务的用户，通过默认公网域名访问中国内地 Bucket 的上传、下载、删除、HEAD、ListObjects 和 Multipart 等数据 API 会被阻断，并返回 `400 PublicEndpointForbidden`。

这类用户请在首次配置时选择非中国内地 Region。2025 年 3 月 20 日前已开通 OSS 服务的用户不受该策略影响。已有 `oss://` 引用的 Vault 不要直接切换 Region/Bucket；它们属于不可变存储身份，只能通过专用迁移流程变更。

## 安装

### 手动安装

1. 克隆或下载本项目
2. 安装依赖并构建：

```bash
npm install
npm run build
```

3. 将以下文件复制到你的 Obsidian vault 插件目录：

```
<vault>/.obsidian/plugins/unchanged-attachments-to-oss/
├── main.js
├── manifest.json
└── styles.css（如有）
```

4. 重启 Obsidian，进入 **设置 → 第三方插件**，关闭安全模式（如需要），启用 **Unchanged Attachments to OSS**

### 开发模式

```bash
npm run dev   # 监听模式，修改后自动重新构建
```

构建完成后手动复制 `main.js` 到 vault 插件目录，在 Obsidian 中重新加载插件即可。

## 配置

打开插件设置页，填写以下字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `region` | 是 | V4 签名地域，如 `cn-hangzhou`；旧格式 `oss-cn-hangzhou` 会自动归一化 |
| `bucketName` | 是 | Bucket 名称 |
| `accessKeyId` | 是 | Access Key ID |
| `accessKeySecret` | 是 | Access Key Secret |
| `endpoint` | 否 | OSS Endpoint hostname，默认 `oss-{region}.aliyuncs.com` |
| `objectKeyPrefix` | 是 | 对象 Key 前缀，默认使用 vault 名称且禁止为空或以 `/` 开头；不能含 `.` / `..` 路径段或占用插件内部命名 |
| `signedUrlExpireSeconds` | 否 | V4 签名 URL 有效期（61–604800 秒），默认 3600 |
| `autoUpload` | 否 | 自动上传开关，默认开启 |

保存时会通过标准 OSS Endpoint 和 Signature V4 访问每次随机的不存在探针 Key，以 `404 NoSuchKey` 验证 Bucket、凭证和 `oss:GetObject` 权限。探针不会列举 Bucket、创建对象或下载真实内容。校验失败会阻止保存，并区分提示凭证、权限、Bucket/Region、请求参数或网络问题。

Bucket、Region、Endpoint 与 Object Key 前缀共同组成存储身份；前缀中的空格也是 Object Key 的真实内容，不会被插件静默裁剪。首次配置后可轮换 AK/SK 或调整签名有效期；当前版本会阻止直接切换存储身份，因为历史 `oss://` 引用不携带 Bucket，静默切换会让旧附件全部失效。

## 使用方法

### 日常使用

- **粘贴附件**：在编辑器中 `Ctrl+V` 粘贴图片/PDF/音视频，自动上传并插入 `![](oss:///{percentEncodedKey})`
- **拖入附件**：直接拖拽文件到编辑器，同样自动上传
- **渲染预览**：Reading View 和 Live Preview 均自动将 `oss://` 链接替换为签名 URL 显示
- **删除联动**：在 OSS 附件右键菜单中移除单条引用，或从文件菜单执行“删除文档并处理 OSS 附件”
- **状态栏**：点击状态栏图标可快速开关自动上传

关闭自动上传后不会接管新的粘贴、拖入或落盘附件；正在进行的自动任务会在下一次 OSS 请求前暂停并保留 staging/分片进度，可稍后手动重试。

### PDF 说明

Obsidian 原生 PDF 批注功能依赖本地文件，上传到 OSS 后**无法使用原生批注**。

**推荐工作流**：
1. PDF 放本地，先用 Obsidian 原生批注功能完成标注
2. 批注内容会保存到 companion `.pdf.md` 文件
3. 命令面板执行 `迁移所有本地附件到 OSS`
4. 之后 PDF 显示为轻量附件卡片，点击“浏览器打开”，笔记继续在 companion md 里维护

如果需要继续使用 Obsidian 原生 PDF 批注，请暂停自动上传，并避免执行包含该 PDF 的迁移命令。

### 数据安全

- 已落地附件只有在所有真实引用完成替换并回读验证后才会删除；找不到引用或任一文档失败时保留本地文件。
- 粘贴/拖入由插件接管后会先在 `.oss-plugin-staging/` 建立内部恢复文件；应用中断后可继续上传或提交已经完成的 Object，任务完成后自动清理 staging。
- 引用依据 Obsidian 的链接解析结果识别，不会仅凭同名文件进行全库替换。
- `oss://` 中的 Object Key 使用统一 URI 编码，Vault 名含空格、括号或中文时也可可靠渲染、删除和核验。
- 迁移会跳过没有真实引用的附件，执行前展示数量并要求确认。
- 混合粘贴或拖入包含不支持文件时由 Obsidian 默认处理；随附件附带的文本/HTML 替代表达不会阻止直传。
- 编辑器直传立即生效；附件落盘兜底只在布局就绪后监听，并只扫描 MetadataCache 命中的候选文档，不处理冷启动历史附件。

### 命令面板

`Ctrl/Cmd+P` 打开命令面板，可用命令：

| 命令 | 说明 |
|---|---|
| 测试 OSS 连接 | 手动验证凭证有效性 |
| 重试未完成上传 | 桌面端和移动端均可恢复待处理任务 |
| 清理孤儿分片上传 | 重置本机日志中超过 24 小时的分片任务；未知远端任务只报告、不自动中止 |
| 核验 OSS 对象引用 | 对比 OSS 对象与 Vault 中 Markdown/Canvas/Base 引用 |
| 迁移所有本地附件到 OSS | 全量迁移 vault 中的本地附件 |
| 迁移指定文件夹附件到 OSS | 选择性迁移指定文件夹的附件 |

插件不维护 OSS 引用索引，启动时不会扫描整个 Vault，也不会自动请求 OSS 执行维护。单个 OSS 附件通过附件右键菜单删除；整篇 Markdown 通过文件右键菜单“删除文档并处理 OSS 附件”删除。使用 Obsidian 原生删除时只删除本地文档，不联动 OSS，遗留对象可通过“核验 OSS 对象引用”处理。

## 技术约束

- 仅使用 Obsidian `requestUrl` 收发 HTTP，兼容移动端
- 仅使用 Web Crypto (`crypto.subtle`) 实现 OSS Signature V4，不依赖 Node.js API
- 统一走 OSS Multipart Upload，支持断点续传
- 分片大小固定 4MB，平衡移动端内存与请求数
- 签名 URL 内存缓存（LRU），减少滚动时重复签名开销

## License

MIT
