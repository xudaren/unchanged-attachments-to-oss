> 本文是渲染功能的下钻文档；全局约束仍以 [`CLAUDE.md`](../CLAUDE.md) 为准。

# 是什么

在 Reading View、Live Preview 和 Canvas 中把永久引用（遗留 `oss://` 与新格式公共 URL）呈现为对应媒体或附件卡片：公共读开启时免签名直出公共 URL，关闭时动态签名后渲染。

# 为什么

永久引用需要保持稳定和可编辑；私有模式下 OSS 内容只能通过短期签名访问，公共读模式下则直接使用不过期的公共 URL。渲染层还必须控制过期、异步竞争和非必要流量。

# 怎么样

## 流程

Reading View 与 Canvas 只用 `registerMarkdownPostProcessor` 处理 Obsidian 当前交付的渲染片段；Canvas 文件节点本质上也是 Obsidian 管理的 Markdown Preview，禁止再用全局 Observer 竞争修改其内部 DOM。只有 Live Preview 在 `workspace.onLayoutReady` 后使用增量 `MutationObserver`，且只处理 `.markdown-source-view` 中本批次发生变化的目标节点与新增子树，禁止在 Observer 回调中重新扫描 `document`。

所有渲染入口统一调用 `SignedUrlResolver`：匹配目标覆盖 `oss://` 源与公共 URL 引用，公共 URL 的识别 host 集合固定为当前访问域名（自定义域名 ?? `{bucket}.{endpoint}`）、默认域名 `{bucket}.{endpoint}` 与全部退役访问域名（曾配置后更换的自定义域名），三者经 `OssReferenceCodec` 还原为 Object Key 后共用同一渲染会话与错误语义；识别只按 host 集合精确匹配，该 Bucket 下任意 Object Key 都必须接受，禁止按当前 `objectKeyPrefix` 过滤，以便渲染遗留前缀对象；渲染生成的 URL 一律重建为当前访问域名，退役域名引用保持可渲染、可删除、可核验，直到命令面板「将所有引用归一到当前访问域名」完成迁移。缓存键由 `bucket + 访问域名 + objectKey + publicRead` 组成，LRU 缓存保留至过期前 60s；同一缓存键正在签名时复用同一个 Promise；返回结果必须携带 `expireAt + generation`。公共读开启时 resolver 直接返回公共 URL，`expireAt` 为无穷大，免续签、免 HMAC 派生，也不要求 AK/SK；关闭时维持 V4 动态签名，签名 URL 的 host 同样使用访问域名。PDF、音频、右键菜单与图片预览在用户动作发生时重新确认 lease；图片/视频进入视口准备挂载 URL 时也必须确认当前代际与剩余有效期，禁止把早先缓存的过期 URL 延迟挂载到 DOM。凭证、Endpoint、有效期、公共读开关或访问域名变化时先清空已完成和进行中的缓存并失效所有 render session，旧代请求无论成功或失败都必须转用当前配置重新解析，禁止向活动节点返回旧签名 URL。插件卸载与配置切换语义必须分离：配置切换允许旧请求转向新代重新解析；卸载必须把 resolver 永久置为 disposed，禁止 in-flight 请求复活。Reading View 尚未挂入 workspace 的 detached fragment、已打开预览 Modal 和其监听也属于当前 render lifetime，卸载后不得继续写 DOM 或保留旧插件闭包。V4 派生 HMAC-SHA256 Key 应按 Secret、日期、Region 复用，避免每个附件重复导入和派生。

Obsidian/Electron 规范化出的 `oss:///%E8...` 必须先恢复为原始 Object Key，再生成签名 URL。图片、视频、音频分别渲染为对应原生元素；PDF 只渲染为轻量附件卡片，名称优先取 Markdown 图片语法的 alt 文本（如 `![报告名称.pdf](oss://key)` 中的 `报告名称.pdf`），alt 为空时才回退到 Object Key 文件名。卡片展示 PDF 类型标识、完整名称和“打开”操作，名称过长时单行省略并通过 title 保留完整内容；禁止下载 PDF 二进制、创建 Canvas、启动 Worker 或内嵌系统 PDF 查看器。每个 PDF 必须独立签名和渲染，连续多个 PDF 中单个失败不得影响其他 PDF。异步签名完成后必须再次核对节点当前 Object Key，禁止旧结果覆盖被 Obsidian 复用的节点。批量渲染必须逐节点隔离失败，失败时保留原始源地址并显示独立错误标记，允许后续视图刷新重试。

图片、视频、音频必须使用统一的“附件容器 → 媒体 → 名称”纵向布局，在媒体正下方显示 Markdown 图片语法 `[]` 中的名称，Reading View、Live Preview 与 Canvas 的位置和间距保持一致；名称为空时不显示标题，也不得回退展示 OSS UUID。标题过长时单行省略，并通过 `title` 保留完整名称。音频播放器、音频附件容器和 PDF 卡片在 Reading View、Live Preview 与 Canvas 中都必须按父容器 `width: 100%` 占满正文可用行宽，禁止使用固定像素宽度或依赖屏幕分辨率；Live Preview 必须在渲染时给实际的 `.image-wrapper`、`.cm-embed-block`、`.internal-embed` 和所在 `.cm-line` 添加专用展开类。尤其禁止遗漏 Obsidian 默认 `display:inline-flex` 的 `.image-wrapper`，否则其收缩宽度会把音频压成 0px、把 PDF 卡片限制为内容宽度。只允许添加样式类，禁止替换这些 CodeMirror 编辑入口节点。

媒体渲染必须避免无意义的 OSS 数据流量：PDF 卡片只挂载可点击的签名链接，未点击时不得请求 PDF 内容；音频挂载签名 URL 时必须使用 `preload="none"`，允许原生播放器正常识别音源但不得预下载音频内容；视频只在进入视口附近时挂载签名 URL 并使用 `preload="metadata"` 读取小段数据展示首帧，视口外不得提前请求；图片只在进入视口附近时挂载签名 URL，不可见的长文档和 Canvas 图片不得提前下载。延迟图片占位节点必须保留非零布局区域，禁止用 `display:none` 造成可见性观察死锁。环境不支持可见性观察时允许立即加载图片和视频，以保证兼容性。Live Preview 中 Obsidian 未生成原生媒体元素、只生成带 `src` 的 `.internal-embed` 时，插件必须保留该可编辑宿主并在其内部挂载正确的媒体元素。

OSS 附件的右键菜单由插件统一接管，禁止让 Obsidian 将视频、音频和 PDF 显示为“复制图片 / Remove image / 重置大小”。菜单只保存 Object Key 与可验证的来源定位，不得长期保存签名 URL；打开附件和图片预览必须在点击时重新签名。菜单项必须按图片、视频、音频、PDF 显示对应名称；禁止读写系统剪贴板，避免插件获得 Vault 外部剪贴板内容的访问能力；仅在能确认来源 Markdown 与具体引用实例时提供“移除引用”。Canvas 永不提供移除引用，Live Preview 禁止回退猜测当前活动 Markdown。移除时必须按当前唯一 Object Key 先确认是否联动删除；用户选择保留 OSS 时只移除引用，用户确认联动删除时先删除 OSS Object，只有远端明确成功才精确删除一个 Markdown 引用。网络、Bucket 不存在、Endpoint 错误或 OSS 删除失败时必须保留本文档引用。

## 约束

- MutationObserver 的 `removedNodes` 只有在回调执行时节点仍未重新连接 DOM，才可释放渲染会话；媒体加标题、Canvas 重排等 `replaceWith → appendChild` 会产生“先移除后重新接入”的移动记录，禁止将其误判成真实删除，否则会形成 `恢复 oss:// → 再渲染 → 再移动` 的死循环。
- OSS 附件右键菜单必须阻止 Obsidian 图片菜单继续冒泡，并且只能对当前 Object Key 和可确认的来源 Markdown 执行操作；禁止因 DOM 外层仍为 `.image-embed` 就展示图片专属操作。
- 未配置 Bucket/AK/SK 时必须在签名前失败并保留源地址，禁止生成无效 HTTPS URL 覆盖可重试源地址；公共读模式不要求 AK/SK，但开关关闭且凭证未解锁时必须按同一失败语义保留源地址。
- 设置切换必须在第一个异步持久化等待前清空签名状态，且 `onLayoutReady` 回调必须检查插件是否已经卸载，禁止旧配置和卸载后的监听回写 DOM。
- OSS 图片必须由插件提供可见的放大操作和独立预览 Modal，禁止依赖 Obsidian 只能解析 Vault 本地附件的原生放大链路。
- Live Preview 中 OSS 图片必须同时保留 Obsidian 原生控件和插件的 OSS 放大按钮；OSS 按钮必须向左错开原生按钮区域，禁止重叠。定位样式必须限定在 `.oss-image-preview-host` 内，禁止影响本地图片。Obsidian 原生“查看文件”对 `oss://` 可能无效，但按用户要求保留。

## 规则

- 推荐 PDF 附件卡片使用类型标识、原始语义文件名和清晰的“打开”按钮，并适配 Obsidian 明暗主题，因为用户应一眼识别附件类型和内容。
