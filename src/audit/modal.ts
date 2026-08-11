import { App, Modal, Notice, Setting, Vault } from "obsidian";
import { OssClient, OssError } from "../oss/client";
import { PendingUpload } from "../types";
import { LifecycleGate, LifecycleQuiescedError } from "../lifecycle";
import {
  AuditReport,
  describeScanFailures,
  isProtectedByAge,
  normalizeObjectKey,
  reconcileObjects,
  referencesAreComplete,
  scanVaultReferences,
  selectFinalDeletionCandidates,
} from "./reconcile";

export interface AuditContext {
  app: App;
  vault: Vault;
  client: OssClient;
  prefix: string;
  pendingUploads: Record<string, PendingUpload>;
  lifecycle?: LifecycleGate;
}

export async function runObjectAudit(context: AuditContext): Promise<void> {
  context.lifecycle?.assertActive("核验 OSS 对象引用");
  if (!context.prefix.replace(/^\/+|\/+$/g, "")) {
    new Notice("OSS 对象核验已阻止：Object Key 前缀不能为空");
    return;
  }
  const notice = new Notice("正在核验 Vault 引用与 OSS 对象…", 0);
  try {
    const [scan, objects] = await settlePair([
      scanVaultReferences(context.vault, {
        onProgress: ({ scanned, total }) => notice.setMessage(
          `正在核验 Vault 引用 ${scanned}/${total}…`,
        ),
      }),
      context.client.listObjects(context.prefix),
    ]);
    if (!referencesAreComplete(scan)) {
      notice.setMessage(`核验中止：${describeScanFailures(scan)}，未生成删除结论`);
      setTimeout(() => notice.hide(), 8000);
      return;
    }
    context.lifecycle?.assertActive("展示 OSS 核验结果");
    notice.hide();
    let removeQuiesceListener: () => void = () => undefined;
    const modal = new ObjectAuditModal(
      context.app,
      reconcileObjects(scan.referenced, objects, context.pendingUploads),
      async (keys) => {
        try {
          if (context.lifecycle) {
            await context.lifecycle.run(() => deleteAfterRescan(context, keys));
          } else {
            await deleteAfterRescan(context, keys);
          }
        } catch (error) {
          if (!(error instanceof LifecycleQuiescedError)) throw error;
        }
      },
      () => removeQuiesceListener(),
    );
    modal.open();
    removeQuiesceListener = context.lifecycle?.onQuiesce(() => modal.close()) ?? (() => undefined);
  } catch (error) {
    if (error instanceof LifecycleQuiescedError) {
      notice.hide();
      throw error;
    }
    notice.hide();
    const permissionHint = error instanceof OssError && (error.status === 403 || error.code === "AccessDenied")
      ? "请为当前凭证增加该存储前缀的 ListObjects 权限。"
      : "请检查网络和 OSS 配置后重试。";
    new Notice(`OSS 对象核验失败：${permissionHint}`);
    console.warn("[oss-audit] 核验失败", error);
  }
}

async function deleteAfterRescan(context: AuditContext, selectedKeys: string[]): Promise<void> {
  context.lifecycle?.assertActive("复核待删除 OSS 对象");
  const notice = new Notice("删除前正在重新扫描 Vault 引用…", 0);
  const normalizedSelected = new Set(selectedKeys.map(normalizeObjectKey));
  let latestScan: Awaited<ReturnType<typeof scanVaultReferences>>;
  let latestObjects: Awaited<ReturnType<OssClient["listObjects"]>>;
  try {
    [latestScan, latestObjects] = await settlePair([
      scanVaultReferences(context.vault, {
        targetKeys: normalizedSelected,
        onProgress: ({ scanned, total }) => notice.setMessage(
          `删除前重新扫描 ${scanned}/${total}…`,
        ),
      }),
      context.client.listObjects(context.prefix),
    ]);
  } catch (error) {
    if (error instanceof LifecycleQuiescedError) throw error;
    notice.setMessage("已取消删除：无法重新确认 OSS 对象状态");
    setTimeout(() => notice.hide(), 8000);
    console.warn("[oss-audit] 删除前复核失败", error);
    return;
  }
  if (!referencesAreComplete(latestScan)) {
    notice.setMessage(`已取消删除：${describeScanFailures(latestScan)}`);
    setTimeout(() => notice.hide(), 8000);
    return;
  }
  notice.hide();
  const selection = selectFinalDeletionCandidates(
    selectedKeys,
    latestScan.referenced,
    context.pendingUploads,
    latestObjects,
  );
  let deleted = 0;
  let failed = 0;
  for (const key of selection.deletable) {
    try {
      context.lifecycle?.assertActive("删除核验选中的 OSS 对象");
      await context.client.deleteObject(key);
      deleted++;
    } catch (error) {
      if (error instanceof LifecycleQuiescedError) throw error;
      failed++;
      console.warn("[oss-audit] 删除失败", key, error);
    }
  }
  new Notice(`核验清理完成：删除 ${deleted}，跳过 ${selection.skipped.length}，失败 ${failed}`);
}

/** Await both read-only branches so lifecycle drain never leaves an orphan scan behind. */
async function settlePair<A, B>(tasks: readonly [Promise<A>, Promise<B>]): Promise<[A, B]> {
  const [first, second] = await Promise.allSettled(tasks);
  if (first.status === "rejected") throw first.reason;
  if (second.status === "rejected") throw second.reason;
  return [first.value, second.value];
}

class ObjectAuditModal extends Modal {
  private readonly selected = new Set<string>();

  constructor(
    app: App,
    private readonly report: AuditReport,
    private readonly onDelete: (keys: string[]) => Promise<void>,
    private readonly onClosed?: () => void,
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

  onClose(): void {
    this.onClosed?.();
    this.contentEl.empty();
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
