# PDF 原始名称展示设计

## 目标

PDF 继续使用轻量的“浏览器打开”附件行，不恢复 PDF.js 或内嵌渲染。附件行名称优先展示 Markdown 图片语法的 alt 文本，例如：

```markdown
![百鸟数据-声纹检测报告.pdf](oss://许凯测试oss插件/2a38fcb6-a0d2-4b99-ac18-51042dc5d854.pdf)
```

应显示 `百鸟数据-声纹检测报告.pdf`，而不是 UUID 文件名。

## 名称规则

1. 读取待替换 PDF DOM 节点的 `alt` 属性。
2. 对 alt 文本执行首尾空格清理；清理后非空则作为展示名称。
3. alt 缺失或清理后为空时，回退到 OSS key 的末段文件名。
4. OSS key 文件名继续执行 URL 解码；解码失败时使用未解码值。

## 实现边界

- `PdfRenderer.mount` 接收可选展示名称，由 PDF 链接组件统一执行名称选择。
- Reading View 后处理和 Live Preview/Canvas 增量渲染都从原节点读取 `alt` 并传入组件。
- 每个 PDF 节点独立读取名称、签名和替换，连续多个 PDF 不共享可变名称状态。
- 不修改 Markdown 存储格式、上传流程、OSS object key 或签名逻辑。
- 不增加 PDF.js、Worker、Canvas、二进制下载或 `<embed>` 输出。

## 错误与兼容

- 旧文档没有 alt 时保持现状，展示 OSS key 中的文件名。
- 非 PDF 媒体的 alt 行为不变。
- 名称只通过 `textContent` 写入，避免把 Markdown alt 当作 HTML 注入。

## 测试与验收

- PDF 链接组件优先显示非空 alt。
- 空白 alt 回退到 OSS key 文件名。
- Reading View 能把原节点 alt 传给 PDF 组件。
- Live Preview/Canvas 能把原节点 alt 传给 PDF 组件。
- 连续三个 PDF 分别显示各自名称和签名链接。
- 全量测试、类型检查和生产构建通过后部署；保留测试库 `data.json`。
