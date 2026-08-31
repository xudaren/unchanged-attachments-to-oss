import { FuzzySuggestModal, Notice, Plugin, TFolder } from "obsidian";
import {
  accessHostFor,
  establishedStorageIdentityKey,
  NormalizedOssConfig,
  normalizeCustomDomain,
  normalizeOssConfig,
  normalizeObjectKeyPrefix,
  normalizeSignedUrlExpiry,
  normalizeStorageIdentity,
  recognitionAccessHosts,
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
import { LocalInsuranceCopiesModal } from "./upload/local-copies";
import { OssAttachmentContextMenu } from "./render/context-menu";
import { getOssReferenceHost, setOssReferenceHost, setOssReferenceHosts } from "./reference/codec";
import { normalizeVaultReferencesToAccessHost } from "./reference/convert";
import { disconnectMediaLoading } from "./render/media-loading";
import { clearUploadingProgressBus } from "./render/uploading-placeholder";
import { runObjectAudit } from "./audit/modal";
import { LifecycleQuiescedError, PluginLifecycle } from "./lifecycle";
import {
  decryptCredentials,
  encryptCredentials,
  EncryptedCredentials,
  credentialPromptMode,
  isEncryptedCredentials,
  reencryptCredentials,
} from "./credentials";
import { createPersistedSettingsSnapshot, persistOrRetry } from "./persistence";
import { CredentialStartupModal } from "./credential-modal";

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
  private credentialKey: CryptoKey | null = null;
  private legacyPlaintextLoaded = false;
  private credentialStartupModal: CredentialStartupModal | null = null;

  async onload(): Promise<void> {
    // Register before the first await: this instance can itself be disabled
    // while waiting for an older hot-reload generation to drain.
    this.register(() => {
      this.unloading = true;
      this.clearRuntimeCredentials();
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
        // Public-read rendering needs only the immutable storage identity: no
        // AK/SK, so media stays visible while credentials remain locked.
        if (this.settings.publicRead) {
          const identity = normalizeStorageIdentity({
            ...this.settings,
            objectKeyPrefix: "obsidian",
          });
          return {
            bucket: identity.bucketName,
            host: this.accessHost(identity.bucketName, identity.endpoint),
            region: identity.region,
            accessKeyId: "",
            accessKeySecret: "",
            expireSeconds: Number(this.settings.signedUrlExpireSeconds),
            publicRead: true,
          };
        }
        // Rendering remains available for legacy Object Key prefixes, but every
        // connection/signing field must still validate before an HTTPS URL can
        // replace the durable oss:// source.
        const config = normalizeOssConfig({
          ...this.settings,
          objectKeyPrefix: "obsidian",
        });
        return {
          bucket: config.bucketName,
          host: this.accessHost(config.bucketName, config.endpoint),
          region: config.region,
          accessKeyId: config.accessKeyId,
          accessKeySecret: config.accessKeySecret,
          expireSeconds: config.signedUrlExpireSeconds,
          publicRead: false,
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
      clearUploadingProgressBus();
      clearHmacKeyCache();
    });

    this.addSettingTab(new OssSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      if (!this.lifecycle.isActive) return;
      this.openCredentialStartupPrompt();
    });
    this.register(() => {
      this.credentialStartupModal?.close();
      this.credentialStartupModal = null;
    });

    this.addCommand({
      id: "test-oss-connection",
      name: "测试 OSS 连接",
      callback: () => this.testConnectionCommand(),
    });

    this.addCommand({
      id: "cleanup-orphan-uploads",
      name: "清理孤儿分片上传",
      callback: () => this.cleanupOrphanUploads(),
    });

    this.addCommand({
      id: "retry-pending-uploads",
      name: "重试未完成上传任务",
      callback: () => void this.lifecycle.run(() => this.retryPendingUploads()).catch((error) => {
        if (!(error instanceof LifecycleQuiescedError)) console.warn("[oss-retry] 命令失败", error);
      }),
    });

    this.addCommand({
      id: "manage-local-insurance-copies",
      name: "管理本地保险副本",
      callback: () => this.openLocalInsuranceCopies(),
    });

    this.addCommand({
      id: "audit-oss-object-references",
      name: "核验 OSS 对象引用",
      callback: () => this.auditObjectReferences(),
    });

    this.addCommand({
      id: "migrate-all-attachments",
      name: "迁移所有本地附件到 OSS",
      callback: () => this.migrateAllAttachments(),
    });

    this.addCommand({
      id: "migrate-folder-attachments",
      name: "迁移指定文件夹附件到 OSS",
      callback: () => this.pickFolderAndMigrate(),
    });

    this.addCommand({
      id: "convert-oss-references-to-public-urls",
      name: "将所有引用归一到当前访问域名",
      callback: () => void this.normalizeReferencesToAccessHost(),
    });
  }

  /** 测试连接：设置页按钮与命令面板共用入口 */
  testConnectionCommand(): void {
    void this.lifecycle.run(() => this.testConnection()).catch((error) => {
      if (!(error instanceof LifecycleQuiescedError)) console.warn("[oss] 连接测试失败", error);
    });
  }

  /** 清理孤儿分片：设置页按钮与命令面板共用入口 */
  cleanupOrphanUploads(): void {
    if (!this.requireConfigured()) return;
    void this.lifecycle.run(() => this.uploadManager.cleanupOrphans()).catch((error) => {
      if (error instanceof LifecycleQuiescedError) return;
      console.warn("[oss] 清理孤儿分片失败", error);
      new Notice(`清理失败：${(error as Error).message}`);
    });
  }

  /** 核验 OSS 对象引用：设置页按钮与命令面板共用入口 */
  auditObjectReferences(): void {
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
  }

  /** 迁移所有本地附件：设置页按钮与命令面板共用入口 */
  migrateAllAttachments(): void {
    if (!this.requireConfigured()) return;
    void this.lifecycle.run(() => migrateAttachments(
      this,
      this.uploadManager,
      undefined,
      this.lifecycle,
    )).catch((error) => {
      if (!(error instanceof LifecycleQuiescedError)) console.warn("[oss-migrate] 命令失败", error);
    });
  }

  /** One-shot idempotent rewrite of legacy and retired-host references to the current access host. */
  async normalizeReferencesToAccessHost(): Promise<void> {
    const host = getOssReferenceHost();
    if (!host) {
      new Notice("存储身份未就绪：请先完成 Bucket 配置");
      return;
    }
    try {
      await this.lifecycle.run(async () => {
        const notice = new Notice("正在归一 OSS 引用…", 0);
        try {
          const result = await normalizeVaultReferencesToAccessHost(
            this.app.vault,
            host,
            { shouldContinue: () => this.lifecycle.isActive },
          );
          const failures = result.failedPaths.length > 0
            ? `，${result.failedPaths.length} 个文件读取失败未处理`
            : "";
          notice.setMessage(`已归一 ${result.converted} 个文档（共扫描 ${result.scanned} 个）${failures}`);
        } finally {
          window.setTimeout(() => notice.hide(), 8000);
        }
      });
    } catch (error) {
      if (!(error instanceof LifecycleQuiescedError)) console.warn("[oss] 引用归一失败", error);
    }
  }

  onunload(): void {
    this.unloading = true;
    this.clearRuntimeCredentials();
    this.lifecycle?.quiesce();
    void this.lifecycle?.drain();
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<PluginSettings> | null;
    this.legacyPlaintextLoaded = !raw?.encryptedCredentials && Boolean(
      raw?.accessKeyId || raw?.accessKeySecret,
    );
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
    const encrypted = raw?.encryptedCredentials;
    if (encrypted !== undefined && !isEncryptedCredentials(encrypted)) {
      this.settings.encryptedCredentials = encrypted;
      this.settings.accessKeyId = "";
      this.settings.accessKeySecret = "";
    } else if (encrypted) {
      this.settings.encryptedCredentials = encrypted;
      // A synced ciphertext always wins over any stale legacy plaintext fields.
      this.settings.accessKeyId = "";
      this.settings.accessKeySecret = "";
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
    if (!Array.isArray(this.settings.retiredAccessDomains)) this.settings.retiredAccessDomains = [];
    if (this.settings.autoUpload === undefined) this.settings.autoUpload = true;
    if (this.settings.publicRead === undefined) this.settings.publicRead = false;
    this.installReferenceHost();
    if (migrated) await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    // This is the final persistence boundary. Legacy plaintext is preserved only
    // until its verified encrypted replacement is durably written.
    const snapshot = createPersistedSettingsSnapshot(this.settings, this.legacyPlaintextLoaded);
    await this.lifecycle.enqueuePersistence(() => this.saveData(snapshot));
  }

  /** Atomically switch every runtime consumer after a verified configuration change. */
  async applyVerifiedConfig(config: NormalizedOssConfig, masterPassword?: string): Promise<void> {
    this.lifecycle.assertActive("保存配置");
    const currentIdentity = establishedStorageIdentityKey(this.settings);
    if (currentIdentity && currentIdentity !== storageIdentityKey(config)) {
      throw new Error("不能静默切换存储身份：历史 oss:// 引用无法区分 Bucket");
    }
    if (!currentIdentity && Object.keys(this.settings.pendingUploads).length > 0) {
      throw new Error("未完成任务的存储身份无法确认，请恢复原配置后重试");
    }

    const previousEncrypted = this.settings.encryptedCredentials;
    let encrypted: EncryptedCredentials;
    let nextKey = this.credentialKey;
    if (nextKey && previousEncrypted) {
      encrypted = await reencryptCredentials(config, nextKey, previousEncrypted);
    } else {
      if (!masterPassword) throw new Error("请设置主密码后再保存凭证");
      const created = await encryptCredentials(config, masterPassword);
      encrypted = created.encrypted;
      nextKey = created.key;
    }
    this.settings.encryptedCredentials = encrypted;
    this.credentialKey = nextKey;
    this.legacyPlaintextLoaded = false;
    this.installRuntimeConfig(config);
    // Persist with an immediate retry. A single transient save failure can
    // leave disk holding a partial new ciphertext; retrying before any
    // memory rollback keeps disk aligned with the in-memory key, so a later
    // reload can still decrypt persisted state.
    await persistOrRetry(() => this.saveSettings());
  }

  /** Toggle public-read rendering: pure render decision, no credential or client change. */
  async applyPublicReadChange(enabled: boolean): Promise<void> {
    this.lifecycle.assertActive("切换公共读渲染");
    const previous = this.settings.publicRead;
    this.settings.publicRead = enabled;
    this.urlResolver.clear();
    clearHmacKeyCache();
    try {
      await persistOrRetry(() => this.saveSettings());
    } catch (error) {
      // Roll the in-memory toggle back so the settings UI reset reflects the
      // real state, and bump the generation again so no resolver keeps the
      // unpersisted mode.
      this.settings.publicRead = previous;
      this.urlResolver.clear();
      throw error;
    }
    void resetOssRenderLifetime(
      this.renderLifetime,
      this.urlResolver,
      undefined,
      this.attachmentContextMenu,
    ).catch((error) => console.warn("[oss-render] 公共读切换后刷新附件失败", error));
  }

  /** Switch the browser access host: pure access decision, no credential or client change. */
  async applyCustomDomainChange(domain: string): Promise<void> {
    this.lifecycle.assertActive("切换访问域名");
    const normalized = normalizeCustomDomain(domain);
    const previous = this.settings.customDomain;
    if (normalized === previous) return;
    const previousRetired = this.settings.retiredAccessDomains;
    this.settings.customDomain = normalized;
    // The outgoing domain stays recognizable so the normalize command can
    // still migrate its references; rendering prefers the new access host.
    if (previous && !previousRetired.includes(previous)) {
      this.settings.retiredAccessDomains = [...previousRetired, previous];
    }
    // Invalidate signing synchronously before the first persistence await.
    this.urlResolver.clear();
    clearHmacKeyCache();
    try {
      await persistOrRetry(() => this.saveSettings());
    } catch (error) {
      // Roll back so the settings input reflects the real state, then restore
      // the previous recognition hosts.
      this.settings.customDomain = previous;
      this.settings.retiredAccessDomains = previousRetired;
      this.urlResolver.clear();
      this.installReferenceHost();
      throw error;
    }
    this.installReferenceHost();
    void resetOssRenderLifetime(
      this.renderLifetime,
      this.urlResolver,
      undefined,
      this.attachmentContextMenu,
    ).catch((error) => console.warn("[oss-render] 访问域名切换后刷新附件失败", error));
    if (normalized) {
      new Notice("访问域名已切换：如需迁移存量引用，请运行命令「将所有引用归一到当前访问域名」");
    }
  }

  hasEncryptedCredentials(): boolean {
    return this.settings.encryptedCredentials !== undefined;
  }

  isCredentialsLocked(): boolean {
    return this.hasEncryptedCredentials() && this.credentialKey === null;
  }

  needsCredentialEncryption(): boolean {
    return !this.hasEncryptedCredentials() && Boolean(
      this.settings.accessKeyId || this.settings.accessKeySecret,
    );
  }

  async unlockCredentials(masterPassword: string): Promise<void> {
    this.lifecycle.assertActive("解锁 OSS 凭证");
    const encrypted = this.settings.encryptedCredentials;
    if (!encrypted) throw new Error("当前没有可解锁的加密凭证");
    const unlocked = await decryptCredentials(encrypted, masterPassword);
    this.lifecycle.assertActive("应用已解锁 OSS 凭证");
    const config = normalizeOssConfig({ ...this.settings, ...unlocked.credentials });
    this.credentialKey = unlocked.key;
    this.installRuntimeConfig(config);
  }

  async migrateLegacyCredentials(masterPassword: string): Promise<void> {
    this.lifecycle.assertActive("迁移旧版 OSS 凭证");
    if (!this.needsCredentialEncryption()) throw new Error("没有需要迁移的旧版明文凭证");
    const config = normalizeOssConfig(this.settings);
    await this.client.verifyCredentials();
    this.lifecycle.assertActive("加密旧版 OSS 凭证");
    await this.applyVerifiedConfig(config, masterPassword);
  }

  lockCredentials(): void {
    if (!this.settings.encryptedCredentials) return;
    this.clearRuntimeCredentials();
    this.installRuntimeConfig({
      ...this.settings,
      accessKeyId: "",
      accessKeySecret: "",
    });
  }

  private openCredentialStartupPrompt(): void {
    if (this.credentialStartupModal) return;
    const mode = credentialPromptMode({
      hasEncryptedCredentials: this.hasEncryptedCredentials(),
      hasRuntimeCredentials: Boolean(this.settings.accessKeyId || this.settings.accessKeySecret),
      isUnlocked: !this.isCredentialsLocked(),
    });
    if (!mode) return;
    const modal = new CredentialStartupModal(
      this.app,
      mode,
      (password) => this.lifecycle.run(() => mode === "unlock"
        ? this.unlockCredentials(password)
        : this.migrateLegacyCredentials(password)),
      () => {
        if (this.credentialStartupModal === modal) this.credentialStartupModal = null;
      },
    );
    this.credentialStartupModal = modal;
    modal.open();
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

  openLocalInsuranceCopies(): void {
    this.lifecycle.assertActive("管理本地保险副本");
    new LocalInsuranceCopiesModal(
      this.app,
      this.app.vault,
      () => this.settings.pendingUploads,
      {
        retryTasks: () => this.retryPendingUploads(),
        restore: (path) => this.interceptor.restoreInsuranceCopy(path),
        remove: (path) => this.interceptor.deleteUnclaimedInsuranceCopy(path),
      },
      this.lifecycle,
    ).open();
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
    if (this.isCredentialsLocked()) {
      new Notice("凭证已锁定：请先输入主密码解锁后再测试连接");
      return;
    }
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
    this.installReferenceHost();
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

  /**
   * Publish the access host (custom domain, else the default host) for
   * formatting, and keep the permanent default host plus every retired access
   * host recognizable so existing references survive an access-host change.
   */
  private installReferenceHost(): void {
    const { bucketName, endpoint } = this.settings;
    const defaultHost = bucketName && endpoint ? `${bucketName}.${endpoint}` : "";
    const accessHost = this.accessHost(bucketName, endpoint);
    const recognized = recognitionAccessHosts(
      accessHost,
      defaultHost,
      this.settings.retiredAccessDomains ?? [],
    );
    try {
      setOssReferenceHosts(accessHost, recognized);
    } catch {
      setOssReferenceHost("");
    }
  }

  /** Browser-facing access host; an invalid stored domain falls back to the default host. */
  private accessHost(bucketName: string, endpoint: string): string {
    try {
      return accessHostFor(bucketName, endpoint, this.settings.customDomain);
    } catch {
      return bucketName && endpoint ? `${bucketName}.${endpoint}` : "";
    }
  }

  private clearRuntimeCredentials(): void {
    this.credentialKey = null;
    if (!this.settings) return;
    this.settings.accessKeyId = "";
    this.settings.accessKeySecret = "";
    clearHmacKeyCache();
  }

  private requireConfigured(): boolean {
    if (this.isConfigured()) return true;
    if (this.isCredentialsLocked()) {
      new Notice("凭证已锁定：请先输入主密码解锁后再执行该操作");
      return false;
    }
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

  /** 迁移指定文件夹附件：设置页按钮与命令面板共用入口 */
  pickFolderAndMigrate(): void {
    if (!this.requireConfigured()) return;
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
