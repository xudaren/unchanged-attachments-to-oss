import { MetadataCache, TFile, Vault } from "obsidian";
import { isSupportedExt } from "../types";

interface EmbedToken {
  start: number;
  end: number;
  target: string;
}

export interface ReferenceReplacementResult {
  referencingPaths: string[];
  modifiedPaths: string[];
}

export interface AttachmentOccurrence {
  sourcePath: string;
  /** 文档初次计划时的引用序号，仅用于持久化区分任务。 */
  occurrenceIndex: number;
  occurrenceId: string;
}

export interface MigrationScanProgress {
  scanned: number;
  total: number;
  attachmentCount: number;
  occurrenceCount: number;
}

/**
 * Scan Markdown once and group resolved local attachment occurrences.
 * A folder scope includes notes in that folder and attachments physically stored there.
 */
export async function scanMigrationOccurrences(
  vault: Vault,
  metadataCache: MetadataCache,
  folderPath?: string,
  onProgress?: (progress: MigrationScanProgress) => void,
): Promise<Array<{ file: TFile; occurrences: AttachmentOccurrence[] }>> {
  const markdownFiles = vault.getMarkdownFiles();
  const grouped = new Map<string, { file: TFile; occurrences: AttachmentOccurrence[] }>();
  const scopedTargets = new Set<string>();
  const inScope = (path: string): boolean => !folderPath
    || path === folderPath
    || path.startsWith(`${folderPath}/`);
  let scopedOccurrenceCount = 0;

  onProgress?.({ scanned: 0, total: markdownFiles.length, attachmentCount: 0, occurrenceCount: 0 });
  for (let index = 0; index < markdownFiles.length; index++) {
    const md = markdownFiles[index];
    const content = await vault.cachedRead(md);
    for (const token of parseEmbeds(content)) {
      const linkpath = normalizeLinkpath(token.target);
      if (!linkpath || /^\w+:\/\//.test(linkpath)) continue;
      const target = metadataCache.getFirstLinkpathDest(linkpath, md.path);
      if (!(target instanceof TFile) || !isSupportedExt(target.extension)) continue;
      const item = grouped.get(target.path) ?? { file: target, occurrences: [] };
      if ((!folderPath || inScope(md.path) || inScope(target.path)) && !scopedTargets.has(target.path)) {
        scopedTargets.add(target.path);
        scopedOccurrenceCount += item.occurrences.length;
      }
      const occurrenceIndex = item.occurrences.filter((entry) => entry.sourcePath === md.path).length;
      item.occurrences.push({
        sourcePath: md.path,
        occurrenceIndex,
        occurrenceId: `${md.path}#${occurrenceIndex}`,
      });
      grouped.set(target.path, item);
      if (scopedTargets.has(target.path)) scopedOccurrenceCount++;
    }
    onProgress?.({
      scanned: index + 1,
      total: markdownFiles.length,
      attachmentCount: scopedTargets.size,
      occurrenceCount: scopedOccurrenceCount,
    });
    if ((index + 1) % 10 === 0) await yieldToUi();
  }
  return [...grouped.entries()]
    .filter(([path]) => scopedTargets.has(path))
    .map(([, item]) => item);
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Build one migration item for every resolved embed occurrence. */
export async function findResolvedAttachmentOccurrences(
  vault: Vault,
  metadataCache: MetadataCache,
  localFile: TFile,
): Promise<AttachmentOccurrence[]> {
  const occurrences: AttachmentOccurrence[] = [];
  for (const md of vault.getMarkdownFiles()) {
    const content = await vault.cachedRead(md);
    const matches = findMatchingEmbeds(content, md.path, localFile, metadataCache);
    matches.forEach((_, occurrenceIndex) => occurrences.push({
      sourcePath: md.path,
      occurrenceIndex,
      occurrenceId: `${md.path}#${occurrenceIndex}`,
    }));
  }
  return occurrences;
}

/** Replace exactly one still-local occurrence and verify the committed snapshot. */
export async function replaceOneResolvedAttachmentReference(
  vault: Vault,
  metadataCache: MetadataCache,
  localFile: TFile,
  sourcePath: string,
  objectKey: string,
): Promise<boolean> {
  const md = vault.getAbstractFileByPath(sourcePath);
  if (!(md instanceof TFile)) return false;
  const content = await vault.cachedRead(md);
  const match = findMatchingEmbeds(content, md.path, localFile, metadataCache)[0];
  if (!match) return false;
  const replacement = `![${escapeAlt(localFile.name)}](oss://${objectKey})`;
  const next = replaceTokens(content, [match], replacement);
  await vault.modify(md, next);
  return await vault.cachedRead(md) === next;
}

/** Replace only embeds which Obsidian resolves to the exact local attachment. */
export async function replaceResolvedAttachmentReferences(
  vault: Vault,
  metadataCache: MetadataCache,
  localFile: TFile,
  objectKey: string,
  sourcePaths?: readonly string[],
): Promise<ReferenceReplacementResult> {
  const candidates = sourcePaths
    ? sourcePaths.map((path) => vault.getAbstractFileByPath(path)).filter((file): file is TFile => file instanceof TFile)
    : vault.getMarkdownFiles();
  const referencingPaths: string[] = [];
  const modifiedPaths: string[] = [];
  const committed: Array<{ file: TFile; before: string; after: string }> = [];

  try {
    for (const md of candidates) {
      const content = await vault.cachedRead(md);
      const matches = findMatchingEmbeds(content, md.path, localFile, metadataCache);
      if (matches.length === 0) continue;
      referencingPaths.push(md.path);
      const replacement = `![${escapeAlt(localFile.name)}](oss://${objectKey})`;
      const next = replaceTokens(content, matches, replacement);
      await vault.modify(md, next);
      const verified = await vault.cachedRead(md);
      if (verified !== next) throw new Error(`引用写入验证失败：${md.path}`);
      committed.push({ file: md, before: content, after: next });
      modifiedPaths.push(md.path);
    }
  } catch (error) {
    await rollbackCommitted(vault, committed);
    throw error;
  }

  return { referencingPaths, modifiedPaths };
}

/** Find Markdown documents whose embeds resolve to the exact attachment. */
export async function findResolvedAttachmentReferences(
  vault: Vault,
  metadataCache: MetadataCache,
  localFile: TFile,
): Promise<string[]> {
  const paths: string[] = [];
  for (const md of vault.getMarkdownFiles()) {
    const content = await vault.cachedRead(md);
    if (findMatchingEmbeds(content, md.path, localFile, metadataCache).length > 0) paths.push(md.path);
  }
  return paths;
}

function findMatchingEmbeds(
  content: string,
  sourcePath: string,
  localFile: TFile,
  metadataCache: MetadataCache,
): EmbedToken[] {
  return parseEmbeds(content).filter((token) => {
    const linkpath = normalizeLinkpath(token.target);
    if (!linkpath || /^\w+:\/\//.test(linkpath)) return false;
    return metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path === localFile.path;
  });
}

/** Small scanner for Obsidian embeds; balanced parentheses avoid truncating legal filenames. */
function parseEmbeds(content: string): EmbedToken[] {
  const out: EmbedToken[] = [];
  for (let start = 0; start < content.length - 3; start++) {
    if (content[start] !== "!" || content[start + 1] !== "[") continue;
    if (content[start + 2] === "[") {
      const end = content.indexOf("]]", start + 3);
      if (end >= 0) {
        out.push({ start, end: end + 2, target: content.slice(start + 3, end) });
        start = end + 1;
      }
      continue;
    }
    const labelEnd = findUnescaped(content, "]", start + 2);
    if (labelEnd < 0 || content[labelEnd + 1] !== "(") continue;
    const destinationEnd = findBalancedParenEnd(content, labelEnd + 1);
    if (destinationEnd < 0) continue;
    out.push({
      start,
      end: destinationEnd + 1,
      target: stripMarkdownTitle(content.slice(labelEnd + 2, destinationEnd).trim()),
    });
    start = destinationEnd;
  }
  return out;
}

function findUnescaped(value: string, char: string, from: number): number {
  for (let i = from; i < value.length; i++) {
    if (value[i] === char && value[i - 1] !== "\\") return i;
  }
  return -1;
}

function findBalancedParenEnd(value: string, open: number): number {
  let depth = 0;
  let angle = false;
  for (let i = open; i < value.length; i++) {
    if (value[i - 1] === "\\") continue;
    if (value[i] === "<") angle = true;
    else if (value[i] === ">") angle = false;
    else if (!angle && value[i] === "(") depth++;
    else if (!angle && value[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

function stripMarkdownTitle(value: string): string {
  if (value.startsWith("<")) {
    const end = value.indexOf(">");
    if (end >= 0) return value.slice(0, end + 1);
  }
  return value.replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, "");
}

function replaceTokens(content: string, tokens: EmbedToken[], replacement: string): string {
  let next = content;
  for (const token of [...tokens].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, token.start) + replacement + next.slice(token.end);
  }
  return next;
}

async function rollbackCommitted(
  vault: Vault,
  committed: Array<{ file: TFile; before: string; after: string }>,
): Promise<void> {
  for (const item of [...committed].reverse()) {
    try {
      // 不覆盖写入之后发生的用户编辑。
      if (await vault.cachedRead(item.file) === item.after) await vault.modify(item.file, item.before);
    } catch (rollbackError) {
      console.error(`[oss-links] 引用回滚失败：${item.file.path}`, rollbackError);
    }
  }
}

function normalizeLinkpath(raw: string): string {
  let value = raw.trim().replace(/^<|>$/g, "");
  const alias = value.indexOf("|");
  if (alias >= 0) value = value.slice(0, alias);
  const heading = value.indexOf("#");
  if (heading >= 0) value = value.slice(0, heading);
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeAlt(name: string): string {
  return name.replace(/[[\]]/g, "");
}
