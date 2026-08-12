import { MetadataCache, TFile, TFolder, Vault } from "obsidian";
import { formatOssReference, scanOssReferences } from "../reference/codec";
import { isSupportedExt, PendingReferenceLocator } from "../types";

interface EmbedToken {
  start: number;
  end: number;
  target: string;
  original: string;
  alt: string;
}

export interface AttachmentOccurrence {
  sourcePath: string;
  /** 文档初次计划时的引用序号，仅用于持久化区分任务。 */
  occurrenceIndex: number;
  occurrenceId: string;
  alt: string;
  locator: PendingReferenceLocator;
}

export interface MigrationScanProgress {
  scanned: number;
  total: number;
  attachmentCount: number;
  occurrenceCount: number;
}

/**
 * Runtime-only reverse lookup for local attachment links. The cache is cheap to
 * invalidate and is never persisted as plugin state.
 */
export class ResolvedAttachmentBacklinkCache {
  private index: Map<string, string[]> | null = null;
  private resolvedGeneration = 0;
  private hasResolvedEvent = false;

  constructor(private readonly metadataCache: MetadataCache) {}

  invalidate(): void {
    this.index = null;
  }

  markResolved(): void {
    this.hasResolvedEvent = true;
    this.resolvedGeneration++;
    this.invalidate();
  }

  get generation(): number {
    return this.resolvedGeneration;
  }

  get hasResolved(): boolean {
    return this.hasResolvedEvent;
  }

  get(attachmentPath: string): readonly string[] {
    if (!this.index) this.index = buildResolvedAttachmentBacklinks(this.metadataCache);
    return this.index.get(attachmentPath) ?? [];
  }
}

export interface StableOccurrenceResult {
  occurrences: AttachmentOccurrence[];
  /** False means MetadataCache never reached a confirmable stable snapshot. */
  confirmed: boolean;
}

export interface MetadataResolutionClock {
  baseline: number;
  current: () => number;
  /** True for a path that modified Markdown during this operation. */
  requireNewResolution?: boolean;
  /** Used only by cleanup-only retries that did not modify Markdown. */
  hasResolvedSnapshot?: () => boolean;
}

/**
 * Wait for MetadataCache candidates and parsed occurrences to settle before a
 * destructive local delete. Timeout is a safety failure, never evidence of zero
 * references. Only candidate Markdown from resolvedLinks is read.
 */
export async function waitForStableAttachmentOccurrences(
  vault: Vault,
  metadataCache: MetadataCache,
  localFile: TFile,
  clock?: MetadataResolutionClock,
  timeoutMs = 3000,
  pollMs = 100,
  stableMs = 750,
): Promise<StableOccurrenceResult> {
  const startedAt = Date.now();
  let lastGeneration = clock?.current() ?? 0;
  const requireNewResolution = clock?.requireNewResolution ?? true;
  let sawResolved = !clock || lastGeneration > clock.baseline ||
    (!requireNewResolution && clock.hasResolvedSnapshot?.() === true);
  let lastSignature: string | null = null;
  let stableSince = startedAt;
  let stableRounds = 0;
  let occurrences: AttachmentOccurrence[] = [];

  while (Date.now() - startedAt < timeoutMs) {
    const generation = clock?.current() ?? lastGeneration;
    if (clock && (generation > clock.baseline ||
        (!requireNewResolution && clock.hasResolvedSnapshot?.() === true))) sawResolved = true;
    occurrences = await findResolvedAttachmentOccurrences(vault, metadataCache, localFile);
    const signature = occurrenceSignature(occurrences);
    if (generation !== lastGeneration || signature !== lastSignature) {
      lastGeneration = generation;
      lastSignature = signature;
      stableSince = Date.now();
      stableRounds = 1;
    } else {
      stableRounds++;
    }
    if (sawResolved && stableRounds >= 2 && Date.now() - stableSince >= stableMs) {
      return { occurrences, confirmed: true };
    }
    await yieldFor(pollMs);
  }
  return { occurrences, confirmed: false };
}

function occurrenceSignature(occurrences: AttachmentOccurrence[]): string {
  return occurrences.map((occurrence) =>
    `${occurrence.sourcePath}\0${occurrence.locator.start}\0${occurrence.locator.original}`
  ).sort().join("\x01");
}

function yieldFor(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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
  const referencesByTarget = buildResolvedAttachmentBacklinks(metadataCache);
  const targetFiles = new Map<string, TFile>();
  for (const targetPath of referencesByTarget.keys()) {
    const target = vault.getAbstractFileByPath(targetPath);
    if (target instanceof TFile && isSupportedExt(target.extension)) targetFiles.set(targetPath, target);
  }

  const inScope = (path: string): boolean => !folderPath
    || path === folderPath
    || path.startsWith(`${folderPath}/`);
  const candidateTargets = new Set<string>();
  if (folderPath) {
    for (const file of filesInFolder(vault, folderPath)) {
      if (isSupportedExt(file.extension)) candidateTargets.add(file.path);
    }
    for (const [targetPath, sourcePaths] of referencesByTarget) {
      if (targetFiles.has(targetPath) && sourcePaths.some(inScope)) candidateTargets.add(targetPath);
    }
  } else {
    for (const targetPath of targetFiles.keys()) candidateTargets.add(targetPath);
  }

  const sourcePaths = new Set<string>();
  for (const targetPath of candidateTargets) {
    for (const sourcePath of referencesByTarget.get(targetPath) ?? []) sourcePaths.add(sourcePath);
  }
  const markdownFiles = [...sourcePaths]
    .map((path) => vault.getAbstractFileByPath(path))
    .filter((file): file is TFile => file instanceof TFile && file.extension === "md");
  const grouped = new Map<string, { file: TFile; occurrences: AttachmentOccurrence[] }>();
  let occurrenceCount = 0;

  onProgress?.({ scanned: 0, total: markdownFiles.length, attachmentCount: 0, occurrenceCount: 0 });
  for (let index = 0; index < markdownFiles.length; index++) {
    const md = markdownFiles[index];
    const content = await vault.cachedRead(md);
    for (const token of embedTokensForFile(content, md, metadataCache)) {
      const linkpath = normalizeLinkpath(token.target);
      if (!linkpath || /^\w+:\/\//.test(linkpath)) continue;
      const target = metadataCache.getFirstLinkpathDest(linkpath, md.path);
      if (!(target instanceof TFile) || !candidateTargets.has(target.path) || !isSupportedExt(target.extension)) continue;
      const item = grouped.get(target.path) ?? { file: target, occurrences: [] };
      const occurrenceIndex = item.occurrences.filter((entry) => entry.sourcePath === md.path).length;
      item.occurrences.push({
        sourcePath: md.path,
        occurrenceIndex,
        occurrenceId: `${md.path}:${token.start}:${token.end}`,
        alt: token.alt,
        locator: locatorFor(md.path, content, token),
      });
      grouped.set(target.path, item);
      occurrenceCount++;
    }
    onProgress?.({
      scanned: index + 1,
      total: markdownFiles.length,
      attachmentCount: grouped.size,
      occurrenceCount,
    });
    if ((index + 1) % 10 === 0) await yieldToUi();
  }
  return [...grouped.values()];
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

/** Build one migration item for every resolved embed occurrence. */
export async function findResolvedAttachmentOccurrences(
  vault: Vault,
  metadataCache: MetadataCache,
  localFile: TFile,
  sourcePaths: readonly string[] = resolvedSourcePathsForAttachment(metadataCache, localFile.path),
): Promise<AttachmentOccurrence[]> {
  const occurrences: AttachmentOccurrence[] = [];
  for (const sourcePath of sourcePaths) {
    const md = vault.getAbstractFileByPath(sourcePath);
    if (!(md instanceof TFile) || md.extension !== "md") continue;
    const content = await readCurrent(vault, md);
    const matches = findMatchingEmbeds(content, md, localFile, metadataCache);
    matches.forEach((token, occurrenceIndex) => occurrences.push({
      sourcePath: md.path,
      occurrenceIndex,
      occurrenceId: `${md.path}:${token.start}:${token.end}`,
      alt: token.alt,
      locator: locatorFor(md.path, content, token),
    }));
  }
  return occurrences;
}

/** Return only Markdown paths MetadataCache currently resolves to one attachment. */
export function resolvedSourcePathsForAttachment(
  metadataCache: MetadataCache,
  attachmentPath: string,
): string[] {
  const paths: string[] = [];
  for (const [sourcePath, destinations] of Object.entries(metadataCache.resolvedLinks)) {
    if ((destinations[attachmentPath] ?? 0) > 0) paths.push(sourcePath);
  }
  return paths;
}

/** Build one reverse map from the public MetadataCache link graph. */
export function buildResolvedAttachmentBacklinks(metadataCache: MetadataCache): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [sourcePath, destinations] of Object.entries(metadataCache.resolvedLinks)) {
    for (const [targetPath, count] of Object.entries(destinations)) {
      if (count <= 0 || !isSupportedExt(extensionOfPath(targetPath))) continue;
      const sources = index.get(targetPath) ?? [];
      sources.push(sourcePath);
      index.set(targetPath, sources);
    }
  }
  return index;
}

function filesInFolder(vault: Vault, folderPath: string): TFile[] {
  const folder = vault.getAbstractFileByPath(folderPath);
  if (!(folder instanceof TFolder)) return [];
  const files: TFile[] = [];
  const pending = [folder];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    for (const child of current.children) {
      if (child instanceof TFile) files.push(child);
      else if (child instanceof TFolder) pending.push(child);
    }
  }
  return files;
}

function extensionOfPath(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : "";
}

/** Replace exactly one still-local occurrence and verify the committed snapshot. */
export async function replaceOneResolvedAttachmentReference(
  vault: Vault,
  metadataCache: MetadataCache,
  localFile: TFile,
  sourcePath: string,
  objectKey: string,
  planned?: AttachmentOccurrence | PendingReferenceLocator,
  beforeCommit?: () => void,
): Promise<boolean> {
  const md = vault.getAbstractFileByPath(sourcePath);
  if (!(md instanceof TFile)) return false;
  const locator = planned && "locator" in planned ? planned.locator : planned;
  let committed = false;
  await vault.process(md, (content) => {
    const matches = findMatchingEmbeds(content, md, localFile, metadataCache);
    const match = locatePlannedToken(content, matches, locator);
    if (!match) return content;
    beforeCommit?.();
    const alt = locator?.alt ?? match.alt ?? localFile.name;
    committed = true;
    return replaceTokens(content, [match], formatOssReference(objectKey, alt));
  });
  if (!committed) return false;
  return scanOssReferences(await readCurrent(vault, md)).some((reference) => reference.key === objectKey);
}

/** Commit a direct-upload placeholder by its unique token, never by a stale cursor. */
export async function replaceUploadingPlaceholder(
  vault: Vault,
  sourcePath: string,
  locator: PendingReferenceLocator,
  objectKey: string,
  alt: string,
  beforeCommit?: () => void,
): Promise<boolean> {
  const md = vault.getAbstractFileByPath(sourcePath);
  if (!(md instanceof TFile)) return false;
  let committed = false;
  await vault.process(md, (content) => {
    const start = locateExactToken(content, locator);
    if (start < 0) return content;
    beforeCommit?.();
    committed = true;
    return content.slice(0, start) + formatOssReference(objectKey, alt) +
      content.slice(start + locator.original.length);
  });
  if (!committed) return false;
  return hasOssReference(await readCurrent(vault, md), objectKey);
}

export function hasOssReference(content: string, objectKey: string): boolean {
  return scanOssReferences(content).some((reference) => reference.key === objectKey);
}

function findMatchingEmbeds(
  content: string,
  sourceFile: TFile,
  localFile: TFile,
  metadataCache: MetadataCache,
): EmbedToken[] {
  return embedTokensForFile(content, sourceFile, metadataCache).filter((token) => {
    const linkpath = normalizeLinkpath(token.target);
    if (!linkpath || /^\w+:\/\//.test(linkpath)) return false;
    return metadataCache.getFirstLinkpathDest(linkpath, sourceFile.path)?.path === localFile.path;
  });
}

function embedTokensForFile(content: string, sourceFile: TFile, metadataCache: MetadataCache): EmbedToken[] {
  const fileCache = metadataCache.getFileCache?.(sourceFile);
  if (!fileCache) return parseEmbeds(content);
  const embeds = fileCache.embeds ?? [];
  const tokens: EmbedToken[] = [];
  for (const embed of embeds) {
    const start = embed.position.start.offset;
    const end = embed.position.end.offset;
    if (start < 0 || end <= start || end > content.length) return parseEmbeds(content);
    const original = content.slice(start, end);
    // MetadataCache updates asynchronously after vault.process. Never apply a
    // cached link to offsets that no longer describe the current snapshot.
    if (embed.original && embed.original !== original) return parseEmbeds(content);
    const parsed = parseEmbeds(original);
    if (parsed.length !== 1 || parsed[0].start !== 0 || parsed[0].end !== original.length ||
        normalizeLinkpath(parsed[0].target) !== normalizeLinkpath(embed.link)) {
      return parseEmbeds(content);
    }
    tokens.push({
      start,
      end,
      target: embed.link,
      original,
      alt: embed.displayText ?? altFromOriginal(original),
    });
  }
  return tokens;
}

/** Small scanner for Obsidian embeds; balanced parentheses avoid truncating legal filenames. */
function parseEmbeds(content: string): EmbedToken[] {
  const out: EmbedToken[] = [];
  const excluded = markdownExcludedRanges(content);
  let excludedIndex = 0;
  for (let start = 0; start < content.length - 3; start++) {
    while (excludedIndex < excluded.length && excluded[excludedIndex].end <= start) excludedIndex++;
    if (excludedIndex < excluded.length && excluded[excludedIndex].start <= start) {
      start = excluded[excludedIndex].end - 1;
      continue;
    }
    if (content[start] !== "!" || content[start + 1] !== "[") continue;
    if (content[start + 2] === "[") {
      const end = content.indexOf("]]", start + 3);
      if (end >= 0) {
        const target = content.slice(start + 3, end);
        out.push({
          start,
          end: end + 2,
          target,
          original: content.slice(start, end + 2),
          alt: wikiAlias(target),
        });
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
      original: content.slice(start, destinationEnd + 1),
      alt: unescapeAlt(content.slice(start + 2, labelEnd)),
    });
    start = destinationEnd;
  }
  return out;
}

interface TextRange {
  start: number;
  end: number;
}

function markdownExcludedRanges(content: string): TextRange[] {
  const ranges: TextRange[] = [];
  if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
    const end = content.search(/\r?\n---(?:\r?\n|$)/);
    if (end >= 0) {
      const closing = content.indexOf("---", end + 1);
      ranges.push({ start: 0, end: closing + 3 });
    }
  }
  collectRanges(content, /<!--[\s\S]*?-->/g, ranges);
  collectRanges(content, /^(?: {0,3})(`{3,}|~{3,})[^\r\n]*(?:\r?\n)[\s\S]*?^(?: {0,3})\1[ \t]*(?=\r?$)/gm, ranges);
  collectRanges(content, /(`+)(?!`)(?:[^`]|`(?!\1))*?\1/g, ranges);
  return mergeRanges(ranges);
}

function collectRanges(content: string, pattern: RegExp, ranges: TextRange[]): void {
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
    if (match[0].length === 0) pattern.lastIndex++;
  }
}

function mergeRanges(ranges: TextRange[]): TextRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) merged.push({ ...range });
    else last.end = Math.max(last.end, range.end);
  }
  return merged;
}

function locatorFor(sourcePath: string, content: string, token: EmbedToken): PendingReferenceLocator {
  return {
    kind: "attachment",
    sourcePath,
    original: token.original,
    start: token.start,
    end: token.end,
    alt: token.alt,
    before: content.slice(Math.max(0, token.start - 32), token.start),
    after: content.slice(token.end, Math.min(content.length, token.end + 32)),
  };
}

function locatePlannedToken(
  content: string,
  matches: EmbedToken[],
  locator?: PendingReferenceLocator,
): EmbedToken | undefined {
  if (!locator) return matches[0];
  const exact = matches.find((match) => match.start === locator.start && match.original === locator.original);
  if (exact) return exact;
  const same = matches.filter((match) => match.original === locator.original);
  if (same.length === 0) return undefined;
  return same.reduce((closest, candidate) => {
    const closestScore = locatorScore(content, closest, locator);
    const candidateScore = locatorScore(content, candidate, locator);
    return candidateScore < closestScore ? candidate : closest;
  });
}

function locatorScore(content: string, token: EmbedToken, locator: PendingReferenceLocator): number {
  let score = Math.abs(token.start - locator.start);
  if (locator.before && !content.slice(Math.max(0, token.start - locator.before.length), token.start).endsWith(locator.before)) {
    score += content.length;
  }
  if (locator.after && !content.slice(token.end, token.end + locator.after.length).startsWith(locator.after)) {
    score += content.length;
  }
  return score;
}

function locateExactToken(content: string, locator: PendingReferenceLocator): number {
  if (content.slice(locator.start, locator.start + locator.original.length) === locator.original) return locator.start;
  const candidates: number[] = [];
  let from = 0;
  while (from <= content.length) {
    const index = content.indexOf(locator.original, from);
    if (index < 0) break;
    candidates.push(index);
    from = index + Math.max(1, locator.original.length);
  }
  if (candidates.length === 0) return -1;
  return candidates.reduce((closest, candidate) => {
    const token = { start: candidate, end: candidate + locator.original.length } as EmbedToken;
    const closestToken = { start: closest, end: closest + locator.original.length } as EmbedToken;
    return locatorScore(content, token, locator) < locatorScore(content, closestToken, locator) ? candidate : closest;
  });
}

function wikiAlias(target: string): string {
  const alias = target.lastIndexOf("|");
  if (alias >= 0 && target.slice(alias + 1)) return target.slice(alias + 1);
  const link = normalizeLinkpath(alias >= 0 ? target.slice(0, alias) : target);
  return link.slice(link.lastIndexOf("/") + 1);
}

function altFromOriginal(original: string): string {
  if (original.startsWith("![[")) return wikiAlias(original.slice(3, -2));
  const close = findUnescaped(original, "]", 2);
  return close >= 0 ? unescapeAlt(original.slice(2, close)) : "";
}

function unescapeAlt(value: string): string {
  return value.replace(/\\([\[\]\\])/g, "$1");
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
  const withoutQuotedTitle = value.replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, "");
  if (withoutQuotedTitle !== value) return withoutQuotedTitle;
  const trimmed = value.trimEnd();
  if (!trimmed.endsWith(")")) return trimmed;
  let depth = 0;
  for (let index = trimmed.length - 1; index >= 0; index--) {
    if (trimmed[index - 1] === "\\") continue;
    if (trimmed[index] === ")") depth++;
    else if (trimmed[index] === "(" && --depth === 0) {
      return index > 0 && /\s/.test(trimmed[index - 1])
        ? trimmed.slice(0, index).trimEnd()
        : trimmed;
    }
  }
  return trimmed;
}

function replaceTokens(content: string, tokens: EmbedToken[], replacement: string): string {
  let next = content;
  for (const token of [...tokens].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, token.start) + replacement + next.slice(token.end);
  }
  return next;
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

async function readCurrent(vault: Vault, file: TFile): Promise<string> {
  // `vault.process` is atomic, but MetadataCache/cachedRead can lag behind its
  // completion. A direct Vault read makes commit verification and final cleanup
  // decisions against the durable snapshot. The fallback keeps lightweight test
  // doubles and older Obsidian adapters compatible.
  const direct = (vault as Vault & { read?: (target: TFile) => Promise<string> }).read;
  return direct ? direct.call(vault, file) : vault.cachedRead(file);
}
