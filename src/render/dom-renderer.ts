import { clearOssRenderError, showOssRenderError } from "./error-state";
import { ossKeyFromImageSource } from "./oss-source";
import { defaultPdfRenderer, PdfRenderer } from "./pdf-link";

const MEDIA_TAGS = new Set(["IMG", "VIDEO", "AUDIO", "A", "EMBED"]);
export const RENDER_SURFACE_SELECTOR = ".markdown-source-view, .canvas-node";
const OSS_MEDIA_SELECTOR = [
  'img[src^="oss://"]',
  'video[src^="oss://"]',
  'audio[src^="oss://"]',
  'a[href^="oss://"]',
  'embed[src^="oss://"]',
].join(",");

export interface UrlResolver {
  resolve(key: string): Promise<string>;
}

/** Pick only nodes affected by one MutationObserver delivery. */
export function selectMutationRoots(records: readonly MutationRecord[]): ParentNode[] {
  const roots = new Set<ParentNode>();
  for (const record of records) {
    if (record.type === "attributes") {
      const target = record.target as Node & { tagName?: string };
      if (
        target.nodeType === 1 &&
        target.tagName &&
        MEDIA_TAGS.has(target.tagName) &&
        isInRenderSurface(target)
      ) {
        roots.add(target as unknown as ParentNode);
      }
      continue;
    }
    if (record.type !== "childList") continue;
    const targetIsInSurface = isInRenderSurface(record.target);
    for (const node of Array.from(record.addedNodes)) {
      if (node.nodeType !== 1 && node.nodeType !== 11) continue;
      if (targetIsInSurface || isInRenderSurface(node)) {
        roots.add(node as ParentNode);
        continue;
      }
      for (const surface of findRenderSurfaces(node as ParentNode)) roots.add(surface);
    }
  }
  return Array.from(roots);
}

/** Return only Live Preview and Canvas roots contained in one parent. */
export function findRenderSurfaces(root: ParentNode): ParentNode[] {
  const surfaces: ParentNode[] = [];
  const element = root as unknown as Element;
  if (element.nodeType === 1 && element.matches?.(RENDER_SURFACE_SELECTOR)) {
    surfaces.push(root);
  }
  if (typeof root.querySelectorAll === "function") {
    surfaces.push(...Array.from(root.querySelectorAll(RENDER_SURFACE_SELECTOR)));
  }
  return surfaces;
}

/** Hydrate only one changed/added subtree, including the root element itself. */
export async function hydrateOssSubtree(
  root: ParentNode,
  resolver: UrlResolver,
  pdfRenderer: PdfRenderer = defaultPdfRenderer,
): Promise<void> {
  const elements: Element[] = [];
  if (isHydrationCandidate(root)) elements.push(root as unknown as Element);
  if (typeof root.querySelectorAll === "function") {
    elements.push(...Array.from(root.querySelectorAll(OSS_MEDIA_SELECTOR)));
  }
  await Promise.allSettled(elements.map((element) => hydrateElement(element, resolver, pdfRenderer)));
}

function isInRenderSurface(node: Node): boolean {
  const element = node.nodeType === 1
    ? node as Element
    : (node as Node & { parentElement?: Element | null }).parentElement;
  return Boolean(element?.matches?.(RENDER_SURFACE_SELECTOR) || element?.closest?.(RENDER_SURFACE_SELECTOR));
}

async function hydrateElement(
  element: Element,
  resolver: UrlResolver,
  pdfRenderer: PdfRenderer,
): Promise<void> {
  const html = element as HTMLElement;
  const attribute = element.tagName === "A" ? "href" : "src";
  const source = element.getAttribute(attribute);
  const key = source ? ossKeyFromImageSource(source) : null;
  if (!key || key.startsWith("uploading/")) {
    delete html.dataset.ossSigningKey;
    clearOssRenderError(element);
    return;
  }
  if (html.dataset.ossSigningKey === key) return;

  html.dataset.ossSigningKey = key;
  try {
    const url = await resolver.resolve(key);
    if (html.dataset.ossSigningKey !== key) return;
    const currentSource = element.getAttribute(attribute);
    if (!currentSource || ossKeyFromImageSource(currentSource) !== key) return;

    clearOssRenderError(element);
    const desired = mediaKind(key);
    const current = tagKind(element.tagName);
    if (desired === "embed" || (desired && desired !== current && (current === "img" || current === "a"))) {
      element.replaceWith(buildMediaElement(element, desired, url, key, pdfRenderer));
    } else if (element.tagName === "A") {
      const anchor = element as HTMLAnchorElement;
      anchor.href = url;
      anchor.target = "_blank";
    } else {
      (element as HTMLImageElement).src = url;
    }
  } catch (error) {
    const currentSource = element.getAttribute(attribute);
    if (
      html.dataset.ossSigningKey !== key ||
      !currentSource ||
      ossKeyFromImageSource(currentSource) !== key
    ) return;
    const prefix = error instanceof Error && error.message.startsWith("OSS 未配置")
      ? "OSS 未配置"
      : "OSS 媒体签名失败";
    showOssRenderError(element, key, `${prefix}: ${key}`);
  } finally {
    if (html.dataset.ossSigningKey === key) delete html.dataset.ossSigningKey;
  }
}

type MediaKind = "img" | "video" | "audio" | "embed" | "a";

function mediaKind(key: string): Exclude<MediaKind, "a"> | null {
  const dot = key.lastIndexOf(".");
  const ext = dot >= 0 ? key.slice(dot + 1).toLowerCase() : "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "img";
  if (["mp4", "mov", "webm", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg", "flac"].includes(ext)) return "audio";
  if (ext === "pdf") return "embed";
  return null;
}

function tagKind(tagName: string): MediaKind | null {
  const kind = tagName.toLowerCase();
  return kind === "img" || kind === "video" || kind === "audio" || kind === "embed" || kind === "a"
    ? kind
    : null;
}

function buildMediaElement(
  from: Element,
  kind: Exclude<MediaKind, "a">,
  url: string,
  key: string,
  pdfRenderer: PdfRenderer,
): HTMLElement {
  const doc = from.ownerDocument;
  if (kind === "img") {
    const image = doc.createElement("img");
    image.src = url;
    image.alt = from.getAttribute("alt") ?? "";
    return image;
  }
  if (kind === "video") {
    const video = doc.createElement("video");
    video.src = url;
    video.controls = true;
    video.style.maxWidth = "100%";
    return video;
  }
  if (kind === "audio") {
    const audio = doc.createElement("audio");
    audio.src = url;
    audio.controls = true;
    return audio;
  }
  return pdfRenderer.mount(from, url, key);
}

function isHydrationCandidate(node: ParentNode): boolean {
  const candidate = node as unknown as Element;
  if (candidate.nodeType !== 1 || !MEDIA_TAGS.has(candidate.tagName)) return false;
  const attribute = candidate.tagName === "A" ? "href" : "src";
  return candidate.getAttribute(attribute)?.startsWith("oss://") === true ||
    candidate.getAttribute("data-oss-render-error") === "true";
}
