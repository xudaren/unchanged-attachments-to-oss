import {
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  Vault,
} from "obsidian";
import { UploadManager, UploadPausedError } from "./manager";
import { UploadProgressBar } from "./progress";
import { RetryEntry, RetryIndicator } from "./indicator";
import { isSupportedExt, PluginSettings } from "../types";
import {
  findResolvedAttachmentOccurrences,
  replaceOneResolvedAttachmentReference,
} from "./links";

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
    if (supported.length !== files.length || hasClipboardText(evt)) return;
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
    if (supported.length !== files.length) return;
    evt.preventDefault();
    for (const file of supported) {
      await this.uploadAndInsert(file, editor, view);
    }
  }

  /** 拦截路径：blob → OSS → 插入占位 → 成功替换 / 失败回写本地 */
  private async uploadAndInsert(file: File, editor: Editor, view: MarkdownView): Promise<void> {
    const ext = extOf(file.name, file.type);
    const sourcePath = view.file?.path ?? "";
    const occurrenceId = crypto.randomUUID();
    const placeholder = `![上传中 ${file.name}](oss://uploading/${occurrenceId})`;
    const insertPos = editor.getCursor();
    editor.replaceRange(placeholder, insertPos);
    const notice = new Notice(`上传中：${file.name} (${formatSize(file.size)})`, 0);
    let taskTempId: string | undefined;

    try {
      const { objectKey, tempId } = await this.manager.upload({
        blob: file,
        ext,
        sourcePath,
        occurrenceId,
        onProgress: (done, total) => {
          this.progress?.begin(file.name, total);
          this.progress?.advance(done);
        },
      });
      taskTempId = tempId;
      this.progress?.finish();
      const finalLink = `![${escapeAlt(file.name)}](oss://${objectKey})`;
      if (!replaceInEditor(editor, placeholder, finalLink)) {
        throw new Error("上传已完成，但上传占位符已被修改或删除");
      }
      await this.manager.finalize(tempId);
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
        const pendingTempId = err instanceof UploadPausedError ? err.tempId : taskTempId;
        if (pendingTempId) await this.manager.bindLocalPath(pendingTempId, localPath);
        editor.replaceRange(`![[${localPath}]]`, insertPos);
        this.retryIndicator?.push({
          mdPath: sourcePath,
          localPath,
          ext,
          occurrenceId,
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

    const occurrences = await waitForOccurrences(this.plugin, file);
    if (occurrences.length === 0) return;

    const notice = new Notice(`兜底上传：${file.name}`, 0);
    let blob: Blob;
    try {
      blob = new Blob([await this.plugin.app.vault.readBinary(file)]);
    } catch (error) {
      console.error("[oss] 读取兜底附件失败", file.path, error);
      notice.setMessage(`兜底上传失败（保留本地）：无法读取 ${file.name}`);
      setTimeout(() => notice.hide(), 4000);
      return;
    }
    let failed = 0;
    for (const occurrence of occurrences) {
      try {
        const { objectKey, tempId } = await this.manager.upload({
          blob,
          ext: file.extension,
          sourcePath: occurrence.sourcePath,
          localPath: file.path,
          occurrenceId: occurrence.occurrenceId,
        });
        const replaced = await replaceOneResolvedAttachmentReference(
          this.plugin.app.vault,
          this.plugin.app.metadataCache,
          file,
          occurrence.sourcePath,
          objectKey,
        );
        if (!replaced) throw new Error("引用实例未能确认替换");
        await this.manager.finalize(tempId);
      } catch (err) {
        failed++;
        console.error("[oss] 引用实例兜底上传失败", occurrence, err);
        this.retryIndicator?.push({
          mdPath: occurrence.sourcePath,
          localPath: file.path,
          ext: file.extension,
          occurrenceId: occurrence.occurrenceId,
        });
      }
    }
    if (failed === 0) {
      await this.plugin.app.vault.delete(file);
      notice.setMessage(`兜底上传完成：${file.name}（${occurrences.length} 个独立引用）`);
      setTimeout(() => notice.hide(), 2000);
    } else {
      notice.setMessage(`兜底上传部分失败：${failed}/${occurrences.length}（已保留本地）`);
      setTimeout(() => notice.hide(), 4000);
    }
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
        const { objectKey, tempId } = await this.manager.upload({
          blob,
          ext: entry.ext,
          sourcePath: entry.mdPath,
          localPath: entry.localPath,
          occurrenceId: entry.occurrenceId,
        });
        const replaced = await replaceOneResolvedAttachmentReference(
          vault,
          this.plugin.app.metadataCache,
          file,
          entry.mdPath,
          objectKey,
        );
        if (!replaced) {
          throw new Error(`未找到 ${entry.localPath} 的真实引用，本地文件已保留`);
        }
        await this.manager.finalize(tempId);
        const remaining = await findResolvedAttachmentOccurrences(vault, this.plugin.app.metadataCache, file);
        if (remaining.length === 0) await vault.delete(file);
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

function hasClipboardText(evt: ClipboardEvent): boolean {
  return Boolean(evt.clipboardData?.getData("text/plain") || evt.clipboardData?.getData("text/html"));
}

function extOf(name: string, mime: string): string {
  const idx = name.lastIndexOf(".");
  if (idx >= 0 && idx < name.length - 1) return name.slice(idx + 1).toLowerCase();
  // 剪贴板截图无文件名时靠 mime 推断
  const explicitMimeExt: Record<string, string> = {
    "image/avif": "avif",
    "video/ogg": "ogv",
    "video/x-m4v": "m4v",
    "audio/aac": "aac",
    "audio/opus": "opus",
  };
  if (explicitMimeExt[mime.toLowerCase()]) return explicitMimeExt[mime.toLowerCase()];
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

async function waitForOccurrences(plugin: Plugin, file: TFile) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const occurrences = await findResolvedAttachmentOccurrences(
      plugin.app.vault,
      plugin.app.metadataCache,
      file,
    );
    if (occurrences.length > 0) return occurrences;
    await sleep(300);
  }
  return [];
}

function isInPendingObjectKey(_path: string, _settings: PluginSettings): boolean {
  return false;
}

function replaceInEditor(editor: Editor, from: string, to: string): boolean {
  const content = editor.getValue();
  const idx = content.indexOf(from);
  if (idx < 0) return false;
  const startPos = editor.offsetToPos(idx);
  const endPos = editor.offsetToPos(idx + from.length);
  editor.replaceRange(to, startPos, endPos);
  return true;
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
