>当前文档是项目的根入口文档，定义项目全局总览框架信息
>
>Agent 接到任务需要查阅内容时优先下钻本地关联的文档，未找到再搜索网络，不单纯依赖模型预训练数据

# 是什么

>描述功能的组成要素和连接关系，每个要素和连接关系附一句话简介。先总后分，层级管理引用文档，可不断下钻。只包含与具体实现技术无关的功能描述

开发一个Obsidian插件，可以在PC端（windows、macOS）和移动端（ios、安卓）上同时兼容使用，功能点：

- 用户安装插件后，可以配置阿里云OSS操作必要的参数（参考：https://help.aliyun.com/zh/oss/user-guide/object-overview?spm=a2c4g.11186623.help-menu-31815.d_0_3_0.31dd6edcEhtEan&scm=20140722.H_177681._.OR_help-T_cn~zh-V_1）：region、endPoint、cName、bucketName...${根据实际选择的方案调整为实际有用的参数}

- 插件感知Obsidian中图片、视频、音频、PDF的上传，自动将上传的文件上传到OSS，并将OSS中文件的访问路径替换掉本地路径，然后删除本地文件

- 渲染显示的时候，对上传文件的访问路径进行动态签名和显示

- 删除上传文件时，提示是否联动删除OSS中的文件，如果确定那么进行联动删除

- 设置页提供「自动上传」开关（toggle），关闭后暂停自动上传，方便调试或离线编辑

- 设置页保存时对 OSS 凭证进行连通性校验（ping），验证 AK/SK 有效性，校验失败提前报错阻止保存

对应的 Obsidian 测试路径为：/Users/xukai/xukai_workspace/许凯测试oss插件

# 为什么

>描述功能的意义，按以下维度展开：
>
>- 业务价值：什么人在什么场景解决什么事
>
>- 技术价值：可监控、高安全、高可用、高扩展、高性能等
>
>- 成本与风险：实现代价与潜在风险


# 怎么样

>描述功能的具体实现。流程、约束、规则中的内容只与「是什么」描述的要素和连接关系相关

## 流程

### 配置

用户在设置页填写：`region`、`bucketName`、`accessKeyId`、`accessKeySecret`、`endpoint`（可选）、`cname`（可选）、`objectKeyPrefix`（默认 vault 名）、`signedUrlExpireSeconds`（默认 3600）、`autoUpload`（默认 true）。明文存 `data.json`。

保存时插件用已填凭证向 OSS 发送轻量请求（如 `GET /?buckets` 或 `HEAD /`）验证连通性与权限，失败则 Notice 报错并阻止保存。`autoUpload` 为 false 时，拦截器与 `vault.on('create')` 补传均跳过上传逻辑，已有 `oss://` 链接的渲染和删除不受影响。

### 上传

统一走 OSS Multipart Upload，不按大小分流。

```mermaid
sequenceDiagram
    participant U as 用户
    participant E as 编辑器
    participant P as 插件
    participant O as OSS
    U->>E: 粘贴/拖入 图片/视频/音频/PDF
    E->>P: editor-paste / editor-drop 拦截
    P->>E: 插入 ![](oss://uploading/{tempId}) 占位
    P->>O: InitiateMultipartUpload /{prefix}/{uuid}.{ext}
    O-->>P: uploadId
    loop Blob.slice 逐片 4MB
        P->>O: UploadPart(uploadId, n)
        O-->>P: ETag
        P->>P: data.json 持久化 partList
    end
    P->>O: CompleteMultipartUpload
    P->>E: 占位替换为 ![](oss://{key})
    Note over P: 失败调 AbortMultipartUpload；已落地文件走 vault.on('create') 补传后 vault.delete
```

### 渲染

Reading View 用 `registerMarkdownPostProcessor` 遍历 `img/video/audio/a`，Live Preview 用 CM6 Decoration，将 `oss://{key}` 替换为签名 URL：`https://{bucket}.{endpoint}/{key}?OSSAccessKeyId=&Expires=&Signature=`。签名结果按 key 缓存至过期前 60s。

### 删除

`vault.on('modify')` debounce 1s 后 diff 出被移除的 `oss://{key}`，弹 Modal 确认后 `requestUrl DELETE /{key}`。不做跨文档引用统计，删错以用户确认为准。

## 约束

- 必须只用 `requestUrl` 收发 HTTP，禁止使用 `fetch/XHR/ali-oss` SDK，因为要兼容移动端且绕 CORS。
- 必须只用 Web Crypto (`crypto.subtle`) 做签名，禁止使用 Node `crypto/fs/stream/Buffer`。
- 必须处理的附件类型：图片(png/jpg/jpeg/gif/webp/svg/bmp)、视频(mp4/mov/webm/mkv)、音频(mp3/wav/m4a/ogg/flac)、PDF；其他类型必须不动。
- md 中必须以标准 markdown 语法 `![](oss://{key})` 占位存储，禁止使用 wikilink 或 HTML 内嵌，禁止直接写入带签名的 URL，因为渲染管线只处理单一形式且签名会过期。
- 附件若已落地为本地文件，必须在 `CompleteMultipartUpload` 成功后再 `vault.delete`，禁止先删后传。
- 拦截路径上传失败必须将 blob 回写为本地文件并移除占位链接，禁止直接丢弃数据。
- 删除远端前必须二次确认，禁止跨文档引用统计带来的复杂度，误删责任由用户承担。
- objectKey 必须由 `{objectKeyPrefix}/{crypto.randomUUID()}.{ext}` 组成，禁止依赖内容哈希，因为流式分片无法边传边算 SHA-1；不做内容去重，孤儿文件由用户自行清理。
- 必须对所有附件统一走 OSS Multipart Upload，禁止使用一次性 PutObject，因为路径唯一化便于维护与续传。
- 必须在上传失败或用户取消时调 `AbortMultipartUpload`，禁止留孤儿分片，因为会持续计费。
- `autoUpload` 为 false 时必须完全跳过拦截与补传，禁止排队或静默上传，因为用户明确暂停意味着不产生任何网络请求。
- 设置页保存必须先通过凭证校验再持久化，禁止存入无效凭证，因为后续上传会静默失败且用户难以定位原因。

## 规则

- 推荐优先在 `editor-paste/editor-drop` 阶段拦截 blob 直传，因为可避免本地落盘再删的往返。
- 推荐分片固定 4 MB 并用 `Blob.slice` 惰性切片，因为可兼顾移动端内存与 RTT 数量。
- 推荐在 `data.json` 持久化 `uploadId + partList` 以支持断点续传，因为大视频常见网络中断。
- 推荐启动时清理 24h 以上未完成的 MultipartUpload，因为可避免长期孤儿计费。
- 推荐用私有 Bucket + 客户端 V1 签名，因为无需服务端且 URL 短。
- 推荐签名 URL 内存缓存（LRU，key→{url, expireAt}），因为可减少滚动时的重复签名开销。
- 推荐上传失败保留本地文件并在状态栏提示重试，因为可避免网络抖动造成数据丢失。
- 推荐提供"迁移指定文件夹附件"和"迁移全部附件"两条命令，因为支持先小范围验证再全量迁移。
- 推荐凭证校验用 `requestUrl HEAD /{bucket}.{endpoint}/` 或 `GET /?list-type=2&max-keys=0`，因为开销最小且能同时验证 Bucket 可达与签名有效。
- 推荐 `autoUpload` 开关变更时在状态栏展示当前状态图标，因为可让用户随时确认上传是否启用。
- 推荐语言简洁凝练，因为节省token