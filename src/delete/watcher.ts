import { App, Modal, Notice, Plugin, Setting, TFile } from "obsidian";
import { OssClient } from "../oss/client";
import { scanOssReferences } from "../reference/codec";
import { LifecycleGate, LifecycleQuiescedError } from "../lifecycle";

/**
 * 删除入口控制器：只处理用户从插件菜单明确发起的破坏性操作。
 * 不监听 Markdown 修改或原生文件删除，也不维护引用索引。
 */
export class DeleteWatcher {
  private registered = false;

  constructor(
    private readonly plugin: Plugin,
    private client: OssClient,
    private readonly lifecycle?: LifecycleGate,
  ) {}

  setClient(client: OssClient): void {
    this.client = client;
  }

  register(): void {
    if (this.registered) return;
    this.registered = true;
    // 只增加显式文件菜单项；冷启动不读取 Markdown，也不监听文件内容或删除事件。
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addSeparator();
        menu.addItem((item) => item
          .setTitle("删除文档并处理 OSS 附件")
          .setIcon("trash-2")
          .onClick(() => this.startAction(() => this.requestDocumentDeletion(file))));
      }),
    );
  }

  async requestDocumentDeletion(file: TFile): Promise<void> {
    this.lifecycle?.assertActive("打开文档删除入口");
    let content: string;
    try {
      content = await this.plugin.app.vault.cachedRead(file);
    } catch (error) {
      console.warn("[oss] 删除前读取文档失败", file.path, error);
      new Notice("无法读取文档，未执行删除");
      return;
    }
    const keys = collectDocumentOssKeys(content);
    if (keys.length === 0) {
      this.lifecycle?.assertActive("确认删除文档");
      const confirmed = await this.waitForCoreDeletionPrompt(file);
      if (confirmed) await this.trashDocumentThenDeleteSelected(file, []);
      return;
    }
    this.lifecycle?.assertActive("展示文档删除确认");
    let removeQuiesceListener: () => void = () => undefined;
    const modal = new ConfirmDocumentDeletionModal(
      this.plugin.app,
      file.path,
      keys,
      async (selected) => this.lifecycle
        ? this.lifecycle.run(() => this.trashDocumentThenDeleteSelected(file, selected))
        : this.trashDocumentThenDeleteSelected(file, selected),
      () => removeQuiesceListener(),
    );
    modal.open();
    removeQuiesceListener = this.lifecycle?.onQuiesce(() => modal.close()) ?? (() => undefined);
  }

  confirmReferenceRemoval(
    mdPath: string,
    key: string,
    label: string,
    removeLocalReference: () => Promise<boolean>,
  ): void {
    this.lifecycle?.assertActive("展示附件删除确认");
    const commitReferenceRemoval = async (remoteDeleted: boolean): Promise<void> => {
      try {
        this.lifecycle?.assertActive("移除附件引用");
        const removed = await removeLocalReference();
        if (removed) {
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
    let removeQuiesceListener: () => void = () => undefined;
    const modal = new ConfirmReferenceRemovalModal(this.plugin.app, key, mdPath, label, async () => {
      await this.runActionAsync(() => commitReferenceRemoval(false));
    }, async () => {
      await this.runActionAsync(async () => {
        this.lifecycle?.assertActive("删除 OSS 对象");
        const deleted = await deleteRemoteObject(this.client, key);
        if (!deleted) {
          new Notice("OSS 删除失败，本文档引用已保留，可稍后重试");
          return;
        }
        await commitReferenceRemoval(true);
      });
    }, () => removeQuiesceListener());
    modal.open();
    removeQuiesceListener = this.lifecycle?.onQuiesce(() => modal.close()) ?? (() => undefined);
  }

  private async trashDocumentThenDeleteSelected(file: TFile, selected: string[]): Promise<void> {
    try {
      this.lifecycle?.assertActive("将文档移入回收位置");
      await this.plugin.app.fileManager.trashFile(file);
    } catch (error) {
      console.warn("[oss] 文档移入回收位置失败", file.path, error);
      new Notice("文档删除失败，OSS 对象未处理");
      return;
    }
    let deleted = 0;
    let failed = 0;
    for (const key of selected) {
      this.lifecycle?.assertActive("删除 OSS 对象");
      if (await deleteRemoteObject(this.client, key)) deleted++;
      else failed++;
    }
    if (selected.length === 0) new Notice("文档已移入回收位置，OSS 对象已保留");
    else new Notice(`文档已移入回收位置；OSS 删除 ${deleted} 个${failed > 0 ? `，失败 ${failed} 个` : ""}`);
  }

  private startAction(factory: () => Promise<void>): void {
    void this.runActionAsync(factory);
  }

  private async runActionAsync(factory: () => Promise<void>): Promise<void> {
    try {
      if (this.lifecycle) await this.lifecycle.run(factory);
      else await factory();
    } catch (error) {
      if (!(error instanceof LifecycleQuiescedError)) {
        console.warn("[oss] 删除操作失败", error);
      }
    }
  }

  private async waitForCoreDeletionPrompt(file: TFile): Promise<boolean> {
    if (!this.lifecycle) return this.plugin.app.fileManager.promptForDeletion(file);
    let cancel!: () => void;
    const quiesced = new Promise<boolean>((resolve) => {
      cancel = this.lifecycle!.onQuiesce(() => resolve(false));
    });
    try {
      return await Promise.race([
        this.plugin.app.fileManager.promptForDeletion(file),
        quiesced,
      ]);
    } finally {
      cancel();
    }
  }
}

export async function deleteRemoteObject(client: OssClient, key: string): Promise<boolean> {
  try {
    await client.deleteObject(key);
    return true;
  } catch (err) {
    console.warn("[oss] 删除远端失败", key, err);
    return false;
  }
}

function collectKeys(md: string): Set<string> {
  return new Set(
    scanOssReferences(md)
      .map((reference) => reference.key)
      .filter((key) => !key.startsWith("uploading/")),
  );
}

export function collectDocumentOssKeys(md: string): string[] {
  return Array.from(collectKeys(md));
}

class ConfirmReferenceRemovalModal extends Modal {
  constructor(
    app: App,
    private readonly key: string,
    private readonly mdPath: string,
    private readonly label: string,
    private readonly onKeepRemote: () => Promise<void>,
    private readonly onConfirm: () => Promise<void>,
    private readonly onClosed?: () => void,
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

  onClose(): void {
    this.onClosed?.();
    this.contentEl.empty();
  }
}

class ConfirmDocumentDeletionModal extends Modal {
  constructor(
    app: App,
    private readonly mdPath: string,
    private readonly keys: string[],
    private readonly onConfirm: (chosen: string[]) => Promise<void>,
    private readonly onClosed?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "删除文档并处理 OSS 附件？" });
    contentEl.createEl("p", { text: this.mdPath });
    contentEl.createEl("p", {
      text: "文档将先移入 Obsidian 配置的回收位置。以下 OSS 对象默认保留；只勾选需要永久删除的对象。",
    });

    const selected = new Set<string>();
    const listEl = contentEl.createDiv({ cls: "oss-delete-list" });
    listEl.style.maxHeight = "260px";
    listEl.style.overflow = "auto";
    listEl.style.marginBottom = "12px";
    for (const key of this.keys) {
      new Setting(listEl)
        .setName(key)
        .addToggle((t) =>
          t.setValue(false).onChange((v) => {
            if (v) selected.add(key);
            else selected.delete(key);
          }),
        );
    }

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("取消").onClick(() => this.close()),
      )
      .addButton((b) =>
        b
          .setButtonText("删除文档")
          .setWarning()
          .onClick(async () => {
            this.close();
            await this.onConfirm(Array.from(selected));
          }),
      );
  }

  onClose(): void {
    this.onClosed?.();
    this.contentEl.empty();
  }
}
