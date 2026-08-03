# Unchanged Attachments to OSS

【Obsidian 插件】将常用不可变附件（图片/视频/音频/PDF）自动上传到阿里云 OSS，替换本地引用为动态签名 URL，解决多端同步和共享问题。

## 功能特性

- **自动上传**：粘贴、拖入附件自动上传到 OSS，无需手动操作
- **动态签名**：私有 Bucket 安全访问，签名 URL 自动缓存、到期前刷新
- **多端兼容**：PC（Windows/macOS）+ 移动端（iOS/Android）均可使用
- **断点续传**：大文件分片上传，中断后自动恢复，持久化到 `data.json`
- **删除联动**：移除 md 中的 OSS 引用时，弹窗确认是否同步删除远端文件
- **迁移工具**：支持一键迁移全部或指定文件夹的本地附件到 OSS
- **状态栏指示**：显示自动上传状态和上传进度，支持点击开关

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
| `region` | 是 | 阿里云 OSS 区域，如 `oss-cn-hangzhou` |
| `bucketName` | 是 | Bucket 名称 |
| `accessKeyId` | 是 | Access Key ID |
| `accessKeySecret` | 是 | Access Key Secret |
| `endpoint` | 否 | 自定义 Endpoint，默认 `{bucket}.{region}.aliyuncs.com` |
| `cname` | 否 | CNAME 绑定域名 |
| `objectKeyPrefix` | 否 | 对象 Key 前缀，默认使用 vault 名称 |
| `signedUrlExpireSeconds` | 否 | 签名 URL 有效期（秒），默认 3600 |
| `autoUpload` | 否 | 自动上传开关，默认开启 |

保存时会先通过标准 OSS Endpoint 校验 Bucket、凭证和 `oss:ListObjects` 权限；填写 CNAME 时会再单独校验 CNAME 的 DNS、HTTPS 和 OSS 绑定。任一步失败都会阻止保存，并区分提示凭证、权限、Bucket/Region、请求参数或网络问题。

## 使用方法

### 日常使用

- **粘贴附件**：在编辑器中 `Ctrl+V` 粘贴图片/PDF/音视频，自动上传并插入 `![](oss://{key})`
- **拖入附件**：直接拖拽文件到编辑器，同样自动上传
- **渲染预览**：Reading View 和 Live Preview 均自动将 `oss://` 链接替换为签名 URL 显示
- **删除联动**：从 md 中删除 `oss://` 引用时，弹窗确认是否同步删除 OSS 文件
- **状态栏**：点击状态栏图标可快速开关自动上传

### PDF 批注说明

Obsidian 原生 PDF 批注功能依赖本地文件，上传到 OSS 后**无法使用原生批注**。

**推荐工作流**：
1. PDF 放本地，先用 Obsidian 原生批注功能完成标注
2. 批注内容会保存到 companion `.pdf.md` 文件
3. 命令面板执行 `迁移所有本地附件到 OSS`
4. 之后 PDF 以 `<embed>` 方式内嵌预览，笔记继续在 companion md 里维护

如果你经常批注 PDF，建议在设置中关闭 PDF 上传，保留本地文件。

### 命令面板

`Ctrl/Cmd+P` 打开命令面板，可用命令：

| 命令 | 说明 |
|---|---|
| 测试 OSS 连接 | 手动验证凭证有效性 |
| 清理孤儿分片上传 | 清理 24 小时以上未完成的上传任务 |
| 迁移所有本地附件到 OSS | 全量迁移 vault 中的本地附件 |
| 迁移指定文件夹附件到 OSS | 选择性迁移指定文件夹的附件 |

## 技术约束

- 仅使用 Obsidian `requestUrl` 收发 HTTP，兼容移动端
- 仅使用 Web Crypto (`crypto.subtle`) 做签名，不依赖 Node.js API
- 统一走 OSS Multipart Upload，支持断点续传
- 分片大小固定 4MB，平衡移动端内存与请求数
- 签名 URL 内存缓存（LRU），减少滚动时重复签名开销

## License

MIT
