import {
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  Vault,
} from "obsidian";
import { normalizeError } from "../error";
import { formatOssReference } from "../reference/codec";
import { LifecycleGate, LifecycleQuiescedError } from "../lifecycle";
import { PendingReferenceLocator, PendingUpload, PluginSettings, isSupportedExt } from "../types";
import { RetryBatchResult, RetryEntry, RetryIndicator } from "./indicator";
import {
  AttachmentOccurrence,
  findResolvedAttachmentOccurrences,
  hasOssReference,
  replaceOneResolvedAttachmentReference,
  replaceUploadingPlaceholder,
  ResolvedAttachmentBacklinkCache,
  StableOccurrenceResult,
  waitForStableAttachmentOccurrences,
} from "./links";
import {
  AutoUploadPausedError,
  isLifecycleUploadPause,
  UploadManager,
  UploadPausedError,
} from "./manager";
import { UploadProgressBar } from "./progress";
import { isCopyClaimed } from "./local-copies";
import {
  attachmentExtension,
  captureAttachment,
  clipboardFiles,
  errorMessage,
  formatAttachmentSize,
  formatInputReadError,
  formatInputReadFailureMarker,
  isInternalStagingPath,
  isOversizedOnMobile,
  shouldKeepInputLocal,
  STAGING_DIR,
} from "./input";

export {
  captureAttachment,
  clipboardFiles,
  formatInputReadError,
  formatInputReadFailureMarker,
  isInternalStagingPath,
  isOversizedOnMobile,
  STAGING_DIR,
} from "./input";

interface PreparedInput {
  file: File;
  tempId: string;
  placeholder: string;
  sourcePath: string;
  locator: PendingReferenceLocator;
}

interface StagedInput extends PreparedInput {
  name: string;
  type: string;
  ext: string;
  size: number;
  /** Stable in-memory snapshot for this run; staging is the crash-recovery copy. */
  blob: Blob;
  stagingPath: string;
  sourceMtime?: number;
}

class InputDurabilityError extends Error {
  constructor(
    public readonly input: StagedInput,
    public readonly originalError: unknown,
  ) {
    super(`无法持久化输入附件：${errorMessage(originalError)}`);
    this.name = "InputDurabilityError";
  }
}

/** Owns input staging, upload scheduling, reference commit and local cleanup. */
export class AttachmentInterceptor {
  private editorEventsRegistered = false;
  private fallbackRegistered = false;
  private disposed = false;
  private readonly backlinks: ResolvedAttachmentBacklinkCache;
  private readonly suppressedLocalPaths = new Set<string>();
  private stagingFolderReady: Promise<void> | null = null;
  private metadataResolutionTracking = false;
  private fallbackTail: Promise<void> = Promise.resolve();
  private stagingRecovery: Promise<void> = Promise.resolve();

  constructor(
    private readonly plugin: Plugin,
    private readonly manager: UploadManager,
    private readonly settings: PluginSettings,
    private readonly progress?: UploadProgressBar,
    private readonly retryIndicator?: RetryIndicator,
    private readonly lifecycle?: LifecycleGate,
  ) {
    this.backlinks = new ResolvedAttachmentBacklinkCache(plugin.app.metadataCache);
  }

  registerEditorEvents(): void {
    if (this.editorEventsRegistered) return;
    this.editorEventsRegistered = true;
    this.metadataResolutionTracking = true;
    this.plugin.registerEvent(this.plugin.app.workspace.on("editor-paste", (event, editor, view) => {
      if (event.defaultPrevented || !(view instanceof MarkdownView)) return;
      const files = clipboardFiles(event);
      if (!this.shouldTakeOver(files)) return;
      event.preventDefault();
      this.startRoot(() => this.takeOverInput(files, event, editor, view), "粘贴附件");
    }));
    this.plugin.registerEvent(this.plugin.app.workspace.on("editor-drop", (event, editor, view) => {
      if (event.defaultPrevented || !(view instanceof MarkdownView)) return;
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!this.shouldTakeOver(files)) return;
      event.preventDefault();
      this.startRoot(() => this.takeOverInput(files, event, editor, view), "拖入附件");
    }));
    this.plugin.registerEvent(this.plugin.app.metadataCache.on("resolved", () => this.backlinks.markResolved()));
    this.plugin.registerEvent(this.plugin.app.vault.on("rename", () => this.backlinks.invalidate()));
    this.plugin.registerEvent(this.plugin.app.vault.on("delete", () => this.backlinks.invalidate()));
    this.plugin.register(() => { this.disposed = true; });
    const recovery = this.lifecycle
      ? this.lifecycle.run(() => this.recoverUnjournaledStaging())
      : this.recoverUnjournaledStaging();
    this.stagingRecovery = recovery.then(() => undefined, (error) => {
      if (error instanceof LifecycleQuiescedError) return;
      console.error("[oss] 启动恢复裸 staging 失败", error);
      new Notice("检测到未登记的 staging，但自动恢复失败；文件仍保留在隐藏 staging 目录");
    });
  }

  registerCreateFallback(): void {
    if (this.fallbackRegistered || this.disposed) return;
    this.fallbackRegistered = true;
    this.plugin.registerEvent(this.plugin.app.vault.on("create", (file) => {
      const factory = () => {
        const run = this.fallbackTail.then(() => {
          this.lifecycle?.assertActive("处理新落地附件");
          if (!(file instanceof TFile)) return;
          return this.handleCreate(file);
        });
        return run;
      };
      const run = this.lifecycle ? this.lifecycle.run(factory) : factory();
      this.fallbackTail = run.catch((error) => {
        if (error instanceof LifecycleQuiescedError) return;
        console.error("[oss] create 兜底失败", error);
        new Notice(`附件自动上传失败，已保留本地：${errorMessage(error)}`);
      });
    }));
  }

  private shouldTakeOver(files: File[]): boolean {
    if (!this.settings.autoUpload || !this.canTakeOver(files)) return false;
    if (shouldKeepInputLocal(files)) {
      new Notice("本批附件超过移动端安全内存上限，已交给 Obsidian 本地保存，不会自动发起网络上传");
      return false;
    }
    return true;
  }

  private canTakeOver(files: File[]): boolean {
    return files.length > 0 && files.every((file) => isSupportedExt(attachmentExtension(file.name, file.type)));
  }

  private async takeOverInput(
    files: File[],
    event: ClipboardEvent | DragEvent,
    editor: Editor,
    view: MarkdownView,
  ): Promise<void> {
    // Idempotent for real events; also preserves the direct-call contract used by tests.
    event.preventDefault();
    const sourcePath = view.file?.path ?? "";
    const prepared: PreparedInput[] = files.map((file) => {
      const tempId = crypto.randomUUID();
      return {
        file,
        tempId,
        sourcePath,
        placeholder: `![上传中 ${file.name}](oss://uploading/${tempId})`,
        locator: undefined as never,
      };
    });

    // Start every OS-backed File read before returning control to the event source.
    const stagingPromises = prepared.map((input) => this.captureAndStage(input));
    insertAllPlaceholders(editor, prepared);
    const staged = await Promise.allSettled(stagingPromises);
    const ready: StagedInput[] = [];
    // Byte safety is part of the admitted paste/drop operation. Even when the
    // plugin starts quiescing, a captured Blob whose staging/journal failed must
    // still be copied to an ordinary Vault attachment before this root drains.
    for (let index = 0; index < staged.length; index++) {
      const result = staged[index];
      const input = prepared[index];
      if (result.status === "fulfilled") {
        ready.push(result.value);
        continue;
      }
      console.error("[oss] 无法持久化输入附件", result.reason);
      if (result.reason instanceof InputDurabilityError) {
        await this.preserveCapturedAfterDurabilityFailure(
          result.reason.input,
          editor,
          view,
          result.reason.originalError,
        );
      } else if (!this.lifecycle || this.lifecycle.isActive) {
        replaceExactInEditor(editor, input.placeholder, formatInputReadFailureMarker(input.file.name));
        new Notice(formatInputReadError(result.reason));
      }
    }
    // Quiescing still lets every already-captured File reach staging+journal,
    // but no upload, reference write or deletion may follow.
    this.lifecycle?.assertActive("继续处理已持久化附件");
    // Upload one staged file at a time: direct input is already durable, and this
    // keeps mobile/network memory bounded to one attachment plus one 4 MB part.
    for (const input of ready) {
      await this.uploadStagedInput(input, editor, view);
    }
  }

  private async captureAndStage(input: PreparedInput): Promise<StagedInput> {
    const captured = await captureAttachment(input.file);
    // Startup recovery must finish before a new .stage file can appear, or it
    // could mistake the byte-first journal window for a crash orphan.
    await this.stagingRecovery;
    const ext = attachmentExtension(captured.name, captured.type);
    const stagingPath = `${STAGING_DIR}/${input.tempId}.${ext}.stage`;
    const stagedInput: StagedInput = { ...input, ...captured, ext, stagingPath };
    try {
      // Byte safety comes first. A journal must never make a captured File look
      // durable before its stable Vault copy actually exists.
      await this.ensureStagingFolder();
      const adapter = this.plugin.app.vault.adapter;
      await adapter.writeBinary(stagingPath, await captured.blob.arrayBuffer());
      const stagingStat = await adapter.stat(stagingPath);
      if (!stagingStat || stagingStat.type !== "file") {
        throw new Error(`staging 写入后无法读取：${stagingPath}`);
      }
      stagedInput.sourceMtime = stagingStat.mtime;
    } catch (error) {
      throw new InputDurabilityError(stagedInput, error);
    }
    try {
      await this.manager.prepareStagedTask({
        tempId: input.tempId,
        ext,
        size: captured.size,
        sourcePath: input.sourcePath,
        localPath: stagingPath,
        stagingPath,
        displayName: captured.name,
        occurrenceId: input.tempId,
        locator: input.locator,
        sourceMtime: stagedInput.sourceMtime,
      });
    } catch (error) {
      throw new InputDurabilityError(stagedInput, error);
    }
    return stagedInput;
  }

  private async uploadStagedInput(input: StagedInput, editor: Editor, view: MarkdownView): Promise<void> {
    const notice = new Notice(`上传中：${input.name} (${formatAttachmentSize(input.size)})`, 0);
    let tempId = input.tempId;
    let uploadedObjectKey: string | null = null;
    try {
      const uploaded = await this.manager.upload({
        blob: input.blob,
        ext: input.ext,
        sourcePath: input.sourcePath,
        localPath: input.stagingPath,
        stagingPath: input.stagingPath,
        tempId: input.tempId,
        displayName: input.name,
        occurrenceId: input.tempId,
        locator: input.locator,
        sourceMtime: input.sourceMtime,
        automatic: true,
        onProgress: (done, total) => {
          this.progress?.begin(input.name, total);
          this.progress?.advance(done);
        },
      });
      tempId = uploaded.tempId;
      uploadedObjectKey = uploaded.objectKey;
      this.lifecycle?.assertActive("修改附件引用");
      await this.manager.markReferenceCommitting(tempId);
      const finalReference = formatOssReference(uploaded.objectKey, input.name);
      this.lifecycle?.assertActive("修改附件引用");
      let committed = view.file?.path === input.sourcePath &&
        replaceExactInEditor(editor, input.placeholder, finalReference);
      if (committed) {
        if (view.file?.path === input.sourcePath) {
          await view.save();
          committed = await sourceContainsObject(
            this.plugin.app.vault,
            input.sourcePath,
            uploaded.objectKey,
          );
        } else {
          committed = false;
        }
      }
      if (!committed) {
        committed = await replaceUploadingPlaceholder(
          this.plugin.app.vault,
          input.sourcePath,
          input.locator,
          uploaded.objectKey,
          input.name,
          () => this.lifecycle?.assertActive("修改附件引用"),
        );
      }
      if (!committed) throw new Error("上传已完成，但唯一占位符已被修改或删除；staging 已保留");
      await this.manager.markCleanupPending(tempId);
      this.lifecycle?.assertActive("删除本地 staging");
      await this.deleteLocalFile(input.stagingPath, input.size, input.sourceMtime);
      await this.manager.finalizeCleanupForPath(input.stagingPath);
      this.progress?.finish();
      notice.setMessage(`已上传：${input.name}`);
      window.setTimeout(() => notice.hide(), 2000);
    } catch (error) {
      this.progress?.finish();
      notice.hide();
      console.error("[oss] 直传任务失败", error);
      if (error instanceof UploadPausedError && error.reason instanceof AutoUploadPausedError) {
        const paused = this.manager.getPending(tempId);
        if (paused) this.retryIndicator?.push(retryEntryFor(paused));
        new Notice(`自动上传已暂停，staging 与续传进度已保留：${input.name}`);
        return;
      }
      if (isLifecycleUploadPause(error)) {
        const paused = this.manager.getPending(tempId);
        if (paused) this.retryIndicator?.push(retryEntryFor(paused));
        return;
      }
      if (uploadedObjectKey && await sourceContainsObject(
        this.plugin.app.vault,
        input.sourcePath,
        uploadedObjectKey,
      ).catch(() => false)) {
        const committedPending = this.manager.getPending(tempId);
        if (committedPending) this.retryIndicator?.push(retryEntryFor(committedPending));
        new Notice(`附件引用已安全提交；任务日志或 staging 清理将在下次重试：${input.name}`);
        return;
      }
      const pending = this.manager.getPending(tempId);
      if (pending?.phase === "reference_committing" || pending?.phase === "cleanup_pending" ||
          pending?.phase === "uploaded") {
        this.retryIndicator?.push(retryEntryFor(pending));
        new Notice(`OSS 对象已保留，引用或本地清理待重试：${input.name}`);
        return;
      }
      await this.promoteStagingAfterFailure(input, editor, view, error);
    }
  }

  private async promoteStagingAfterFailure(
    input: StagedInput,
    editor: Editor,
    view: MarkdownView,
    uploadError: unknown,
  ): Promise<void> {
    this.lifecycle?.assertActive("回写本地附件");
    let promotedPath: string | null = null;
    try {
      const targetPath = await this.plugin.app.fileManager.getAvailablePathForAttachment(
        input.name || `pasted-${input.tempId}.${input.ext}`,
        input.sourcePath,
      );
      promotedPath = targetPath;
      this.suppressedLocalPaths.add(targetPath);
      this.lifecycle?.assertActive("创建本地恢复附件");
      const localFile = await this.plugin.app.vault.createBinary(
        targetPath,
        await input.blob.arrayBuffer(),
      );
      const promotedMtime = localFile.stat.mtime;
      const generated = this.plugin.app.fileManager.generateMarkdownLink(localFile, input.sourcePath);
      const localReference = generated.startsWith("!") ? generated : `!${generated}`;
      this.lifecycle?.assertActive("修改附件引用");
      let replaced = view.file?.path === input.sourcePath &&
        replaceExactInEditor(editor, input.placeholder, localReference);
      if (replaced) await view.save();
      if (!replaced) replaced = await replaceExactInVault(
        this.plugin.app.vault,
        input.sourcePath,
        input.locator,
        localReference,
        () => this.lifecycle?.assertActive("修改附件引用"),
      );
      const pending = this.manager.getPending(input.tempId);
      let retryPending = pending;
      const recoveryLocator = replaced
        ? await locatePersistedLocalReference(
          this.plugin.app.vault,
          input.sourcePath,
          input.locator,
          localReference,
        )
        : undefined;
      if (pending?.phase === "staged" && !pending.uploadId) {
        // No remote side effect exists. The ordinary local attachment is now
        // the source of truth, so a half-created staging journal is unnecessary.
        await this.manager.discardMissingStagingTask(input.tempId).catch((error) => {
          console.warn("[oss] 无法清除未开始上传的 staging journal", error);
        });
        retryPending = this.manager.getPending(input.tempId);
      } else if (pending) {
        if (!recoveryLocator) throw new Error("本地附件已写入，但无法确认持久化引用位置");
        // Persist the new recoverable source before removing its staging copy.
        await this.manager.bindLocalRecovery(input.tempId, localFile.path, recoveryLocator, promotedMtime);
        retryPending = this.manager.getPending(input.tempId);
      }
      if (replaced) await this.deleteLocalFile(input.stagingPath, input.size, input.sourceMtime);
      if (retryPending) {
        if (!recoveryLocator) throw new Error("引用未安全恢复，staging 已保留");
        await this.manager.bindLocalRecovery(
          input.tempId,
          localFile.path,
          recoveryLocator,
          promotedMtime,
          true,
        ).catch((error) => {
          console.warn("[oss] 已安全回写本地，但 stagingPath journal 清理失败", error);
        });
        this.retryIndicator?.push(retryEntryFor(retryPending, localFile.path));
      } else this.retryIndicator?.push({
        mdPath: input.sourcePath,
        localPath: localFile.path,
        ext: input.ext,
        occurrenceId: input.tempId,
      });
      new Notice(replaced
        ? `上传失败，已安全回写本地：${localFile.path}（可稍后重试）`
        : `上传失败；附件已安全保存到 ${localFile.path}，原占位已被修改，未强行恢复引用`);
    } catch (writeError) {
      console.error("[oss] 本地回写失败，保留 staging 与占位", writeError);
      const pending = this.manager.getPending(input.tempId);
      if (pending) this.retryIndicator?.push(retryEntryFor(pending));
      new Notice(`上传失败且无法写入附件目录；staging 与占位已保留。上传错误：${errorMessage(uploadError)}`);
    } finally {
      if (promotedPath) window.setTimeout(() => this.suppressedLocalPaths.delete(promotedPath!), 1000);
    }
  }

  /** Last-resort durability lane for an input already removed from Obsidian's default flow. */
  private async preserveCapturedAfterDurabilityFailure(
    input: StagedInput,
    editor: Editor,
    view: MarkdownView,
    originalError: unknown,
  ): Promise<void> {
    let targetPath: string | null = null;
    try {
      targetPath = await this.plugin.app.fileManager.getAvailablePathForAttachment(
        input.name || `recovered-${input.tempId}.${input.ext}`,
        input.sourcePath,
      );
      this.suppressedLocalPaths.add(targetPath);
      const localFile = await this.plugin.app.vault.createBinary(
        targetPath,
        await input.blob.arrayBuffer(),
      );
      let replaced = false;
      if (!this.lifecycle || this.lifecycle.isActive) {
        const generated = this.plugin.app.fileManager.generateMarkdownLink(localFile, input.sourcePath);
        const localReference = generated.startsWith("!") ? generated : `!${generated}`;
        this.lifecycle?.assertActive("回写已捕获附件引用");
        replaced = view.file?.path === input.sourcePath &&
          replaceExactInEditor(editor, input.placeholder, localReference);
        if (replaced) await view.save();
        if (!replaced) {
          replaced = await replaceExactInVault(
            this.plugin.app.vault,
            input.sourcePath,
            input.locator,
            localReference,
            () => this.lifecycle?.assertActive("回写已捕获附件引用"),
          );
        }
        if (replaced) {
          this.retryIndicator?.push({
            mdPath: input.sourcePath,
            localPath: localFile.path,
            ext: input.ext,
            occurrenceId: input.tempId,
          });
          const pending = this.manager.getPending(input.tempId);
          if (pending?.phase === "staged" && !pending.uploadId) {
            await this.manager.discardMissingStagingTask(input.tempId).catch((error) => {
              console.warn("[oss] 本地保全后清理未启动 journal 失败", error);
            });
          }
          this.lifecycle?.assertActive("清理已回写的 staging");
          await this.deleteLocalFile(input.stagingPath, input.size, input.sourceMtime);
        }
      }
      new Notice(replaced
        ? `附件持久化异常，已安全回写本地：${localFile.path}`
        : `附件持久化异常，已安全保存到 ${localFile.path}；原占位保留，请重新插入该附件`);
    } catch (recoveryError) {
      console.error("[oss] 已捕获附件的最终本地保全失败", recoveryError, originalError);
      new Notice("附件已读取但 staging 与本地保全均失败；请立即重新粘贴或拖入原文件");
    } finally {
      if (targetPath) window.setTimeout(() => this.suppressedLocalPaths.delete(targetPath!), 1000);
    }
  }

  private async handleCreate(file: TFile): Promise<void> {
    this.lifecycle?.assertActive("处理新落地附件");
    if (!this.settings.autoUpload || this.disposed) return;
    if (!(file instanceof TFile) || !isSupportedExt(file.extension)) return;
    if (isInternalStagingPath(file.path) || this.suppressedLocalPaths.has(file.path)) return;
    if (isOversizedOnMobile(file.stat.size)) {
      new Notice(`附件较大，移动端已保留本地且未自动上传：${file.name}`);
      return;
    }

    const initial = await waitForOccurrences(this.plugin, file, this.backlinks);
    if (initial.length === 0) return;
    const originalSize = file.stat.size;
    const originalMtime = file.stat.mtime;
    const metadataBaseline = this.backlinks.generation;
    const notice = new Notice(`兜底上传：${file.name}`, 0);
    const blob = new Blob([await this.plugin.app.vault.readBinary(file)]);
    let failed = 0;

    for (const occurrence of initial) {
      try {
        await this.uploadAndCommitOccurrence(file, blob, occurrence, originalMtime);
      } catch (error) {
        if (isLifecycleUploadPause(error)) throw error;
        failed++;
        console.error("[oss] 引用实例兜底上传失败", occurrence, error);
        const pending = this.manager.findPendingFor({
          localPath: file.path,
          sourcePath: occurrence.sourcePath,
          occurrenceId: occurrence.occurrenceId,
        });
        this.retryIndicator?.push(pending ? retryEntryFor(pending) : {
          mdPath: occurrence.sourcePath,
          localPath: file.path,
          ext: file.extension,
          occurrenceId: occurrence.occurrenceId,
        });
      }
    }

    const final = await this.finalOccurrences(file, metadataBaseline);
    const remaining = final.occurrences;
    const unchanged = file.stat.size === originalSize && file.stat.mtime === originalMtime;
    if (final.confirmed && failed === 0 && remaining.length === 0 && unchanged) {
      try {
        this.lifecycle?.assertActive("删除已迁移本地附件");
        await this.trashFile(file);
        await this.manager.finalizeCleanupForPath(file.path);
        notice.setMessage(`兜底上传完成：${file.name}（${initial.length} 个独立引用）`);
      } catch {
        notice.setMessage(`OSS 引用已提交，但本地清理失败，可从任务中心重试：${file.name}`);
      }
    } else {
      const reason = !final.confirmed
        ? "MetadataCache 未在安全窗口内稳定，无法确认是否有新增引用"
        : remaining.length > 0
          ? `检测到 ${remaining.length} 个新增/未完成引用`
          : "附件内容已变化";
      notice.setMessage(`兜底上传未清理本地：${failed} 个失败；${reason}`);
    }
    window.setTimeout(() => notice.hide(), 4000);
  }

  private async uploadAndCommitOccurrence(
    file: TFile,
    blob: Blob,
    occurrence: AttachmentOccurrence,
    sourceMtime?: number,
  ): Promise<string> {
    const uploaded = await this.manager.upload({
      blob,
      ext: file.extension,
      sourcePath: occurrence.sourcePath,
      localPath: file.path,
      displayName: file.name,
      occurrenceId: occurrence.occurrenceId,
      locator: occurrence.locator,
      sourceMtime,
      automatic: true,
    });
    const pending = this.manager.getPending(uploaded.tempId);
    if (pending?.phase !== "cleanup_pending") {
      this.lifecycle?.assertActive("修改附件引用");
      await this.manager.markReferenceCommitting(uploaded.tempId);
      const replaced = await replaceOneResolvedAttachmentReference(
        this.plugin.app.vault,
        this.plugin.app.metadataCache,
        file,
        occurrence.sourcePath,
        uploaded.objectKey,
        occurrence,
        () => this.lifecycle?.assertActive("修改附件引用"),
      );
      if (!replaced && !await sourceContainsObject(this.plugin.app.vault, occurrence.sourcePath, uploaded.objectKey)) {
        throw new Error("引用实例未能确认替换");
      }
      await this.manager.markCleanupPending(uploaded.tempId);
    }
    return uploaded.tempId;
  }

  async retryEntries(entries: RetryEntry[]): Promise<RetryBatchResult> {
    this.lifecycle?.assertActive("重试上传任务");
    const succeeded: RetryEntry[] = [];
    const failed: RetryEntry[] = [];
    const affectedPaths = new Set<string>();
    const pathsWithReferenceWrites = new Set<string>();
    const metadataBaselines = new Map(
      entries.map((entry) => [entry.localPath, this.backlinks.generation]),
    );
    for (const entry of dedupeRetryEntries(entries)) {
      const file = this.plugin.app.vault.getAbstractFileByPath(entry.localPath);
      if (!(file instanceof TFile)) {
        const pending = entry.tempId ? this.manager.getPending(entry.tempId) : undefined;
        if (entry.localPath && pending?.phase === "cleanup_pending" &&
            pending.localPath === entry.localPath) {
          await this.manager.ensurePendingStorageIdentity(pending.tempId);
          await this.manager.finalize(entry.tempId!);
          succeeded.push(entry);
        } else {
          console.warn("[oss-retry] 本地源已不存在", entry.localPath);
          failed.push(entry);
        }
        continue;
      }
      if (isOversizedOnMobile(file.stat.size)) {
        failed.push(entry);
        continue;
      }
      try {
        const pendingBefore = entry.tempId
          ? this.manager.getPending(entry.tempId)
          : this.manager.findPendingFor({
            localPath: entry.localPath,
            sourcePath: entry.mdPath,
            occurrenceId: entry.occurrenceId,
          });
        if (pendingBefore) await this.manager.ensurePendingStorageIdentity(pendingBefore.tempId);
        if (pendingBefore?.phase !== "cleanup_pending") {
          const blob = new Blob([await this.plugin.app.vault.readBinary(file)]);
          const uploaded = await this.manager.upload({
            blob,
            ext: entry.ext,
            sourcePath: entry.mdPath,
            localPath: entry.localPath,
            tempId: pendingBefore?.tempId,
            displayName: pendingBefore?.displayName ?? file.name,
            occurrenceId: entry.occurrenceId,
            locator: pendingBefore?.locator,
            sourceMtime: file.stat.mtime,
          });
          const wroteReference = await this.commitRetryReference(
            file,
            uploaded.tempId,
            uploaded.objectKey,
            entry,
            pendingBefore,
          );
          if (wroteReference) pathsWithReferenceWrites.add(file.path);
        }
        affectedPaths.add(file.path);
        succeeded.push(entry);
      } catch (error) {
        if (isLifecycleUploadPause(error)) throw error;
        console.error("[oss-retry] 重试失败", entry, error);
        failed.push(entry);
      }
    }

    for (const localPath of affectedPaths) {
      if (failed.some((entry) => entry.localPath === localPath)) continue;
      const file = this.plugin.app.vault.getAbstractFileByPath(localPath);
      if (!(file instanceof TFile)) continue;
      if (!this.cleanupTasksMatchFile(file)) {
        console.warn("[oss-retry] 本地附件在上传后已变化，拒绝清理", localPath);
        for (const entry of succeeded.filter((item) => item.localPath === localPath)) {
          if (!failed.includes(entry)) failed.push(entry);
        }
        new Notice(`本地附件已变化，已保留且未删除：${localPath}`);
        continue;
      }
      const final = await this.finalOccurrences(
        file,
        metadataBaselines.get(localPath) ?? this.backlinks.generation,
        pathsWithReferenceWrites.has(localPath),
      );
      if (!final.confirmed || final.occurrences.length > 0) {
        for (const entry of succeeded.filter((item) => item.localPath === localPath)) {
          if (!failed.includes(entry)) failed.push(entry);
        }
        continue;
      }
      const currentFile = this.plugin.app.vault.getAbstractFileByPath(localPath);
      if (!(currentFile instanceof TFile) || !this.cleanupTasksMatchFile(currentFile)) {
        console.warn("[oss-retry] 稳定等待期间本地附件已变化，拒绝清理", localPath);
        for (const entry of succeeded.filter((item) => item.localPath === localPath)) {
          if (!failed.includes(entry)) failed.push(entry);
        }
        new Notice(`稳定复核期间附件已变化，已保留且未删除：${localPath}`);
        continue;
      }
      try {
        this.lifecycle?.assertActive("删除已迁移本地附件");
        await this.trashFile(currentFile);
        await this.manager.finalizeCleanupForPath(localPath);
        new Notice(`重试成功：${localPath}`);
      } catch (error) {
        console.error("[oss-retry] 本地清理失败", localPath, error);
        for (const entry of succeeded.filter((item) => item.localPath === localPath)) {
          if (!failed.includes(entry)) failed.push(entry);
        }
      }
    }
    return { succeeded: succeeded.filter((entry) => !failed.includes(entry)), failed };
  }

  /** Callable from desktop commands and mobile settings; no status bar dependency. */
  async retryAll(): Promise<RetryBatchResult> {
    const entries = Object.values(this.settings.pendingUploads)
      .map((pending) => retryEntryFor(pending));
    return this.retryEntries(entries);
  }

  async retryPending(): Promise<void> {
    const result = await this.retryAll();
    if (result.failed.length > 0) {
      throw new Error(`${result.failed.length} 个上传任务仍未完成；本地数据与任务状态已保留`);
    }
    if (result.succeeded.length === 0) new Notice("当前没有可重试的上传任务");
  }

  /**
   * Recover the byte-first crash window: a stage may exist before its journal
   * write. This inspects only the reserved internal folder and performs no OSS
   * request or Vault-wide content scan.
   */
  async recoverUnjournaledStaging(): Promise<string[]> {
    const vault = this.plugin.app.vault;
    let stagingPaths: string[] = [];
    try {
      stagingPaths = (await vault.adapter.list(STAGING_DIR)).files;
    } catch {
      return [];
    }
    const claimed = new Set<string>();
    for (const pending of Object.values(this.settings.pendingUploads ?? {})) {
      if (pending.stagingPath) claimed.add(pending.stagingPath);
      if (pending.localPath && isInternalStagingPath(pending.localPath)) claimed.add(pending.localPath);
    }

    const recovered: string[] = [];
    for (const path of stagingPaths) {
      if (claimed.has(path)) continue;
      try {
        const targetPath = await this.restoreUnclaimedCopy(path);
        if (targetPath) recovered.push(targetPath);
      } catch (error) {
        console.error("[oss] 裸 staging 恢复失败，原文件保留", path, error);
      }
    }
    if (recovered.length > 0) {
      new Notice(`已从异常中恢复 ${recovered.length} 个附件到本地；请在文件列表中重新插入对应附件`);
    }
    return recovered;
  }

  async restoreInsuranceCopy(path: string): Promise<void> {
    this.lifecycle?.assertActive("恢复本地保险副本");
    if (!isInternalStagingPath(path) || !await this.plugin.app.vault.adapter.exists(path)) {
      throw new Error("这份本地保险副本已不存在");
    }
    if (isCopyClaimed(path, this.settings.pendingUploads)) {
      throw new Error("这份副本已关联上传任务，请选择“立即重试”");
    }
    const restoredPath = await this.restoreUnclaimedCopy(path);
    if (!restoredPath) throw new Error("无法识别这份保险副本的附件类型");
    new Notice(`附件已恢复到：${restoredPath}`);
  }

  async deleteUnclaimedInsuranceCopy(path: string): Promise<void> {
    this.lifecycle?.assertActive("永久删除本地保险副本");
    if (!isInternalStagingPath(path) || !await this.plugin.app.vault.adapter.exists(path)) {
      throw new Error("这份本地保险副本已不存在");
    }
    if (isCopyClaimed(path, this.settings.pendingUploads)) {
      throw new Error("上传任务已重新关联这份副本，已阻止删除");
    }
    await this.plugin.app.vault.adapter.remove(path);
    new Notice("本地保险副本已永久删除");
  }

  private async restoreUnclaimedCopy(path: string): Promise<string | null> {
    const fileName = path.slice(path.lastIndexOf("/") + 1);
    const match = fileName.match(/^([0-9a-f-]{36})\.([a-z0-9]+)\.stage$/i);
    if (!match || !isSupportedExt(match[2])) return null;
    const targetName = `recovered-${match[1]}.${match[2].toLowerCase()}`;
    const targetPath = await this.plugin.app.fileManager.getAvailablePathForAttachment(targetName, "");
    this.suppressedLocalPaths.add(targetPath);
    try {
      this.lifecycle?.assertActive("恢复本地保险副本");
      await this.plugin.app.vault.adapter.rename(path, targetPath);
      return targetPath;
    } finally {
      window.setTimeout(() => this.suppressedLocalPaths.delete(targetPath), 1000);
    }
  }

  private async commitRetryReference(
    localFile: TFile,
    tempId: string,
    objectKey: string,
    entry: RetryEntry,
    pendingBefore?: PendingUpload,
  ): Promise<boolean> {
    const pending = this.manager.getPending(tempId) ?? pendingBefore;
    this.lifecycle?.assertActive("修改附件引用");
    await this.manager.markReferenceCommitting(tempId);
    let committed = false;
    if (pending?.locator?.kind === "placeholder") {
      committed = await replaceUploadingPlaceholder(
        this.plugin.app.vault,
        entry.mdPath,
        pending.locator,
        objectKey,
        pending.displayName ?? localFile.name,
        () => this.lifecycle?.assertActive("修改附件引用"),
      );
    }
    if (!committed && !isInternalStagingPath(localFile.path)) {
      committed = await replaceOneResolvedAttachmentReference(
        this.plugin.app.vault,
        this.plugin.app.metadataCache,
        localFile,
        entry.mdPath,
        objectKey,
        pending?.locator?.kind === "attachment" ? pending.locator : undefined,
        () => this.lifecycle?.assertActive("修改附件引用"),
      );
    }
    if (!committed && !await sourceContainsObject(this.plugin.app.vault, entry.mdPath, objectKey)) {
      throw new Error(`未找到 ${entry.localPath} 的精确引用，已保留本地文件`);
    }
    await this.manager.markCleanupPending(tempId);
    return committed;
  }

  private async finalOccurrences(
    file: TFile,
    baseline: number,
    requireNewResolution = true,
  ): Promise<StableOccurrenceResult> {
    this.backlinks.invalidate();
    return waitForStableAttachmentOccurrences(
      this.plugin.app.vault,
      this.plugin.app.metadataCache,
      file,
      this.metadataResolutionTracking
        ? {
          baseline,
          current: () => this.backlinks.generation,
          requireNewResolution,
          hasResolvedSnapshot: () => this.backlinks.hasResolved,
        }
        : undefined,
    );
  }

  private cleanupTasksMatchFile(file: TFile): boolean {
    const tasks = Object.values(this.settings.pendingUploads).filter((pending) =>
      pending.localPath === file.path
    );
    return tasks.length > 0 && tasks.every((pending) => {
      if (pending.phase !== "cleanup_pending") return false;
      if (pending.size !== file.stat.size) return false;
      if (isInternalStagingPath(file.path)) {
        return pending.sourceMtime === undefined || pending.sourceMtime === file.stat.mtime;
      }
      return pending.sourceMtime !== undefined && pending.sourceMtime === file.stat.mtime;
    });
  }

  private async ensureStagingFolder(): Promise<void> {
    if (!this.stagingFolderReady) {
      this.stagingFolderReady = (async () => {
        const adapter = this.plugin.app.vault.adapter;
        if (await adapter.exists(STAGING_DIR)) {
          const stat = await adapter.stat(STAGING_DIR);
          if (stat?.type === "folder") return;
          throw new Error(`${STAGING_DIR} 已被同名文件占用`);
        }
        try {
          await adapter.mkdir(STAGING_DIR);
        } catch (error) {
          // Another generation or device event may have created it after exists().
          const stat = await adapter.stat(STAGING_DIR).catch(() => null);
          if (stat?.type !== "folder") throw error;
        }
      })().catch((error) => {
        this.stagingFolderReady = null;
        throw error;
      });
    }
    await this.stagingFolderReady;
  }

  private async deleteLocalFile(path: string, expectedSize?: number, expectedMtime?: number): Promise<void> {
    if (isInternalStagingPath(path)) {
      const stat = await this.plugin.app.vault.adapter.stat(path);
      if (!stat || stat.type !== "file") return;
      if (expectedSize !== undefined && stat.size !== expectedSize) {
        throw new Error(`staging 大小已变化，已保留：${path}`);
      }
      if (expectedMtime !== undefined && stat.mtime !== expectedMtime) {
        throw new Error(`staging 修改时间已变化，已保留：${path}`);
      }
      this.lifecycle?.assertActive("删除本地附件");
      await this.plugin.app.vault.adapter.remove(path);
      return;
    }
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    if (expectedSize !== undefined && file.stat.size !== expectedSize) {
      throw new Error(`staging 大小已变化，已保留：${path}`);
    }
    if (expectedMtime !== undefined && file.stat.mtime !== expectedMtime) {
      throw new Error(`staging 修改时间已变化，已保留：${path}`);
    }
    this.lifecycle?.assertActive("删除本地附件");
    await this.trashFile(file);
  }

  private async trashFile(file: TFile): Promise<void> {
    const fileManager = this.plugin.app.fileManager;
    if (fileManager) {
      await fileManager.trashFile(file);
      return;
    }
    // Minimal unit-test doubles may omit FileManager.
    await Reflect.apply(Reflect.get(this.plugin.app.vault, "delete"), this.plugin.app.vault, [file]);
  }

  private startRoot(factory: () => Promise<void>, label: string): void {
    let task: Promise<void>;
    try {
      task = this.lifecycle ? this.lifecycle.run(factory) : factory();
    } catch (error) {
      task = Promise.reject(normalizeError(error));
    }
    void task.catch((error) => {
      if (error instanceof LifecycleQuiescedError) return;
      console.error(`[oss] ${label}处理失败`, error);
    });
  }
}

function insertAllPlaceholders(editor: Editor, inputs: PreparedInput[]): void {
  const cursor = editor.getCursor();
  const baseOffset = editor.posToOffset(cursor);
  const separator = "\n";
  const block = inputs.map((input) => input.placeholder).join(separator);
  editor.replaceRange(block, cursor);
  const content = editor.getValue();
  let offset = baseOffset;
  for (const input of inputs) {
    input.locator = {
      kind: "placeholder",
      sourcePath: input.sourcePath,
      original: input.placeholder,
      start: offset,
      end: offset + input.placeholder.length,
      alt: input.file.name,
      before: content.slice(Math.max(0, offset - 32), offset),
      after: content.slice(offset + input.placeholder.length, offset + input.placeholder.length + 32),
    };
    offset += input.placeholder.length + separator.length;
  }
}

function replaceExactInEditor(editor: Editor, from: string, to: string): boolean {
  const content = editor.getValue();
  const index = content.indexOf(from);
  if (index < 0) return false;
  editor.replaceRange(to, editor.offsetToPos(index), editor.offsetToPos(index + from.length));
  return true;
}

async function replaceExactInVault(
  vault: Vault,
  sourcePath: string,
  locator: PendingReferenceLocator,
  replacement: string,
  beforeCommit?: () => void,
): Promise<boolean> {
  const file = vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile)) return false;
  let replaced = false;
  await vault.process(file, (content) => {
    const index = content.indexOf(locator.original);
    if (index < 0) return content;
    beforeCommit?.();
    replaced = true;
    return content.slice(0, index) + replacement + content.slice(index + locator.original.length);
  });
  return replaced;
}

async function sourceContainsObject(vault: Vault, sourcePath: string, objectKey: string): Promise<boolean> {
  const file = vault.getAbstractFileByPath(sourcePath);
  return file instanceof TFile && hasOssReference(await vault.cachedRead(file), objectKey);
}

async function locatePersistedLocalReference(
  vault: Vault,
  sourcePath: string,
  previous: PendingReferenceLocator,
  original: string,
): Promise<PendingReferenceLocator | undefined> {
  const file = vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile)) return undefined;
  const content = await vault.read(file);
  const candidates: number[] = [];
  let from = 0;
  while (from <= content.length) {
    const index = content.indexOf(original, from);
    if (index < 0) break;
    candidates.push(index);
    from = index + Math.max(1, original.length);
  }
  if (candidates.length === 0) return undefined;
  const start = candidates.reduce((closest, candidate) => {
    const score = (offset: number): number => {
      let value = Math.abs(offset - previous.start);
      if (previous.before && !content.slice(Math.max(0, offset - previous.before.length), offset)
        .endsWith(previous.before)) value += content.length;
      if (previous.after && !content.slice(offset + original.length, offset + original.length + previous.after.length)
        .startsWith(previous.after)) value += content.length;
      return value;
    };
    return score(candidate) < score(closest) ? candidate : closest;
  });
  return {
    kind: "attachment",
    sourcePath,
    original,
    start,
    end: start + original.length,
    alt: previous.alt,
    before: content.slice(Math.max(0, start - 32), start),
    after: content.slice(start + original.length, start + original.length + 32),
  };
}

function retryEntryFor(pending: PendingUpload, localPath = pending.localPath): RetryEntry {
  return {
    tempId: pending.tempId,
    mdPath: pending.sourcePath,
    localPath: localPath ?? pending.stagingPath ?? "",
    ext: pending.ext,
    occurrenceId: pending.occurrenceId,
  };
}

function dedupeRetryEntries(entries: RetryEntry[]): RetryEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = entry.tempId ?? `${entry.localPath}\0${entry.mdPath}\0${entry.occurrenceId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function waitForOccurrences(
  plugin: Plugin,
  file: TFile,
  backlinks: ResolvedAttachmentBacklinkCache,
): Promise<AttachmentOccurrence[]> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const occurrences = await findResolvedAttachmentOccurrences(
      plugin.app.vault,
      plugin.app.metadataCache,
      file,
      backlinks.get(file.path),
    );
    if (occurrences.length > 0) return occurrences;
    await sleep(300);
  }
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
