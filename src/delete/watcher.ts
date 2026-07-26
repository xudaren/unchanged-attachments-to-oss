import { App, Modal, Notice, Plugin, Setting, TAbstractFile, TFile } from "obsidian";
import { OssClient, OssError } from "../oss/client";
import { OSS_URL_REGEX } from "../types";

/**
 * 删除联动监听：
 *  - 记录每个 md 文件当前引用的 oss:// key 集合
 *  - modify 后 debounce 1s，diff 出被移除的 key，弹 modal 让用户决定是否 DELETE OSS
 *  - 不跨文档判断引用，误删责任由用户承担（约束已声明）
 */
export class DeleteWatcher {
  private readonly refs = new Map<string, Set<string>>();
  private readonly timers = new Map<string, number>();
  private readonly debounceMs = 1000;

  constructor(
    private readonly plugin: Plugin,
    private readonly client: OssClient,
  ) {}

  async register(): Promise<void> {
    // 冷启动扫描：给每个 md 建立初始 ref 集合
    const mdFiles = this.plugin.app.vault.getMarkdownFiles();
    for (const f of mdFiles) {
      try {
        const content = await this.plugin.app.vault.cachedRead(f);
        this.refs.set(f.path, collectKeys(content));
      } catch {
        // 忽略单文件失败
      }
    }

    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (file) => this.onModify(file)),
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("delete", (file) => this.onDelete(file)),
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)),
    );
  }

  private onModify(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const existing = this.timers.get(file.path);
    if (existing !== undefined) window.clearTimeout(existing);
    const t = window.setTimeout(() => this.diffAndPrompt(file), this.debounceMs);
    this.timers.set(file.path, t);
  }

  private onDelete(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const prev = this.refs.get(file.path);
    this.refs.delete(file.path);
    if (!prev || prev.size === 0) return;
    // 整篇被删 → 引用的所有 key 都视为被移除
    this.promptDelete(Array.from(prev), file.path, "文档被删除");
  }

  private onRename(file: TAbstractFile, oldPath: string): void {
    const prev = this.refs.get(oldPath);
    this.refs.delete(oldPath);
    if (prev && file instanceof TFile && file.extension === "md") {
      this.refs.set(file.path, prev);
    }
  }

  private async diffAndPrompt(file: TFile): Promise<void> {
    this.timers.delete(file.path);
    let content: string;
    try {
      content = await this.plugin.app.vault.cachedRead(file);
    } catch {
      return;
    }
    const now = collectKeys(content);
    const prev = this.refs.get(file.path) ?? new Set();
    this.refs.set(file.path, now);
    const removed: string[] = [];
    for (const k of prev) if (!now.has(k)) removed.push(k);
    if (removed.length === 0) return;
    this.promptDelete(removed, file.path, "引用被移除");
  }

  private promptDelete(keys: string[], mdPath: string, reason: string): void {
    // 过滤掉占位符（uploading/*），只处理真实 objectKey
    const real = keys.filter((k) => !k.startsWith("uploading/"));
    if (real.length === 0) return;
    new ConfirmDeleteModal(this.plugin.app, real, mdPath, reason, async (chosen) => {
      let ok = 0;
      let fail = 0;
      for (const key of chosen) {
        try {
          await this.client.deleteObject(key);
          ok++;
        } catch (err) {
          if (err instanceof OssError && err.status === 404) {
            ok++;
          } else {
            fail++;
            console.warn("[oss] 删除远端失败", key, err);
          }
        }
      }
      if (ok > 0) new Notice(`已删除 OSS 对象 ${ok} 个${fail > 0 ? `，失败 ${fail} 个` : ""}`);
      else if (fail > 0) new Notice(`删除失败 ${fail} 个，见控制台`);
    }).open();
  }
}

function collectKeys(md: string): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(OSS_URL_REGEX.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.add(m[1]);
  return out;
}

class ConfirmDeleteModal extends Modal {
  constructor(
    app: App,
    private readonly keys: string[],
    private readonly mdPath: string,
    private readonly reason: string,
    private readonly onConfirm: (chosen: string[]) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "联动删除 OSS 附件？" });
    contentEl.createEl("p", { text: `${this.mdPath} · ${this.reason}` });

    const selected = new Set(this.keys);
    const listEl = contentEl.createDiv({ cls: "oss-delete-list" });
    listEl.style.maxHeight = "260px";
    listEl.style.overflow = "auto";
    listEl.style.marginBottom = "12px";
    for (const key of this.keys) {
      new Setting(listEl)
        .setName(key)
        .addToggle((t) =>
          t.setValue(true).onChange((v) => {
            if (v) selected.add(key);
            else selected.delete(key);
          }),
        );
    }

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("保留全部").onClick(() => this.close()),
      )
      .addButton((b) =>
        b
          .setButtonText("确认删除")
          .setCta()
          .onClick(async () => {
            this.close();
            await this.onConfirm(Array.from(selected));
          }),
      );
  }
}
