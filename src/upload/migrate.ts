import { Modal, Notice, Plugin, Setting, TFile } from "obsidian";
import { isLifecycleUploadPause, UploadManager } from "./manager";
import { LifecycleGate } from "../lifecycle";
import { isOversizedOnMobile } from "./interceptor";
import {
  AttachmentOccurrence,
  replaceOneResolvedAttachmentReference,
  scanMigrationOccurrences,
  waitForStableAttachmentOccurrences,
} from "./links";

/** 迁移附件到 OSS：每个 Markdown 引用实例独立上传。 */
export async function migrateAttachments(
  plugin: Plugin,
  manager: UploadManager,
  folderPath?: string,
  lifecycle?: LifecycleGate,
): Promise<void> {
  lifecycle?.assertActive("迁移附件");
  const vault = plugin.app.vault;
  const scope = folderPath || "全部";
  const scanNotice = new Notice(`[${scope}] 准备扫描…`, 0);
  let attachments: Array<{ file: TFile; occurrences: AttachmentOccurrence[] }>;
  try {
    attachments = await scanMigrationOccurrences(vault, plugin.app.metadataCache, folderPath, (progress) => {
      scanNotice.setMessage(
        `[${scope}] 扫描中 ${progress.scanned}/${progress.total}，已发现 ${progress.attachmentCount} 个附件、${progress.occurrenceCount} 个引用`,
      );
    });
  } catch (error) {
    console.error("[oss-migrate] 扫描失败", error);
    new Notice(`扫描失败：${(error as Error).message}`);
    return;
  } finally {
    scanNotice.hide();
  }
  lifecycle?.assertActive("展示迁移确认");

  if (attachments.length === 0) {
    new Notice(folderPath ? `${folderPath} 下没有需要迁移的本地附件` : "没有需要迁移的本地附件");
    return;
  }

  const occurrenceCount = attachments.reduce((sum, item) => sum + item.occurrences.length, 0);
  if (!await confirmMigration(
    plugin,
    attachments.length,
    occurrenceCount,
    folderPath ?? "全部",
    lifecycle,
  )) return;
  lifecycle?.assertActive("开始迁移附件");

  const notice = new Notice(`[${scope}] 开始迁移 ${occurrenceCount} 个独立引用…`, 0);
  let done = 0;
  let failed = 0;
  let resolutionGeneration = 0;
  const resolutionRef = plugin.app.metadataCache.on("resolved", () => { resolutionGeneration++; });

  try {
  for (const { file, occurrences } of attachments) {
    const metadataBaseline = resolutionGeneration;
    notice.setMessage(`[${scope}] 迁移中 (${done + failed + 1}/${attachments.length})：${file.name}`);
    let blob: Blob;
    const originalSize = file.stat.size;
    const originalMtime = file.stat.mtime;
    if (isOversizedOnMobile(originalSize)) {
      failed++;
      console.warn(`[oss-migrate] 移动端安全限制，保留大附件: ${file.path}`);
      continue;
    }
    try {
      blob = new Blob([await vault.readBinary(file)]);
    } catch (error) {
      failed++;
      console.error(`[oss-migrate] 读取附件失败: ${file.path}`, error);
      continue;
    }
    let attachmentFailed = false;

    for (const occurrence of occurrences) {
      try {
        lifecycle?.assertActive("上传迁移附件");
        const { objectKey, tempId } = await manager.upload({
          blob,
          ext: file.extension,
          sourcePath: occurrence.sourcePath,
          localPath: file.path,
          occurrenceId: occurrence.occurrenceId,
          displayName: file.name,
          locator: occurrence.locator,
          sourceMtime: originalMtime,
        });
        const pending = manager.getPending(tempId);
        if (pending?.phase === "cleanup_pending") continue;
        lifecycle?.assertActive("修改迁移附件引用");
        await manager.markReferenceCommitting(tempId);
        const replaced = await replaceOneResolvedAttachmentReference(
          vault,
          plugin.app.metadataCache,
          file,
          occurrence.sourcePath,
          objectKey,
          occurrence,
          () => lifecycle?.assertActive("修改迁移附件引用"),
        );
        if (!replaced) throw new Error("引用实例替换失败");
        await manager.markCleanupPending(tempId);
      } catch (error) {
        if (isLifecycleUploadPause(error)) throw error;
        attachmentFailed = true;
        console.error(`[oss-migrate] 引用实例迁移失败: ${occurrence.occurrenceId}`, error);
      }
    }

    // The initial scan is not authoritative after a slow upload/confirmation.
    // Re-read only MetadataCache candidates and never delete a changed source.
    const final = attachmentFailed
      ? { occurrences: [], confirmed: false }
      : await waitForStableAttachmentOccurrences(
        vault,
        plugin.app.metadataCache,
        file,
        { baseline: metadataBaseline, current: () => resolutionGeneration },
      );
    const remaining = final.occurrences;
    const unchanged = file.stat.size === originalSize && file.stat.mtime === originalMtime;
    if (attachmentFailed || !final.confirmed || remaining.length > 0 || !unchanged) {
      failed++;
    } else {
      try {
        lifecycle?.assertActive("删除已迁移本地附件");
        await vault.delete(file);
        await manager.finalizeCleanupForPath(file.path);
        done++;
      } catch (error) {
        failed++;
        console.error(`[oss-migrate] 本地清理失败: ${file.path}`, error);
      }
    }
  }
  } finally {
    plugin.app.metadataCache.offref(resolutionRef);
  }

  notice.setMessage(`迁移完成：成功 ${done}，失败 ${failed}`);
  setTimeout(() => notice.hide(), 5000);
}

function confirmMigration(
  plugin: Plugin,
  attachmentCount: number,
  occurrenceCount: number,
  scope: string,
  lifecycle?: LifecycleGate,
): Promise<boolean> {
  return new Promise((resolve) => {
    let removeQuiesceListener: () => void = () => undefined;
    const modal = new class extends Modal {
      private settled = false;

      onOpen(): void {
        this.contentEl.createEl("h3", { text: "迁移附件到 OSS？" });
        this.contentEl.createEl("p", {
          text: `范围：${scope}。${attachmentCount} 个本地附件共有 ${occurrenceCount} 个引用实例，每个实例将独立上传；全部实例验证成功后才删除本地文件。`,
        });
        new Setting(this.contentEl)
          .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
          .addButton((button) => button.setButtonText("开始迁移").setCta().onClick(() => {
            try {
              lifecycle?.assertActive("开始迁移附件");
            } catch {
              this.close();
              return;
            }
            this.settled = true;
            resolve(true);
            this.close();
          }));
      }

      onClose(): void {
        removeQuiesceListener();
        if (!this.settled) resolve(false);
        this.contentEl.empty();
      }
    }(plugin.app);
    modal.open();
    removeQuiesceListener = lifecycle?.onQuiesce(() => modal.close()) ?? (() => undefined);
  });
}
