import { App, Modal, Notice, Setting, Vault } from "obsidian";
import { OssClient, OssError } from "../oss/client";
import { PendingUpload } from "../types";
import { AuditReport, isProtectedByAge, reconcileObjects, scanVaultReferences } from "./reconcile";

interface AuditContext {
  app: App;
  vault: Vault;
  client: OssClient;
  prefix: string;
  pendingUploads: Record<string, PendingUpload>;
}

export async function runObjectAudit(context: AuditContext): Promise<void> {
  const notice = new Notice("正在核验 Vault 引用与 OSS 对象…", 0);
  try {
    const [referenced, objects] = await Promise.all([
      scanVaultReferences(context.vault),
      context.client.listObjects(context.prefix),
    ]);
    notice.hide();
    new ObjectAuditModal(
      context.app,
      reconcileObjects(referenced, objects, context.pendingUploads),
      async (keys) => deleteAfterRescan(context, keys),
    ).open();
  } catch (error) {
    notice.hide();
    const permissionHint = error instanceof OssError && (error.status === 403 || error.code === "AccessDenied")
      ? "请为当前凭证增加该存储前缀的 ListObjects 权限。"
      : "请检查网络和 OSS 配置后重试。";
    new Notice(`OSS 对象核验失败：${permissionHint}`);
    console.warn("[oss-audit] 核验失败", error);
  }
}

async function deleteAfterRescan(context: AuditContext, selectedKeys: string[]): Promise<void> {
  const latestReferences = await scanVaultReferences(context.vault);
  const pending = new Set(Object.values(context.pendingUploads).map((item) => item.objectKey));
  const deletable = selectedKeys.filter((key) => !latestReferences.has(key) && !pending.has(key));
  const skipped = selectedKeys.length - deletable.length;
  let deleted = 0;
  let failed = 0;
  for (const key of deletable) {
    try {
      await context.client.deleteObject(key);
      deleted++;
    } catch (error) {
      if (error instanceof OssError && error.status === 404) deleted++;
      else {
        failed++;
        console.warn("[oss-audit] 删除失败", key, error);
      }
    }
  }
  new Notice(`核验清理完成：删除 ${deleted}，跳过 ${skipped}，失败 ${failed}`);
}

class ObjectAuditModal extends Modal {
  private readonly selected = new Set<string>();

  constructor(
    app: App,
    private readonly report: AuditReport,
    private readonly onDelete: (keys: string[]) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.empty();
    this.modalEl.addClass("oss-audit-modal-shell");
    this.contentEl.addClass("oss-audit-modal");
    this.contentEl.createEl("h2", { text: "OSS 对象引用核验" });
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `正常 ${this.report.healthy.length} · 疑似垃圾 ${this.report.orphaned.length} · 引用失效 ${this.report.missing.length} · 上传任务保护 ${this.report.protectedPending.size}`,
    });

    this.renderOrphans();
    this.renderMissing();

    const actions = new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("关闭").onClick(() => this.close()))
      .addButton((button) => button
        .setButtonText("删除选中对象")
        .setWarning()
        .onClick(async () => {
          if (this.selected.size === 0) {
            new Notice("请先选择需要删除的疑似垃圾对象");
            return;
          }
          const keys = [...this.selected];
          this.close();
          await this.onDelete(keys);
        }));
    actions.settingEl.addClass("oss-audit-actions");
  }

  private renderOrphans(): void {
    this.contentEl.createEl("h3", { text: `疑似垃圾（${this.report.orphaned.length}）` });
    if (this.report.orphaned.length === 0) {
      this.contentEl.createEl("p", { text: "未发现无引用对象。" });
      return;
    }
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "默认不选择；创建未满 24 小时的对象处于保护期。删除前会重新扫描 Vault 引用。",
    });
    const list = this.contentEl.createDiv({ cls: "oss-audit-list" });
    for (const object of this.report.orphaned) {
      const protectedByAge = isProtectedByAge(object);
      new Setting(list)
        .setName(object.key)
        .setDesc(`${formatBytes(object.size)} · ${formatDate(object.lastModified)}${protectedByAge ? " · 24 小时保护中" : ""}`)
        .addToggle((toggle) => toggle
          .setValue(false)
          .setDisabled(protectedByAge)
          .onChange((checked) => {
            if (checked) this.selected.add(object.key);
            else this.selected.delete(object.key);
          }));
    }
  }

  private renderMissing(): void {
    this.contentEl.createEl("h3", { text: `引用失效（${this.report.missing.length}）` });
    if (this.report.missing.length === 0) {
      this.contentEl.createEl("p", { text: "所有 Vault 引用都能找到对应 OSS 对象。" });
      return;
    }
    const list = this.contentEl.createEl("ul", { cls: "oss-audit-missing" });
    for (const key of this.report.missing) {
      const item = list.createEl("li");
      item.createEl("code", { text: key });
      item.createEl("span", { text: ` · ${this.report.referenced.get(key)?.join("、") ?? ""}` });
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}
