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
  private readonly initializing = new Map<string, InitState>();
  private readonly debounceMs = 1000;
  private registered = false;

  constructor(
    private readonly plugin: Plugin,
    private readonly client: OssClient,
  ) {}

  async register(): Promise<void> {
    if (this.registered) return;
    this.registered = true;
    // 先监听再扫描，避免大型 Vault 冷启动期间出现事件空窗。
    this.plugin.registerEvent(
      this.plugin.app.vault.on("create", (file) => this.onCreate(file)),
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (file) => this.onModify(file)),
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("delete", (file) => this.onDelete(file)),
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)),
    );
    this.plugin.register(() => this.dispose());

    await Promise.allSettled(
      this.plugin.app.vault.getMarkdownFiles().map((file) => this.initializeFile(file)),
    );
  }

  confirmReferenceRemoval(
    mdPath: string,
    key: string,
    label: string,
    removeLocalReference: () => Promise<boolean>,
  ): void {
    const commitReferenceRemoval = async (remoteDeleted: boolean): Promise<void> => {
      try {
        const removed = await removeLocalReference();
        if (removed) {
          this.refs.get(mdPath)?.delete(normalizeKey(key));
          new Notice(remoteDeleted
            ? `已删除 OSS 对象并移除${label}引用`
            : `已移除${label}引用，OSS 对象已保留`);
        } else {
          new Notice(`未找到当前${label}引用，文档未修改`);
        }
      } catch (err) {
        console.warn(remoteDeleted
          ? "[oss] 远端已删除，但移除本文档引用失败"
          : "[oss] 移除本文档引用失败", key, err);
        new Notice(remoteDeleted
          ? "OSS 对象已删除，但本文档引用移除失败，请手动处理"
          : "本文档引用移除失败，OSS 对象已保留");
      }
    };
    new ConfirmReferenceRemovalModal(this.plugin.app, key, mdPath, label, async () => {
      await commitReferenceRemoval(false);
    }, async () => {
      const deleted = await deleteRemoteObject(this.client, key);
      if (!deleted) {
        new Notice("OSS 删除失败，本文档引用已保留，可稍后重试");
        return;
      }
      await commitReferenceRemoval(true);
    }).open();
  }

  private dispose(): void {
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
    this.initializing.clear();
    this.refs.clear();
  }

  private onCreate(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    void this.initializeFile(file);
  }

  private onModify(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    const init = this.initializing.get(file.path);
    if (init) {
      init.dirty = true;
      return;
    }
    this.scheduleDiff(file);
  }

  private scheduleDiff(file: TFile): void {
    const existing = this.timers.get(file.path);
    if (existing !== undefined) window.clearTimeout(existing);
    const t = window.setTimeout(() => this.diffAndPrompt(file), this.debounceMs);
    this.timers.set(file.path, t);
  }

  private onDelete(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    this.cancelTimer(file.path);
    const init = this.initializing.get(file.path);
    if (init) init.deleted = true;
    const prev = this.refs.get(file.path);
    this.refs.delete(file.path);
    if (!prev || prev.size === 0) return;
    // 整篇被删 → 引用的所有 key 都视为被移除
    this.promptDelete(Array.from(prev), file.path, "文档被删除", false);
  }

  private onRename(file: TAbstractFile, oldPath: string): void {
    const prev = this.refs.get(oldPath);
    this.refs.delete(oldPath);
    if (prev && file instanceof TFile && file.extension === "md") {
      this.refs.set(file.path, prev);
    }
    const init = this.initializing.get(oldPath);
    if (init && file instanceof TFile && file.extension === "md") {
      this.initializing.delete(oldPath);
      init.path = file.path;
      this.initializing.set(file.path, init);
    }
    const hadTimer = this.cancelTimer(oldPath);
    if (hadTimer && file instanceof TFile && file.extension === "md") this.scheduleDiff(file);
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
    this.promptDelete(removed, file.path, "引用被移除", true);
  }

  private async initializeFile(file: TFile): Promise<void> {
    if (this.initializing.has(file.path)) return;
    const state: InitState = { file, path: file.path, dirty: false, deleted: false };
    this.initializing.set(state.path, state);
    try {
      // cachedRead 在调用时取得基线；期间事件由 state 暂存，基线完成后再 diff。
      const content = await this.plugin.app.vault.cachedRead(file);
      const baseline = collectKeys(content);
      if (state.deleted) {
        if (baseline.size > 0) this.promptDelete(Array.from(baseline), state.path, "文档被删除", false);
        return;
      }
      this.refs.set(state.path, baseline);
      if (state.dirty) this.scheduleDiff(file);
    } catch {
      // 单文件读取失败不阻塞其他文档；后续 modify 会重新建立当前基线。
    } finally {
      if (this.initializing.get(state.path) === state) this.initializing.delete(state.path);
    }
  }

  private cancelTimer(path: string): boolean {
    const timer = this.timers.get(path);
    if (timer === undefined) return false;
    window.clearTimeout(timer);
    this.timers.delete(path);
    return true;
  }

  private promptDelete(keys: string[], mdPath: string, reason: string, defaultSelected: boolean): void {
    // 过滤掉占位符（uploading/*），只处理真实 objectKey
    const real = keys.filter((k) => !k.startsWith("uploading/"));
    if (real.length === 0) return;
    new ConfirmDeleteModal(this.plugin.app, real, mdPath, reason, defaultSelected, async (chosen) => {
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

export async function deleteRemoteObject(client: OssClient, key: string): Promise<boolean> {
  try {
    await client.deleteObject(key);
    return true;
  } catch (err) {
    if (err instanceof OssError && err.status === 404) return true;
    console.warn("[oss] 删除远端失败", key, err);
    return false;
  }
}

interface InitState {
  file: TFile;
  path: string;
  dirty: boolean;
  deleted: boolean;
}

function collectKeys(md: string): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(OSS_URL_REGEX.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.add(normalizeKey(m[1]));
  return out;
}

function normalizeKey(value: string): string {
  try {
    return decodeURIComponent(value.replace(/^\/+/, ""));
  } catch {
    return value.replace(/^\/+/, "");
  }
}

class ConfirmReferenceRemovalModal extends Modal {
  constructor(
    app: App,
    private readonly key: string,
    private readonly mdPath: string,
    private readonly label: string,
    private readonly onKeepRemote: () => Promise<void>,
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: `删除${this.label}及 OSS 文件？` });
    contentEl.createEl("p", { text: `${this.mdPath} · ${this.key}` });
    contentEl.createEl("p", { text: "将先删除 OSS 文件，成功后再移除本文档中的引用。" });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
      .addButton((b) => b
        .setButtonText("仅移除引用")
        .onClick(async () => {
          this.close();
          await this.onKeepRemote();
        }))
      .addButton((b) => b
        .setButtonText("删除 OSS 并移除引用")
        .setWarning()
        .onClick(async () => {
          this.close();
          await this.onConfirm();
        }));
  }
}

class ConfirmDeleteModal extends Modal {
  constructor(
    app: App,
    private readonly keys: string[],
    private readonly mdPath: string,
    private readonly reason: string,
    private readonly defaultSelected: boolean,
    private readonly onConfirm: (chosen: string[]) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "联动删除 OSS 附件？" });
    contentEl.createEl("p", { text: `${this.mdPath} · ${this.reason}` });

    const selected = new Set(this.defaultSelected ? this.keys : []);
    const listEl = contentEl.createDiv({ cls: "oss-delete-list" });
    listEl.style.maxHeight = "260px";
    listEl.style.overflow = "auto";
    listEl.style.marginBottom = "12px";
    for (const key of this.keys) {
      new Setting(listEl)
        .setName(key)
        .addToggle((t) =>
          t.setValue(this.defaultSelected).onChange((v) => {
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
