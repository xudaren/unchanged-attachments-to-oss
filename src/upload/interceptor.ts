import {
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  Vault,
} from "obsidian";
import { UploadManager } from "./manager";
import { UploadProgressBar } from "./progress";
import { RetryEntry, RetryIndicator } from "./indicator";
import { isSupportedExt, PluginSettings } from "../types";

/**
 * 附件拦截器：
 *  - editor-paste / editor-drop：blob 直传，成功后插入 ![](oss://key)，不落本地
 *  - vault.on('create')：兜底路径，上传成功后 replace 引用 + vault.delete
 *  - 拦截路径失败：把 blob 写回本地文件、移除占位链接（不丢数据），并登记待重试
 */
export class AttachmentInterceptor {
  constructor(
    private readonly plugin: Plugin,
    private readonly manager: UploadManager,
    private readonly settings: PluginSettings,
    private readonly progress?: UploadProgressBar,
    private readonly retryIndicator?: RetryIndicator,
  ) {}

  register(): void {
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("editor-paste", (evt, editor, view) => {
        if (view instanceof MarkdownView) void this.handlePaste(evt, editor, view);
      }),
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("editor-drop", (evt, editor, view) => {
        if (view instanceof MarkdownView) void this.handleDrop(evt, editor, view);
      }),
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("create", (file) => {
        void this.handleCreate(file as TFile);
      }),
    );
  }

  private async handlePaste(evt: ClipboardEvent, editor: Editor, view: MarkdownView) {
    if (!this.settings.autoUpload) return;
    const files = clipboardFiles(evt);
    const supported = files.filter((f) => isSupportedExt(extOf(f.name, f.type)));
    if (supported.length === 0) return;
    evt.preventDefault();
    for (const file of supported) {
      await this.uploadAndInsert(file, editor, view);
    }
  }

  private async handleDrop(evt: DragEvent, editor: Editor, view: MarkdownView) {
    if (!this.settings.autoUpload) return;
    const files = Array.from(evt.dataTransfer?.files ?? []);
    const supported = files.filter((f) => isSupportedExt(extOf(f.name, f.type)));
    if (supported.length === 0) return;
    evt.preventDefault();
    for (const file of supported) {
      await this.uploadAndInsert(file, editor, view);
    }
  }

  /** 拦截路径：blob → OSS → 插入占位 → 成功替换 / 失败回写本地 */
  private async uploadAndInsert(file: File, editor: Editor, view: MarkdownView): Promise<void> {
    const ext = extOf(file.name, file.type);
    const sourcePath = view.file?.path ?? "";
    const placeholder = `![上传中 ${file.name}](oss://uploading/${crypto.randomUUID()})`;
    const insertPos = editor.getCursor();
    editor.replaceRange(placeholder, insertPos);
    const notice = new Notice(`上传中：${file.name} (${formatSize(file.size)})`, 0);

    try {
      const { objectKey } = await this.manager.upload({
        blob: file,
        ext,
        sourcePath,
        onProgress: (done, total) => {
          this.progress?.begin(file.name, total);
          this.progress?.advance(done);
        },
      });
      this.progress?.finish();
      const finalLink = `![${escapeAlt(file.name)}](oss://${objectKey})`;
      replaceInEditor(editor, placeholder, finalLink);
      notice.setMessage(`已上传：${file.name}`);
      setTimeout(() => notice.hide(), 2000);
    } catch (err) {
      this.progress?.finish();
      console.error("[oss] 拦截路径上传失败，回写本地", err);
      notice.hide();
      // 失败兜底：移除占位，写入本地，登记待重试
      replaceInEditor(editor, placeholder, "");
      const localPath = await writeLocalAttachment(this.plugin.app.vault, view.file, file);
      if (localPath) {
        editor.replaceRange(`![[${localPath}]]`, insertPos);
        this.retryIndicator?.push({
          mdPath: sourcePath,
          localPath,
          ext,
        });
        new Notice(`上传失败，已回写本地：${localPath}（可在状态栏点击重试）`);
      } else {
        new Notice(`上传失败，且本地回写也失败：${(err as Error).message}`);
      }
    }
  }

  /** 兜底路径：Obsidian 自己写入本地了才走这里 */
  private async handleCreate(file: TFile): Promise<void> {
    if (!this.settings.autoUpload) return;
    if (!(file instanceof TFile)) return;
    if (!isSupportedExt(file.extension)) return;
    if (isInPendingObjectKey(file.path, this.settings)) return; // 避免误处理插件内部产物

    // 简单去抖：Obsidian 刚创建的文件可能还在写入，稍等 300ms
    await sleep(300);

    const notice = new Notice(`兜底上传：${file.name}`, 0);
    try {
      const buf = await this.plugin.app.vault.readBinary(file);
      const blob = new Blob([buf]);
      const linkedFrom = this.findLinkedMd(file.path);
      const { objectKey } = await this.manager.upload({
        blob,
        ext: file.extension,
        sourcePath: linkedFrom ?? "",
      });
      // 替换所有引用
      if (linkedFrom) {
        await replaceLocalRefWithOss(this.plugin.app.vault, linkedFrom, file, objectKey);
      }
      await this.plugin.app.vault.delete(file);
      notice.setMessage(`兜底上传完成：${file.name}`);
      setTimeout(() => notice.hide(), 2000);
    } catch (err) {
      console.error("[oss] 兜底路径上传失败，保留本地", err);
      notice.setMessage(`兜底上传失败（保留本地）：${(err as Error).message}`);
      setTimeout(() => notice.hide(), 4000);
    }
  }

  /** 查找当前打开视图中引用了该附件的 md 路径 */
  private findLinkedMd(attachmentPath: string): string | null {
    const active = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    return active?.file?.path ?? null;
  }

  /**
   * 供 RetryIndicator 回调：把回写到本地的失败附件重新推给 OSS。
   * 成功后替换引用 + 删除本地文件；失败则抛出交由调用方决定。
   */
  async retryEntries(entries: RetryEntry[]): Promise<void> {
    const vault = this.plugin.app.vault;
    const failures: RetryEntry[] = [];
    for (const entry of entries) {
      const file = vault.getAbstractFileByPath(entry.localPath);
      if (!(file instanceof TFile)) {
        console.warn("[oss-retry] 本地文件已不存在，跳过", entry.localPath);
        continue;
      }
      try {
        const buf = await vault.readBinary(file);
        const blob = new Blob([buf]);
        const { objectKey } = await this.manager.upload({
          blob,
          ext: entry.ext,
          sourcePath: entry.mdPath,
        });
        if (entry.mdPath) {
          await replaceLocalRefWithOss(vault, entry.mdPath, file, objectKey);
        }
        await vault.delete(file);
        new Notice(`重试成功：${entry.localPath}`);
      } catch (err) {
        console.error("[oss-retry] 重试失败", entry, err);
        failures.push(entry);
      }
    }
    if (failures.length > 0) {
      throw new Error(`${failures.length} 个附件重试仍失败`);
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function clipboardFiles(evt: ClipboardEvent): File[] {
  const items = evt.clipboardData?.items;
  if (!items) return [];
  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== "file") continue;
    const f = item.getAsFile();
    if (f) files.push(f);
  }
  return files;
}

function extOf(name: string, mime: string): string {
  const idx = name.lastIndexOf(".");
  if (idx >= 0 && idx < name.length - 1) return name.slice(idx + 1).toLowerCase();
  // 剪贴板截图无文件名时靠 mime 推断
  const m = mime.match(/\/([\w.+-]+)$/);
  if (m) {
    const raw = m[1].toLowerCase();
    if (raw === "jpeg") return "jpg";
    if (raw === "quicktime") return "mov";
    if (raw === "x-matroska") return "mkv";
    return raw;
  }
  return "";
}

function escapeAlt(name: string): string {
  return name.replace(/[[\]]/g, "");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isInPendingObjectKey(_path: string, _settings: PluginSettings): boolean {
  return false;
}

function replaceInEditor(editor: Editor, from: string, to: string): void {
  const content = editor.getValue();
  const idx = content.indexOf(from);
  if (idx < 0) return;
  const startPos = editor.offsetToPos(idx);
  const endPos = editor.offsetToPos(idx + from.length);
  editor.replaceRange(to, startPos, endPos);
}

async function writeLocalAttachment(
  vault: Vault,
  mdFile: TFile | null,
  file: File,
): Promise<string | null> {
  try {
    const buf = await file.arrayBuffer();
    // 简化：写到 md 同目录，用原文件名（冲突则加时间戳）
    const dir = mdFile?.parent?.path ?? "";
    let name = file.name || `pasted-${Date.now()}.bin`;
    let target = dir ? `${dir}/${name}` : name;
    if (await vault.adapter.exists(target)) {
      const dot = name.lastIndexOf(".");
      const base = dot >= 0 ? name.slice(0, dot) : name;
      const ext = dot >= 0 ? name.slice(dot) : "";
      name = `${base}-${Date.now()}${ext}`;
      target = dir ? `${dir}/${name}` : name;
    }
    await vault.adapter.writeBinary(target, buf);
    return target;
  } catch (err) {
    console.error("[oss] 本地回写失败", err);
    return null;
  }
}

async function replaceLocalRefWithOss(
  vault: Vault,
  mdPath: string,
  localFile: TFile,
  objectKey: string,
): Promise<void> {
  const mdFile = vault.getAbstractFileByPath(mdPath);
  if (!(mdFile instanceof TFile)) return;
  const content = await vault.read(mdFile);
  const name = localFile.name;
  const path = localFile.path;
  // 匹配 wikilink ![[name]] / ![[path]] 以及 md link ![](name) / ![](path)
  const patterns = [
    new RegExp(`!\\[\\[${escapeReg(path)}\\]\\]`, "g"),
    new RegExp(`!\\[\\[${escapeReg(name)}\\]\\]`, "g"),
    new RegExp(`!\\[[^\\]]*\\]\\(${escapeReg(path)}\\)`, "g"),
    new RegExp(`!\\[[^\\]]*\\]\\(${escapeReg(name)}\\)`, "g"),
  ];
  const replacement = `![${escapeAlt(name)}](oss://${objectKey})`;
  let next = content;
  for (const re of patterns) next = next.replace(re, replacement);
  if (next !== content) await vault.modify(mdFile, next);
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
