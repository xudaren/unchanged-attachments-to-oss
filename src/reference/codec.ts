const OSS_SCHEME = "oss://";

export interface OssReference {
  start: number;
  end: number;
  key: string;
  alt: string;
  url: string;
}

export interface RemoveOssReferenceResult {
  content: string;
  removed: boolean;
  reference?: OssReference;
}

/** Encode every Object Key segment while preserving `/` as the hierarchy separator. */
export function encodeObjectKey(key: string): string {
  const normalized = normalizeObjectKey(key);
  if (!normalized) throw new Error("Object Key 不能为空");
  return normalized.split("/").map(percentEncodeSegment).join("/");
}

/** Canonical permanent URL. Three slashes avoid treating the first key segment as a URL host. */
export function formatOssUrl(key: string): string {
  return `${OSS_SCHEME}/${encodeObjectKey(key)}`;
}

/** Parse canonical and legacy OSS URLs back to the raw Object Key. */
export function parseOssUrl(source: string): string | null {
  // Object Keys are opaque bytes. Silently trimming a URL or stripping every
  // leading slash can redirect a render/delete operation to a different key.
  if (source !== source.trim() || !source.toLowerCase().startsWith(OSS_SCHEME)) return null;
  const remainder = source.slice(OSS_SCHEME.length);
  // Canonical URLs add exactly one path separator after `oss://`. Additional
  // slashes belong to the Object Key itself and must be preserved.
  const encoded = remainder.startsWith("/") ? remainder.slice(1) : remainder;
  if (!encoded) return null;
  try {
    const key = normalizeObjectKey(decodeURIComponent(encoded));
    return isUrlSafeObjectKey(key) ? key : null;
  } catch {
    // A malformed escape is not a safe legacy fallback: interpreting it as a
    // literal percent sequence could make a destructive action target another
    // Object. The caller keeps the canonical source untouched instead.
    return null;
  }
}

export function formatOssReference(key: string, alt = ""): string {
  return `![${escapeMarkdownLabel(alt)}](${formatOssUrl(key)})`;
}

/**
 * Scan rendered Markdown image references while ignoring frontmatter, comments,
 * fenced code and inline code. Canvas/Base JSON still works because Markdown
 * references in their text properties retain the same `![](...)` form.
 */
export function scanOssReferences(content: string): OssReference[] {
  const excluded = markdownExcludedRanges(content);
  const references: OssReference[] = [];
  let excludedIndex = 0;

  for (let start = 0; start < content.length - 4; start++) {
    while (excludedIndex < excluded.length && excluded[excludedIndex].end <= start) excludedIndex++;
    if (excludedIndex < excluded.length && excluded[excludedIndex].start <= start) {
      start = excluded[excludedIndex].end - 1;
      continue;
    }
    if (content[start] !== "!" || content[start + 1] !== "[") continue;
    const labelEnd = findUnescaped(content, "]", start + 2);
    if (labelEnd < 0 || content[labelEnd + 1] !== "(") continue;
    const destinationEnd = findBalancedParenEnd(content, labelEnd + 1);
    if (destinationEnd < 0) continue;

    const destination = markdownDestination(content.slice(labelEnd + 2, destinationEnd).trim());
    const key = destination ? parseOssUrl(destination) : null;
    if (!key) {
      start = destinationEnd;
      continue;
    }
    references.push({
      start,
      end: destinationEnd + 1,
      key,
      alt: unescapeMarkdownLabel(content.slice(start + 2, labelEnd)),
      url: destination,
    });
    start = destinationEnd;
  }
  return references;
}

/** Remove one exact key, optionally preferring the occurrence nearest a known source offset. */
export function removeFirstOssReference(
  content: string,
  key: string,
  preferredStart?: number,
): RemoveOssReferenceResult {
  const normalized = normalizeObjectKey(key);
  const matches = scanOssReferences(content).filter((reference) => reference.key === normalized);
  if (matches.length === 0) return { content, removed: false };
  const reference = preferredStart === undefined
    ? matches[0]
    : matches.reduce((closest, candidate) =>
      Math.abs(candidate.start - preferredStart) < Math.abs(closest.start - preferredStart) ? candidate : closest
    );
  return {
    content: content.slice(0, reference.start) + content.slice(reference.end),
    removed: true,
    reference,
  };
}

export function normalizeObjectKey(value: string): string {
  return value;
}

function isUrlSafeObjectKey(value: string): boolean {
  return value.length > 0 && !value.split("/").some((segment) => segment === "." || segment === "..");
}

function markdownDestination(raw: string): string {
  if (!raw) return "";
  if (raw.startsWith("<")) {
    const close = findUnescaped(raw, ">", 1);
    return close < 0 ? "" : raw.slice(1, close);
  }
  return raw.replace(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/, "");
}

function percentEncodeSegment(value: string): string {
  if (value === "." || value === "..") {
    throw new Error("Object Key 不能包含 . 或 .. URL 路径段");
  }
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return encoded;
}

function findUnescaped(value: string, char: string, from: number): number {
  for (let index = from; index < value.length; index++) {
    if (value[index] === char && !isEscaped(value, index)) return index;
  }
  return -1;
}

function findBalancedParenEnd(value: string, open: number): number {
  let depth = 0;
  let angle = false;
  for (let index = open; index < value.length; index++) {
    if (isEscaped(value, index)) continue;
    const char = value[index];
    if (char === "<") angle = true;
    else if (char === ">") angle = false;
    else if (!angle && char === "(") depth++;
    else if (!angle && char === ")" && --depth === 0) return index;
  }
  return -1;
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) slashes++;
  return slashes % 2 === 1;
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function unescapeMarkdownLabel(value: string): string {
  return value.replace(/\\([[\]\\])/g, "$1");
}

interface TextRange {
  start: number;
  end: number;
}

function markdownExcludedRanges(content: string): TextRange[] {
  const ranges: TextRange[] = [];
  if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
    // Search for the closing --- only after the opening line, and only at
    // the start of a line (multiline ^). This prevents a YAML block scalar
    // whose body contains an indented "---" line from being misidentified
    // as the frontmatter terminator.
    const firstLineEnd = content.indexOf("\n") + 1;
    const rest = content.slice(firstLineEnd);
    const closingMatch = rest.match(/^---(?:\r?\n|$)/m);
    if (closingMatch) {
      const closingIndex = firstLineEnd + closingMatch.index!;
      ranges.push({ start: 0, end: closingIndex + 3 });
    }
  }

  collectRegexRanges(content, /<!--[\s\S]*?-->/g, ranges);
  collectRegexRanges(content, /^(?: {0,3})(`{3,}|~{3,})[^\r\n]*(?:\r?\n)[\s\S]*?^(?: {0,3})\1[ \t]*(?=\r?$)/gm, ranges);
  collectRegexRanges(content, /(`+)(?!`)(?:[^`]|`(?!\1))*?\1/g, ranges);
  return mergeRanges(ranges);
}

function collectRegexRanges(content: string, pattern: RegExp, ranges: TextRange[]): void {
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
