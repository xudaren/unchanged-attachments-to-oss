const OSS_SCHEME = "oss://";
const HTTPS_SCHEME = "https://";

// The plugin owns exactly one storage identity per Vault, so the reference
// hosts are global runtime state installed whenever settings load or change.
// The primary host formats new references (the access host: custom domain or
// default); the recognition set additionally always keeps the permanent
// default `{bucket}.{endpoint}` host so legacy public-URL references survive
// an access-host change. Pure call sites may still pass an explicit host.
let configuredReferenceHost = "";
let configuredRecognitionHosts: string[] = [];

/** Install a single host as both primary and the only recognition host. */
export function setOssReferenceHost(host: string): void {
  const normalized = normalizeReferenceHost(host);
  configuredReferenceHost = normalized;
  configuredRecognitionHosts = normalized ? [normalized] : [];
}

/**
 * Install the primary access host used to format references plus the full
 * recognition host set. Callers must keep the default `{bucket}.{endpoint}`
 * host in the set so existing-data references stay recognizable.
 */
export function setOssReferenceHosts(primary: string, recognized: readonly string[]): void {
  configuredReferenceHost = normalizeReferenceHost(primary);
  const hosts = new Set<string>();
  for (const host of recognized) {
    try {
      const normalized = normalizeReferenceHost(host);
      if (normalized) hosts.add(normalized);
    } catch {
      // Defensive: a malformed recognition entry must not break parsing.
    }
  }
  configuredRecognitionHosts = [...hosts];
}

export function getOssReferenceHost(): string {
  return configuredReferenceHost;
}

/**
 * Document commit boundary guard: new references must always be public URLs,
 * so a missing access host is a hard failure instead of a silent `oss://`
 * fallback write.
 */
export function assertOssReferenceHostInstalled(): void {
  if (!configuredReferenceHost) {
    throw new Error("OSS 引用 host 未就绪：请先完成 Bucket 配置后再写入新引用");
  }
}

export function normalizeReferenceHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return "";
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(normalized)) {
    throw new Error("引用 host 无效：需为 {bucket}.{endpoint} 形态");
  }
  return normalized;
}

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

/** Canonical legacy URL. Three slashes avoid treating the first key segment as a URL host. */
export function formatOssUrl(key: string): string {
  return `${OSS_SCHEME}/${encodeObjectKey(key)}`;
}

/** Canonical permanent reference for new uploads: the unsigned public object URL. */
export function formatPublicUrl(key: string, host: string): string {
  const normalizedHost = normalizeReferenceHost(host);
  if (!normalizedHost) throw new Error("公共 URL 需要有效的 {bucket}.{endpoint} host");
  return `https://${normalizedHost}/${encodeObjectKey(key)}`;
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

/** Parse an unsigned public object URL of the given storage host back to the raw Object Key. */
export function parsePublicUrl(source: string, host: string): string | null {
  if (source !== source.trim()) return null;
  let normalizedHost: string;
  try {
    normalizedHost = normalizeReferenceHost(host);
  } catch {
    return null;
  }
  if (!normalizedHost) return null;
  const prefix = `${HTTPS_SCHEME}${normalizedHost}/`;
  if (!source.toLowerCase().startsWith(prefix)) return null;
  // Signing only ever appends query parameters; tolerate them while extracting the path.
  let encoded = source.slice(prefix.length);
  const queryIndex = encoded.search(/[?#]/);
  if (queryIndex >= 0) encoded = encoded.slice(0, queryIndex);
  if (!encoded) return null;
  try {
    const key = normalizeObjectKey(decodeURIComponent(encoded));
    return isUrlSafeObjectKey(key) ? key : null;
  } catch {
    return null;
  }
}

/** Recognize either reference form. `host` limits matching to that host; otherwise the installed recognition set applies. */
export function parseOssReferenceUrl(source: string, host?: string): string | null {
  const legacy = parseOssUrl(source);
  if (legacy !== null) return legacy;
  const candidates = host !== undefined
    ? [host]
    : configuredRecognitionHosts.length > 0
      ? configuredRecognitionHosts
      : [configuredReferenceHost];
  for (const candidate of candidates) {
    const key = parsePublicUrl(source, candidate);
    if (key !== null) return key;
  }
  return null;
}

export function formatOssReference(key: string, alt = "", host?: string): string {
  const effectiveHost = normalizeReferenceHost(host ?? configuredReferenceHost);
  const url = effectiveHost ? formatPublicUrl(key, effectiveHost) : formatOssUrl(key);
  return `![${escapeMarkdownLabel(alt)}](${url})`;
}

/**
 * Scan rendered Markdown image references while ignoring frontmatter, comments,
 * fenced code and inline code. Canvas/Base JSON still works because Markdown
 * references in their text properties retain the same `![](...)` form.
 */
export function scanOssReferences(content: string, host?: string): OssReference[] {
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
    const key = destination ? parseOssReferenceUrl(destination, host) : null;
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
  host?: string,
): RemoveOssReferenceResult {
  const normalized = normalizeObjectKey(key);
  const matches = scanOssReferences(content, host).filter((reference) => reference.key === normalized);
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

/**
 * Rewrite every recognized reference (legacy `oss://` and public URLs on
 * retired access hosts) into the canonical public URL form on the given
 * access host. Idempotent; already-normal references stay byte-identical.
 */
export function normalizeOssReferencesToAccessHost(content: string, host: string): string {
  const normalizedHost = normalizeReferenceHost(host);
  const references = scanOssReferences(content).filter(
    (reference) => reference.url !== formatPublicUrl(reference.key, normalizedHost),
  );
  if (references.length === 0) return content;
  let result = "";
  let cursor = 0;
  for (const reference of references) {
    result += content.slice(cursor, reference.start);
    result += `![${escapeMarkdownLabel(reference.alt)}](${formatPublicUrl(reference.key, normalizedHost)})`;
    cursor = reference.end;
  }
  return result + content.slice(cursor);
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
