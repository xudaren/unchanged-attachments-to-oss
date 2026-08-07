import { Modal, Notice, Plugin, Setting, TFile } from "obsidian";
import { UploadManager } from "./manager";
import {
  AttachmentOccurrence,
  replaceOneResolvedAttachmentReference,
  scanMigrationOccurrences,
} from "./links";

/** 迁移附件到 OSS：每个 Markdown 引用实例独立上传。 */
export async function migrateAttachments(
  plugin: Plugin,
  manager: UploadManager,
  folderPath?: string,
): Promise<void> {
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

  if (attachments.length === 0) {
    new Notice(folderPath ? `${folderPath} 下没有需要迁移的本地附件` : "没有需要迁移的本地附件");
    return;
  }

  const occurrenceCount = attachments.reduce((sum, item) => sum + item.occurrences.length, 0);
  if (!await confirmMigration(plugin, attachments.length, occurrenceCount, folderPath ?? "全部")) return;

  const notice = new Notice(`[${scope}] 开始迁移 ${occurrenceCount} 个独立引用…`, 0);
  let done = 0;
  let failed = 0;

  for (const { file, occurrences } of attachments) {
    notice.setMessage(`[${scope}] 迁移中 (${done + failed + 1}/${attachments.length})：${file.name}`);
    let blob: Blob;
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
        const { objectKey, tempId } = await manager.upload({
          blob,
          ext: file.extension,
          sourcePath: occurrence.sourcePath,
          localPath: file.path,
          occurrenceId: occurrence.occurrenceId,
        });
        const replaced = await replaceOneResolvedAttachmentReference(
          vault,
          plugin.app.metadataCache,
          file,
          occurrence.sourcePath,
          objectKey,
        );
        if (!replaced) throw new Error("引用实例替换失败");
        await manager.finalize(tempId);
      } catch (error) {
        attachmentFailed = true;
        console.error(`[oss-migrate] 引用实例迁移失败: ${occurrence.occurrenceId}`, error);
      }
    }

    if (attachmentFailed) {
      failed++;
    } else {
      await vault.delete(file);
      done++;
    }
  }

  notice.setMessage(`迁移完成：成功 ${done}，失败 ${failed}`);
  setTimeout(() => notice.hide(), 5000);
}

function confirmMigration(
  plugin: Plugin,
  attachmentCount: number,
  occurrenceCount: number,
  scope: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    new class extends Modal {
      private settled = false;

      onOpen(): void {
        this.contentEl.createEl("h3", { text: "迁移附件到 OSS？" });
        this.contentEl.createEl("p", {
          text: `范围：${scope}。${attachmentCount} 个本地附件共有 ${occurrenceCount} 个引用实例，每个实例将独立上传；全部实例验证成功后才删除本地文件。`,
        });
        new Setting(this.contentEl)
          .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
          .addButton((button) => button.setButtonText("开始迁移").setCta().onClick(() => {
            this.settled = true;
            resolve(true);
            this.close();
          }));
      }

      onClose(): void {
        if (!this.settled) resolve(false);
        this.contentEl.empty();
      }
    }(plugin.app).open();
  });
}
