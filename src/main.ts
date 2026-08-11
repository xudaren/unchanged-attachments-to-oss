import { FuzzySuggestModal, Notice, Plugin, TFolder } from "obsidian";
import {
  establishedStorageIdentityKey,
  NormalizedOssConfig,
  normalizeOssConfig,
  normalizeObjectKeyPrefix,
  normalizeSignedUrlExpiry,
  normalizeStorageIdentity,
  resolveLoadedObjectKeyPrefix,
  storageIdentityKey,
} from "./config";
import { DeleteWatcher } from "./delete/watcher";
import { OssClient } from "./oss/client";
import {
  disposeRemovedOssRenderSessions,
  disposeOssRenderSessions,
  findRenderSurfaces,
  hydrateOssSubtree,
  resetOssRenderLifetime,
  selectMutationRoots,
} from "./render/dom-renderer";
import { RenderSessionLifetime } from "./render/lifetime";
import { createOssPostProcessor } from "./render/post-processor";
import { SignedUrlCache } from "./render/url-cache";
import { SignedUrlResolver } from "./render/url-resolver";
import { clearHmacKeyCache } from "./oss/signer";
import { formatCredentialError } from "./oss/errors";
import { OssSettingTab } from "./settings";
import { DEFAULT_SETTINGS, PluginSettings } from "./types";
import { AttachmentInterceptor } from "./upload/interceptor";
import { AutoUploadIndicator, RetryIndicator } from "./upload/indicator";
import { UploadManager } from "./upload/manager";
import { migrateAttachments } from "./upload/migrate";
import { UploadProgressBar } from "./upload/progress";
import { OssAttachmentContextMenu } from "./render/context-menu";
import { disconnectMediaLoading } from "./render/media-loading";
import { runObjectAudit } from "./audit/modal";
import { LifecycleQuiescedError, PluginLifecycle } from "./lifecycle";

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
  lifecycle!: PluginLifecycle;
  private interceptor!: AttachmentInterceptor;
  private deleteWatcher!: DeleteWatcher;
  private renderLifetime!: RenderSessionLifetime;
  private unloading = false;

  async onload(): Promise<void> {
    // Register before the first await: this instance can itself be disabled
    // while waiting for an older hot-reload generation to drain.
    this.register(() => {
      this.unloading = true;
      this.lifecycle?.quiesce();
    });
    this.lifecycle = await PluginLifecycle.activate(this.manifest.id);
    if (this.unloading) {
      this.lifecycle.quiesce();
      void this.lifecycle.drain();
      return;
    }
    await this.lifecycle.track(this.loadSettings());
    if (this.unloading || !this.lifecycle.isActive) {
      void this.lifecycle.drain();
      return;
    }
    this.lifecycle.assertActive("继续初始化旧实例");

    this.client = this.createRuntimeClient(this.settings);
    this.urlCache = new SignedUrlCache();
    this.urlResolver = new SignedUrlResolver(
      () => {
        // Rendering remains available for legacy Object Key prefixes, but every
        // connection/signing field must still validate before an HTTPS URL can
        // replace the durable oss:// source.
        const config = normalizeOssConfig({
          ...this.settings,
          objectKeyPrefix: "obsidian",
        });
        return {
          bucket: config.bucketName,
          host: `${config.bucketName}.${config.endpoint}`,
          region: config.region,
          accessKeyId: config.accessKeyId,
          accessKeySecret: config.accessKeySecret,
          expireSeconds: config.signedUrlExpireSeconds,
        };
      },
      this.urlCache,
    );
    this.progressBar = new UploadProgressBar(this);
    this.uploadManager = new UploadManager(
      this.client,
      this.settings,
      () => this.saveSettings(),
      this.lifecycle,
    );
    this.deleteWatcher = new DeleteWatcher(this, this.client, this.lifecycle);
    this.attachmentContextMenu = new OssAttachmentContextMenu(
      this,
      (sourcePath, key, label, removeLocalReference) =>
        this.deleteWatcher.confirmReferenceRemoval(sourcePath, key, label, removeLocalReference),
    );
    this.renderLifetime = new RenderSessionLifetime();

    // autoUpload 状态图标（点击切换）
    this.autoUploadIndicator = new AutoUploadIndicator(
      this,
      () => this.settings.autoUpload,
      async () => this.lifecycle.run(async () => {
        const previous = this.settings.autoUpload;
        this.settings.autoUpload = !this.settings.autoUpload;
        try {
          await this.saveSettings();
          new Notice(this.settings.autoUpload ? "自动上传已开启" : "自动上传已暂停");
        } catch (error) {
          this.settings.autoUpload = previous;
          new Notice(`自动上传设置保存失败：${(error as Error).message}`);
        }
      }),
    );

    // 拦截路径失败重试指示器（延后绑定，避免与 interceptor 循环引用）
    const persistedRetries = Object.values(this.settings.pendingUploads)
      .filter((pending) => Boolean(pending.localPath ?? pending.stagingPath))
      .map((pending) => ({
        tempId: pending.tempId,
        mdPath: pending.sourcePath,
        localPath: pending.localPath ?? pending.stagingPath!,
        ext: pending.ext,
        occurrenceId: pending.occurrenceId,
      }));
    this.retryIndicator = new RetryIndicator(
      this,
      async (entries) => this.lifecycle.run(() => this.interceptor.retryEntries(entries)),
      persistedRetries,
    );

    this.interceptor = new AttachmentInterceptor(
      this,
      this.uploadManager,
      this.settings,
      this.progressBar,
      this.retryIndicator,
      this.lifecycle,
    );
    this.interceptor.registerEditorEvents();

    let layoutDisposed = false;
    // create 兜底必须等布局就绪，避免 Obsidian 为历史文件补发 create。
    this.app.workspace.onLayoutReady(() => {
      if (layoutDisposed || !this.lifecycle.isActive) return;
      this.interceptor.registerCreateFallback();
      this.deleteWatcher.register();
    });

    this.registerMarkdownPostProcessor(
      createOssPostProcessor(
        this.settings,
        this.urlResolver,
        undefined,
        this.attachmentContextMenu,
        this.renderLifetime,
      ),
    );

    let renderObserver: MutationObserver | null = null;
    this.app.workspace.onLayoutReady(() => {
      if (layoutDisposed || !this.lifecycle.isActive) return;
      renderObserver = new MutationObserver((records) => {
        disposeRemovedOssRenderSessions(records, this.attachmentContextMenu);
        for (const root of selectMutationRoots(records)) {
          void hydrateOssSubtree(
            root,
            this.urlResolver,
            undefined,
            this.attachmentContextMenu,
            this.renderLifetime,
          );
        }
      });
      renderObserver.observe(this.app.workspace.containerEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "href"],
      });
      for (const root of findRenderSurfaces(this.app.workspace.containerEl)) {
        void hydrateOssSubtree(
          root,
          this.urlResolver,
          undefined,
          this.attachmentContextMenu,
          this.renderLifetime,
        );
      }
    });
    this.register(() => {
      layoutDisposed = true;
      renderObserver?.disconnect();
      this.urlResolver.dispose();
      this.renderLifetime.dispose();
      disposeOssRenderSessions(this.app.workspace.containerEl, this.attachmentContextMenu);
      this.attachmentContextMenu.dispose();
      disconnectMediaLoading();
      clearHmacKeyCache();
    });

    this.addSettingTab(new OssSettingTab(this.app, this));

    this.addCommand({
      id: "test-oss-connection",
      name: "测试 OSS 连接",
      callback: () => void this.lifecycle.run(() => this.testConnection()).catch((error) => {
        if (!(error instanceof LifecycleQuiescedError)) console.warn("[oss] 连接测试失败", error);
      }),
    });

    this.addCommand({
      id: "cleanup-orphan-uploads",
      name: "清理孤儿分片上传",
      callback: () => {
        if (!this.requireConfigured()) return;
        void this.lifecycle.run(() => this.uploadManager.cleanupOrphans()).catch((error) => {
          if (error instanceof LifecycleQuiescedError) return;
          console.warn("[oss] 清理孤儿分片失败", error);
          new Notice(`清理失败：${(error as Error).message}`);
        });
      },
    });

    this.addCommand({
      id: "retry-pending-uploads",
      name: "重试未完成上传任务",
      callback: () => void this.lifecycle.run(() => this.retryPendingUploads()).catch((error) => {
        if (!(error instanceof LifecycleQuiescedError)) console.warn("[oss-retry] 命令失败", error);
      }),
    });

    this.addCommand({
      id: "audit-oss-object-references",
      name: "核验 OSS 对象引用",
      callback: () => {
        if (!this.requireConfigured()) return;
        const prefix = `${normalizeObjectKeyPrefix(this.settings.objectKeyPrefix)}/`;
        void this.lifecycle.run(() => runObjectAudit({
          app: this.app,
          vault: this.app.vault,
          client: this.client,
          prefix,
          pendingUploads: this.settings.pendingUploads,
          lifecycle: this.lifecycle,
        })).catch((error) => {
          if (!(error instanceof LifecycleQuiescedError)) console.warn("[oss-audit] 命令失败", error);
        });
      },
    });

    this.addCommand({
      id: "migrate-all-attachments",
      name: "迁移所有本地附件到 OSS",
      callback: () => {
        if (this.requireConfigured()) {
          void this.lifecycle.run(() => migrateAttachments(
            this,
            this.uploadManager,
            undefined,
            this.lifecycle,
          )).catch((error) => {
            if (!(error instanceof LifecycleQuiescedError)) console.warn("[oss-migrate] 命令失败", error);
          });
        }
      },
    });

    this.addCommand({
      id: "migrate-folder-attachments",
      name: "迁移指定文件夹附件到 OSS",
      callback: () => {
        if (this.requireConfigured()) this.pickFolderAndMigrate();
      },
    });
  }

  onunload(): void {
    this.unloading = true;
    this.lifecycle?.quiesce();
    void this.lifecycle?.drain();
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
    // 清理旧版已废弃的配置。
    const legacy = this.settings as unknown as Record<string, unknown>;
    let migrated = false;
    const loadedPrefix = resolveLoadedObjectKeyPrefix(
      raw !== null,
      raw?.objectKeyPrefix,
      Object.values(raw?.pendingUploads ?? {})
        .map((pending) => pending.storageIdentity?.objectKeyPrefix)
        .filter((prefix): prefix is string => typeof prefix === "string"),
      this.app.vault.getName(),
    );
    if (loadedPrefix !== this.settings.objectKeyPrefix) {
      this.settings.objectKeyPrefix = loadedPrefix;
      migrated = true;
    }
    if ("cname" in legacy) {
      delete legacy.cname;
      migrated = true;
    }
    if ("ossReferenceIndex" in legacy) {
      delete legacy.ossReferenceIndex;
      migrated = true;
    }
    if ("ossReferenceIndexRebuiltAt" in legacy) {
      delete legacy.ossReferenceIndexRebuiltAt;
      migrated = true;
    }

    // Canonicalize only equivalent DNS/signing representations. Object Key
    // prefix bytes are an immutable storage identity and must never be trimmed
    // or slash-normalized while loading legacy data.
    try {
      const region = normalizeStorageIdentity({
        ...this.settings,
        // DNS/signing fields can be migrated independently from a legacy
        // Object Key prefix that is now intentionally rejected for new uploads.
        objectKeyPrefix: "obsidian",
      });
      for (const key of ["region", "bucketName", "endpoint"] as const) {
        if (this.settings[key] !== region[key]) {
          this.settings[key] = region[key];
          migrated = true;
        }
      }
    } catch {
      // Keep incomplete/invalid drafts editable in the setting tab.
    }
    const accessKeyId = String(this.settings.accessKeyId ?? "").trim();
    const accessKeySecret = String(this.settings.accessKeySecret ?? "").trim();
    if (accessKeyId !== this.settings.accessKeyId) {
      this.settings.accessKeyId = accessKeyId;
      migrated = true;
    }
    if (accessKeySecret !== this.settings.accessKeySecret) {
      this.settings.accessKeySecret = accessKeySecret;
      migrated = true;
    }
    try {
      const expiry = normalizeSignedUrlExpiry(Number(this.settings.signedUrlExpireSeconds));
      if (expiry !== this.settings.signedUrlExpireSeconds) {
        this.settings.signedUrlExpireSeconds = expiry;
        migrated = true;
      }
    } catch {
      // Invalid legacy values are surfaced and repaired through verified settings save.
    }
    // 兼容缺失字段
    if (!this.settings.pendingUploads) this.settings.pendingUploads = {};
    if (this.settings.autoUpload === undefined) this.settings.autoUpload = true;
    if (migrated) await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(this.settings)) as PluginSettings;
    await this.lifecycle.enqueuePersistence(() => this.saveData(snapshot));
  }

  /** Atomically switch every runtime consumer after a verified configuration change. */
  async applyVerifiedConfig(config: NormalizedOssConfig): Promise<void> {
    this.lifecycle.assertActive("保存配置");
    const currentIdentity = establishedStorageIdentityKey(this.settings);
    if (currentIdentity && currentIdentity !== storageIdentityKey(config)) {
      throw new Error("不能静默切换存储身份：历史 oss:// 引用无法区分 Bucket");
    }
    if (!currentIdentity && Object.keys(this.settings.pendingUploads).length > 0) {
      throw new Error("未完成任务的存储身份无法确认，请恢复原配置后重试");
    }

    const previous: NormalizedOssConfig = {
      region: this.settings.region,
      bucketName: this.settings.bucketName,
      accessKeyId: this.settings.accessKeyId,
      accessKeySecret: this.settings.accessKeySecret,
      endpoint: this.settings.endpoint,
      objectKeyPrefix: this.settings.objectKeyPrefix,
      signedUrlExpireSeconds: this.settings.signedUrlExpireSeconds,
    };
    this.installRuntimeConfig(config);
    try {
      await this.saveSettings();
    } catch (error) {
      this.installRuntimeConfig(previous);
      throw error;
    }
  }

  async retryPendingUploads(): Promise<void> {
    if (!this.requireConfigured()) return;
    if (Object.keys(this.settings.pendingUploads).length === 0) {
      new Notice("当前没有未完成上传任务");
      return;
    }
    try {
      await this.interceptor.retryPending();
      new Notice("未完成上传任务已处理");
    } catch (error) {
      console.warn("[oss-retry] 手动恢复仍有失败", error);
      new Notice((error as Error).message);
    }
  }

  isConfigured(): boolean {
    try {
      normalizeOssConfig(this.settings);
      return true;
    } catch {
      return false;
    }
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
      new Notice(formatCredentialError(err, this.client.signedUrlHost));
    }
  }

  private installRuntimeConfig(config: NormalizedOssConfig): void {
    this.lifecycle.assertActive("切换运行配置");
    // Invalidate signing synchronously before the first persistence await.
    this.urlResolver.clear();
    clearHmacKeyCache();
    Object.assign(this.settings, config);
    this.client = this.createRuntimeClient(this.settings);
    this.uploadManager.setClient(this.client);
    this.deleteWatcher.setClient(this.client);
    void resetOssRenderLifetime(
      this.renderLifetime,
      this.urlResolver,
      undefined,
      this.attachmentContextMenu,
    ).catch((error) => console.warn("[oss-render] 配置切换后刷新附件失败", error));
  }

  private requireConfigured(): boolean {
    if (this.isConfigured()) return true;
    new Notice("OSS 配置无效：请在设置页填写并通过保存校验");
    return false;
  }

  private createRuntimeClient(settings: PluginSettings): OssClient {
    try {
      return new OssClient(
        settings,
        undefined,
        undefined,
        () => {
          this.lifecycle.assertActive("发送 OSS 请求");
          // Object operations may target legacy keys with a now-invalid prefix,
          // but connection, credentials and URL lease settings must always be
          // valid at the final send boundary.
          normalizeOssConfig({ ...settings, objectKeyPrefix: "obsidian" });
        },
      );
    } catch (error) {
      console.warn("[oss] 已保存的 OSS 地址配置无效，运行期客户端已禁用并等待用户修复", error);
      const message = error instanceof Error ? error.message : String(error);
      return new OssClient(
        {
          ...settings,
          bucketName: "invalid-configuration",
          region: DEFAULT_SETTINGS.region,
          endpoint: "",
        },
        undefined,
        undefined,
        () => {
          this.lifecycle.assertActive("发送 OSS 请求");
          throw new Error(`OSS 配置无效，已阻止网络请求：${message}`);
        },
      );
    }
  }

  private pickFolderAndMigrate(): void {
    const folders = getAllFolders(this.app.vault.getRoot());
    new FolderSuggestModal(this.app, folders, (folder) => {
      void this.lifecycle.run(() => migrateAttachments(
        this,
        this.uploadManager,
        folder.path,
        this.lifecycle,
      )).catch((error) => {
        if (!(error instanceof LifecycleQuiescedError)) console.warn("[oss-migrate] 文件夹迁移失败", error);
      });
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
