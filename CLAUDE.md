>当前文档是项目的根入口文档，定义项目全局总览框架信息
>
>Agent 接到任务需要查阅内容时优先下钻本地关联的文档，未找到再搜索网络，不单纯依赖模型预训练数据

# 是什么

>描述功能的组成要素和连接关系，每个要素和连接关系附一句话简介。先总后分，层级管理引用文档，可不断下钻。只包含与具体实现技术无关的功能描述

开发一个兼容 PC（Windows、macOS）和移动端（iOS、Android）的 Obsidian 插件，功能包括：

- 配置阿里云 OSS 的 `region`、`bucketName`、AK/SK、可选标准 `endpoint`、Object Key 前缀和签名有效期；AK/SK 必须经用户主密码加密后随 Vault 同步，保存时校验凭证连通性，失败则报错并阻止保存。
- 感知图片、视频、音频、PDF 的上传，先建立可恢复本地副本，再上传 OSS、验证引用替换，最后按安全条件清理本地文件。
- 动态签名并渲染已上传文件的访问路径。
- 从插件附件菜单或文档菜单显式删除时，询问是否联动删除 OSS 对象；原生删除不操作远端。
- 设置页提供「自动上传」开关，关闭后暂停自动上传，便于调试或离线编辑。
- 设置页和命令面板提供“管理本地保险副本”入口，展示占用、关联任务及恢复、重试、安全清理操作。

# 为什么

>描述功能的组成要素和连接关系，每个要素和连接关系附一句话简介。先总后分，层级管理引用文档，可不断下钻。只包含与具体实现技术无关的功能描述

- 业务价值：让多端 Obsidian 用户把大体积媒体放在私有 OSS，Vault 只保留稳定、可同步和可编辑的永久引用，减少本地附件与同步压力。
- 技术价值：V4 动态签名避免持久化临时 URL；durable staging、Multipart journal 与显式删除把网络中断、崩溃和误删从数据损失降为可恢复任务。
- 成本与风险：插件无服务端，部署简单；AK/SK 以主密码派生密钥加密后存入 Vault，主密码和解密密钥不持久化，用户需在每次插件加载后解锁。用户承担 OSS 存储/流量成本，可选核验还需要 ListObjects 权限。客户端凭证模式只适合个人可信设备，不应分发共享高权限 AK。


# 怎么样

>描述功能的具体实现。流程、约束、规则中的内容只与「是什么」描述的要素和连接关系相关

## 流程

>定义要素和连接关系如何运转，引入具体实现技术，是广义的流程
>
>推荐使用 Mermaid 流程图或时序图辅助说明复杂流程，保持图表与文字描述一致

- [配置](docs/configuration.md)：字段校验、V4 凭证探针、Endpoint 限制与存储身份。
- [上传与迁移](docs/upload-and-migration.md)：拦截、保险副本、Multipart、续传和引用提交。
- [渲染](docs/rendering.md)：动态签名、各视图媒体渲染、流量控制和附件菜单。
- [删除](docs/deletion.md)：显式删除入口、本地回收与远端对象处理顺序。
- [OSS 对象核验](docs/object-audit.md)：全量引用扫描、差集报告和安全清理。

## 约束

>定义不可突破的边界和验收条件，使用 "禁止 XXX" 或 "必须 XXX" 句式

- 必须只用 `requestUrl` 收发 HTTP，禁止使用 `fetch/XHR/ali-oss` SDK，因为要兼容移动端且绕 CORS。
- 必须只用 Web Crypto (`crypto.subtle`) 做签名，禁止使用 Node `crypto/fs/stream/Buffer`。
- 必须处理的附件类型：图片(png/jpg/jpeg/gif/webp/avif/svg/bmp)、视频(mp4/mov/webm/mkv/ogv/m4v)、音频(mp3/wav/m4a/ogg/flac/aac/opus)、PDF；其他类型必须不动。
- Markdown (`.md`)、Canvas (`.canvas`) 和 Base (`.base`) 属于 Vault 内可编辑、可查询的结构化内容，禁止自动上传到 OSS；必须保留在 Vault 中参与链接、搜索和编辑。
- md 中必须以标准 markdown 语法 `![](oss:///{percentEncodedKey})` 存储，三斜杠明确表示无 host 的绝对路径；Object Key 的每个路径段必须 percent-encode。禁止使用 raw 空格/括号等不安全目标、wikilink、HTML 内嵌或带签名 URL。上传、渲染、删除、核验必须共用唯一 `OssReferenceCodec`，禁止各模块复制简单正则。
- 所有 `requestUrl` 必须在真正发送前通过当前插件 lifecycle generation gate；引用修改、本地/远端删除、核验和迁移也必须在副作用前检查 lifecycle。禁止只在事件入口检查一次，因为热重载可能发生在任意 `await` 之间。
- AK/SK 必须使用 Web Crypto 的 PBKDF2-SHA256 派生不可导出密钥，并以 AES-256-GCM 加密；Vault 只允许持久化带版本的密文、salt、IV 与 KDF 参数，禁止持久化主密码、派生密钥或明文 AK/SK。插件卸载必须丢弃内存凭证与派生密钥。


## 规则

>定义最佳实践，使用 "推荐 XXX，因为 YYY" 句式

- 每次代码实现完成并通过验证后，默认执行 `npm run deploy:test` 部署到 `/Users/xukai/xukai_workspace/许凯测试oss插件/.obsidian/plugins/unchanged-attachments-to-oss`，方便用户立即验证；部署只更新 `main.js`、`manifest.json`、`styles.css`，禁止覆盖测试 Vault 中的 `data.json`。

- 部署完成后，自主通过 computer use 功能端到端验证各个功能是否正常，不正常就循环修改到正常，用于验证的多媒体数据目录：./test_media

- 语言简洁凝练，避免重复规范，节省 token。
