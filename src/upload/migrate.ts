import { Notice, Plugin, TFile, TFolder } from "obsidian";
import { isSupportedExt, OSS_URL_REGEX } from "../types";
import { UploadManager } from "./manager";

/**
 * 迁移附件到 OSS。
 * @param folderPath 指定文件夹路径，不传则迁移整个 vault
 */
export async function migrateAttachments(
  plugin: Plugin,
  manager: UploadManager,
  folderPath?: string,
): Promise<void> {
  const vault = plugin.app.vault;
  let allFiles: TFile[];

  if (folderPath) {
    const folder = vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) {
      new Notice(`文件夹不存在：${folderPath}`);
      return;
    }
    allFiles = [];
    collectFilesRecursive(folder, allFiles);
  } else {
    allFiles = vault.getFiles();
  }

  const attachments = allFiles.filter(
    (f) => isSupportedExt(f.extension) && !isAlreadyOss(f),
  );

  if (attachments.length === 0) {
    new Notice(folderPath ? `${folderPath} 下没有需要迁移的本地附件` : "没有需要迁移的本地附件");
    return;
  }

  const scope = folderPath ?? "全部";
  const notice = new Notice(`[${scope}] 开始迁移 ${attachments.length} 个附件…`, 0);
  let done = 0;
  let failed = 0;

  for (const file of attachments) {
    notice.setMessage(`[${scope}] 迁移中 (${done + failed + 1}/${attachments.length})：${file.name}`);
    try {
      const buf = await vault.readBinary(file);
      const blob = new Blob([buf]);
      const { objectKey } = await manager.upload({
        blob,
        ext: file.extension,
        sourcePath: file.path,
      });
      await replaceAllRefs(vault, file, objectKey);
      await vault.delete(file);
      done++;
    } catch (err) {
      failed++;
      console.error(`[oss-migrate] 迁移失败: ${file.path}`, err);
    }
  }

  notice.setMessage(`迁移完成：成功 ${done}，失败 ${failed}`);
  setTimeout(() => notice.hide(), 5000);
}

/** 查找所有 md 中引用该附件并替换为 oss:// 链接 */
async function replaceAllRefs(
  vault: typeof Plugin.prototype.app.vault,
  localFile: TFile,
  objectKey: string,
): Promise<void> {
  const mdFiles = vault.getMarkdownFiles();
  const name = localFile.name;
  const path = localFile.path;
  const replacement = `![${escapeAlt(name)}](oss://${objectKey})`;

  for (const md of mdFiles) {
    let content: string;
    try {
      content = await vault.cachedRead(md);
    } catch {
      continue;
    }
    // 匹配 wikilink 和 md link
    const patterns = [
      new RegExp(`!\\[\\[${escapeReg(path)}(\\|[^\\]]*)?\\]\\]`, "g"),
      new RegExp(`!\\[\\[${escapeReg(name)}(\\|[^\\]]*)?\\]\\]`, "g"),
      new RegExp(`!\\[[^\\]]*\\]\\(${escapeReg(encodeURI(path))}\\)`, "g"),
      new RegExp(`!\\[[^\\]]*\\]\\(${escapeReg(encodeURI(name))}\\)`, "g"),
      new RegExp(`!\\[[^\\]]*\\]\\(${escapeReg(path)}\\)`, "g"),
      new RegExp(`!\\[[^\\]]*\\]\\(${escapeReg(name)}\\)`, "g"),
    ];
    let next = content;
    for (const re of patterns) next = next.replace(re, replacement);
    if (next !== content) {
      await vault.modify(md, next);
    }
  }
}

function isAlreadyOss(_file: TFile): boolean {
  return false;
}

function collectFilesRecursive(folder: TFolder, out: TFile[]): void {
  for (const child of folder.children) {
    if (child instanceof TFile) out.push(child);
    else if (child instanceof TFolder) collectFilesRecursive(child, out);
  }
}

function escapeAlt(name: string): string {
  return name.replace(/[[\]]/g, "");
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
