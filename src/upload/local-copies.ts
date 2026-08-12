import { Modal, Notice, Setting, Vault } from "obsidian";
import { LifecycleGate } from "../lifecycle";
import { PendingUpload } from "../types";
import { formatAttachmentSize, isInternalStagingPath, STAGING_DIR } from "./input";

export interface LocalInsuranceCopy {
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
  taskId?: string;
  taskStatus?: string;
}

export interface LocalInsuranceCopyReport {
  copies: LocalInsuranceCopy[];
  totalSize: number;
  taskCount: number;
  unclaimedCount: number;
}

export interface LocalCopyActions {
  retryTasks(): Promise<void>;
  restore(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export async function scanLocalInsuranceCopies(
  vault: Vault,
  pendingUploads: Record<string, PendingUpload>,
): Promise<LocalInsuranceCopyReport> {
  const claims = claimedCopies(pendingUploads);
  let paths: string[] = [];
  try {
    paths = (await vault.adapter.list(STAGING_DIR)).files;
  } catch {
    // The staging directory is optional until the first intercepted upload.
  }
  const entries: Array<LocalInsuranceCopy | null> = await Promise.all(paths.map(async (path) => {
    const stat = await vault.adapter.stat(path);
    if (!stat || stat.type !== "file") return null;
    const pending = claims.get(path);
    const fileName = path.slice(path.lastIndexOf("/") + 1);
    return {
      path,
      name: pending?.displayName || readableCopyName(fileName),
      size: stat.size,
      modifiedAt: stat.mtime,
      taskId: pending?.tempId,
      taskStatus: pending ? describeTaskStatus(pending) : undefined,
    };
  }));
  const copies = entries
    .filter((copy): copy is LocalInsuranceCopy => copy !== null)
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  return {
    copies,
    totalSize: copies.reduce((sum, copy) => sum + copy.size, 0),
    taskCount: copies.filter((copy) => copy.taskId).length,
    unclaimedCount: copies.filter((copy) => !copy.taskId).length,
  };
}

export function isCopyClaimed(path: string, pendingUploads: Record<string, PendingUpload>): boolean {
  return claimedCopies(pendingUploads).has(path);
}

export class LocalInsuranceCopiesModal extends Modal {
  private renderGeneration = 0;
  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    private readonly vault: Vault,
    private readonly getPendingUploads: () => Record<string, PendingUpload>,
    private readonly actions: LocalCopyActions,
    private readonly lifecycle?: LifecycleGate,
  ) {
    super(app);
  }

  onOpen(): void {
    void this.render();
  }

  onClose(): void {
    this.renderGeneration += 1;
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    const generation = ++this.renderGeneration;
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "本地保险副本" });
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "上传时会先保留一份本地副本，避免断网、崩溃或引用写入失败造成附件丢失。任务安全完成后会自动清理。",
    });
    const loading = this.contentEl.createEl("p", { text: "正在读取本地保险副本…" });
    const report = await scanLocalInsuranceCopies(this.vault, this.getPendingUploads());
    if (generation !== this.renderGeneration) return;
    loading.remove();
    this.contentEl.createEl("p", {
      text: `当前 ${report.copies.length} 份，共占用 ${formatAttachmentSize(report.totalSize)}；${report.taskCount} 份正在等待处理，${report.unclaimedCount} 份没有关联任务。`,
    });

    if (report.taskCount > 0) {
      new Setting(this.contentEl)
        .setName("继续处理未完成上传")
        .setDesc("会继续上传、修复文档引用，并在确认安全后自动清理对应副本")
        .addButton((button) => button.setButtonText("立即重试").setCta().onClick(async () => {
          await this.run(() => this.actions.retryTasks());
          await this.render();
        }));
    }

    if (report.copies.length === 0) {
      this.contentEl.createEl("p", { text: "目前没有本地保险副本，不占用额外空间。" });
      return;
    }

    for (const copy of report.copies) {
      const setting = new Setting(this.contentEl)
        .setName(copy.name)
        .setDesc(`${formatAttachmentSize(copy.size)} · ${formatTime(copy.modifiedAt)} · ${copy.taskStatus ?? "未关联上传任务，可恢复到附件目录"}`);
      if (copy.taskId) continue;
      setting
        .addButton((button) => button.setButtonText("恢复到附件目录").onClick(async () => {
          await this.run(() => this.actions.restore(copy.path));
          await this.render();
        }))
        .addButton((button) => button.setButtonText("永久删除").setDestructive().onClick(() => {
          new ConfirmDeleteLocalCopyModal(this.app, copy, async () => {
            await this.run(() => this.actions.remove(copy.path));
            await this.render();
          }).open();
        }));
    }
  }

  private async run(factory: () => Promise<void>): Promise<void> {
    try {
      if (this.lifecycle) await this.lifecycle.run(factory);
      else await factory();
    } catch (error) {
      new Notice(`操作未完成：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

class ConfirmDeleteLocalCopyModal extends Modal {
  constructor(
    app: ConstructorParameters<typeof Modal>[0],
    private readonly copy: LocalInsuranceCopy,
    private readonly confirmDelete: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("h3", { text: "永久删除这份本地保险副本？" });
    this.contentEl.createEl("p", {
      text: `${this.copy.name}（${formatAttachmentSize(this.copy.size)}）删除后无法恢复。建议先选择“恢复到附件目录”。`,
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("确认永久删除").setDestructive().onClick(async () => {
        this.close();
        await this.confirmDelete();
      }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function claimedCopies(pendingUploads: Record<string, PendingUpload>): Map<string, PendingUpload> {
  const claims = new Map<string, PendingUpload>();
  for (const pending of Object.values(pendingUploads)) {
    for (const path of [pending.stagingPath, pending.localPath]) {
      if (path && isInternalStagingPath(path)) claims.set(path, pending);
    }
  }
  return claims;
}

function readableCopyName(fileName: string): string {
  const match = fileName.match(/^[0-9a-f-]{36}\.([a-z0-9]+)\.stage$/i);
  return match ? `待恢复附件.${match[1].toLowerCase()}` : fileName;
}

function describeTaskStatus(pending: PendingUpload): string {
  switch (pending.phase ?? "uploading") {
    case "staged": return "已安全保存，等待上传";
    case "uploading": return "上传未完成，可继续重试";
    case "completing": return "正在确认 OSS 是否接收完成";
    case "uploaded": return "已上传，等待写入文档引用";
    case "reference_committing": return "正在写入并确认文档引用";
    case "cleanup_pending": return "引用已处理，等待安全清理";
  }
}

function formatTime(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "时间未知";
}
