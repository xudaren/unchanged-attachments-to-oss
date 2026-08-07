import { FuzzySuggestModal, Notice, Plugin, TFolder } from "obsidian";
import { DeleteWatcher } from "./delete/watcher";
import { OssClient } from "./oss/client";
import { findRenderSurfaces, hydrateOssSubtree, selectMutationRoots } from "./render/dom-renderer";
import { createOssPostProcessor } from "./render/post-processor";
import { SignedUrlCache } from "./render/url-cache";
import { SignedUrlResolver } from "./render/url-resolver";
import { clearHmacKeyCache } from "./oss/signer";
import { OssSettingTab } from "./settings";
import { DEFAULT_SETTINGS, PluginSettings } from "./types";
import { AttachmentInterceptor } from "./upload/interceptor";
import { AutoUploadIndicator, RetryIndicator } from "./upload/indicator";
import { UploadManager } from "./upload/manager";
import { migrateAttachments } from "./upload/migrate";
import { UploadProgressBar } from "./upload/progress";
import { OssAttachmentContextMenu } from "./render/context-menu";
import { disconnectMediaLoading } from "./render/media-loading";

export default class OssPlugin extends Plugin {
  settings!: PluginSettings;
  client!: OssClient;
  uploadManager!: UploadManager;
  urlCache!: SignedUrlCache;
  urlResolver!: SignedUrlResolver;
  progressBar!: UploadProgressBar;
  autoUploadIndicator!: AutoUploadIndicator;
  retryIndicator!: RetryIndicator;
  attachmentContextMenu!: OssAttachmentContextMenu;
  private interceptor!: AttachmentInterceptor;
  private deleteWatcher!: DeleteWatcher;

  async onload(): Promise<void> {
    await this.loadSettings();

    // 默认前缀 = vault 名（文档规定）
    if (!this.settings.objectKeyPrefix) {
      this.settings.objectKeyPrefix = this.app.vault.getName();
      await this.saveSettings();
    }

    this.client = new OssClient(this.settings);
    this.urlCache = new SignedUrlCache();
    this.urlResolver = new SignedUrlResolver(
      () => ({
        bucket: this.settings.bucketName,
        host: this.client.signedUrlHost,
        accessKeyId: this.settings.accessKeyId,
        accessKeySecret: this.settings.accessKeySecret,
        expireSeconds: this.settings.signedUrlExpireSeconds,
      }),
      this.urlCache,
    );
    this.progressBar = new UploadProgressBar(this);
    this.uploadManager = new UploadManager(this.client, this.settings, () => this.saveSettings());
    this.deleteWatcher = new DeleteWatcher(this, this.client);
    this.attachmentContextMenu = new OssAttachmentContextMenu(
      this,
      (sourcePath, key, label, removeLocalReference) =>
        this.deleteWatcher.confirmReferenceRemoval(sourcePath, key, label, removeLocalReference),
    );

    // autoUpload 状态图标（点击切换）
    this.autoUploadIndicator = new AutoUploadIndicator(
      this,
      () => this.settings.autoUpload,
      async () => {
        this.settings.autoUpload = !this.settings.autoUpload;
        await this.saveSettings();
        new Notice(this.settings.autoUpload ? "自动上传已开启" : "自动上传已暂停");
      },
    );

    // 拦截路径失败重试指示器（延后绑定，避免与 interceptor 循环引用）
    const persistedRetries = Object.values(this.settings.pendingUploads)
      .filter((pending) => Boolean(pending.localPath))
      .map((pending) => ({
        mdPath: pending.sourcePath,
        localPath: pending.localPath!,
        ext: pending.ext,
        occurrenceId: pending.occurrenceId,
      }));
    this.retryIndicator = new RetryIndicator(
      this,
      async (entries) => this.interceptor.retryEntries(entries),
      persistedRetries,
    );

    this.interceptor = new AttachmentInterceptor(
      this,
      this.uploadManager,
      this.settings,
      this.progressBar,
      this.retryIndicator,
    );
    this.interceptor.register();

    // 让删除监听在 workspace layout ready 之后初始化，避免冷启动误报
    this.app.workspace.onLayoutReady(() => {
      void this.deleteWatcher.register();
    });

    this.registerMarkdownPostProcessor(
      createOssPostProcessor(this.settings, this.urlResolver, undefined, this.attachmentContextMenu),
    );

    let renderObserver: MutationObserver | null = null;
    let renderDisposed = false;
    this.app.workspace.onLayoutReady(() => {
      if (renderDisposed) return;
      renderObserver = new MutationObserver((records) => {
        for (const root of selectMutationRoots(records)) {
          void hydrateOssSubtree(root, this.urlResolver, undefined, this.attachmentContextMenu);
        }
      });
      renderObserver.observe(this.app.workspace.containerEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "href"],
      });
      for (const root of findRenderSurfaces(this.app.workspace.containerEl)) {
        void hydrateOssSubtree(root, this.urlResolver, undefined, this.attachmentContextMenu);
      }
    });
    this.register(() => {
      renderDisposed = true;
      renderObserver?.disconnect();
      disconnectMediaLoading();
      clearHmacKeyCache();
    });

    this.addSettingTab(new OssSettingTab(this.app, this));

    this.addCommand({
      id: "test-oss-connection",
      name: "测试 OSS 连接",
      callback: () => this.testConnection(),
    });

    this.addCommand({
      id: "cleanup-orphan-uploads",
      name: "清理孤儿分片上传",
      callback: () => void this.uploadManager.cleanupOrphans(),
    });

    this.addCommand({
      id: "migrate-all-attachments",
      name: "迁移所有本地附件到 OSS",
      callback: () => void migrateAttachments(this, this.uploadManager),
    });

    this.addCommand({
      id: "migrate-folder-attachments",
      name: "迁移指定文件夹附件到 OSS",
      callback: () => this.pickFolderAndMigrate(),
    });

    // 启动时后台清理孤儿分片（不阻塞加载）
    this.app.workspace.onLayoutReady(() => {
      if (this.isConfigured()) {
        void this.uploadManager.cleanupOrphans().catch(() => void 0);
      }
    });
  }

  async onunload(): Promise<void> {
    // Obsidian 会自动注销 registerEvent 注册的监听
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
    // 清理旧版已废弃的自定义访问域名配置。
    const legacy = this.settings as unknown as Record<string, unknown>;
    if ("cname" in legacy) {
      delete legacy.cname;
      await this.saveData(this.settings);
    }
    // 兼容缺失字段
    if (!this.settings.pendingUploads) this.settings.pendingUploads = {};
    if (this.settings.autoUpload === undefined) this.settings.autoUpload = true;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  isConfigured(): boolean {
    return Boolean(this.settings.bucketName && this.settings.accessKeyId && this.settings.accessKeySecret);
  }

  async testConnection(): Promise<void> {
    if (!this.isConfigured()) {
      new Notice("OSS 未配置：请填写 Bucket / AK / SK");
      return;
    }
    try {
      await this.client.verifyCredentials();
      new Notice("OSS 连接成功，凭证有效");
    } catch (err) {
      new Notice(`OSS 连接失败：${(err as Error).message}`);
    }
  }

  private pickFolderAndMigrate(): void {
    const folders = getAllFolders(this.app.vault.getRoot());
    new FolderSuggestModal(this.app, folders, (folder) => {
      void migrateAttachments(this, this.uploadManager, folder.path);
    }).open();
  }
}

/** 递归收集所有文件夹 */
function getAllFolders(root: TFolder): TFolder[] {
  const out: TFolder[] = [root];
  for (const child of root.children) {
    if (child instanceof TFolder) out.push(...getAllFolders(child));
  }
  return out;
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  constructor(
    app: InstanceType<typeof FuzzySuggestModal>["app"],
    private readonly folders: TFolder[],
    private readonly onChoose: (folder: TFolder) => void,
  ) {
    super(app);
    this.setPlaceholder("选择要迁移的文件夹…");
  }

  getItems(): TFolder[] {
    return this.folders;
  }

  getItemText(item: TFolder): string {
    return item.path || "/";
  }

  onChooseItem(item: TFolder): void {
    this.onChoose(item);
  }
}
