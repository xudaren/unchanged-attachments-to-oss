import { formatOssUrl } from "../reference/codec";
import { clearOssRenderError, showOssRenderError } from "./error-state";
import { ossKeyFromImageSource } from "./oss-source";
import { defaultPdfRenderer, PdfRenderer } from "./pdf-link";
import type { AttachmentContextMenuBinder, AttachmentKind } from "./context-menu";
import {
  cancelMediaLoading,
  loadImageNearViewport,
  loadMediaOnInteraction,
  loadVideoNearViewport,
} from "./media-loading";
import { mediaDisplayName, mountMediaLabel } from "./media-label";
import { RenderSessionLifetime } from "./lifetime";
import {
  beginRenderState,
  cleanupRenderState,
  isCurrentRender,
  ownsCurrentSource,
  renderStateKey,
  setRenderCleanup,
} from "./render-state";
import type { LeaseUrlResolver, SignedUrlLease } from "./url-resolver";
import {
  isUrlResolverDisposed,
  resolveUrlLease,
  SignedUrlResolverDisposedError,
} from "./url-resolver";

const MEDIA_TAGS = new Set(["IMG", "VIDEO", "AUDIO", "A", "EMBED", "SPAN"]);
export const RENDER_SURFACE_SELECTOR = ".markdown-source-view, .canvas-node";
const OSS_MEDIA_SELECTOR = [
  'img[src^="oss://"]',
  'video[src^="oss://"]',
  'audio[src^="oss://"]',
  'a[href^="oss://"]',
  'embed[src^="oss://"]',
  '.internal-embed[src^="oss://"]',
].join(",");

export interface UrlResolver extends LeaseUrlResolver {}

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
      ) roots.add(target as unknown as ParentNode);
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
  if (element.nodeType === 1 && element.matches?.(RENDER_SURFACE_SELECTOR)) surfaces.push(root);
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
  contextMenu?: AttachmentContextMenuBinder,
  lifetime?: RenderSessionLifetime,
): Promise<void> {
  if (lifetime && !lifetime.isActive) return;
  const elements: Element[] = [];
  if (isHydrationCandidate(root)) elements.push(root as unknown as Element);
  if (typeof root.querySelectorAll === "function") {
    elements.push(...Array.from(root.querySelectorAll(OSS_MEDIA_SELECTOR)));
  }
  await Promise.allSettled(elements.map((element) =>
    hydrateElement(element, resolver, pdfRenderer, contextMenu, undefined, lifetime)
  ));
}

/**
 * Configuration actions may reset all currently rendered sessions once. This is
 * intentionally separate from the incremental MutationObserver callback.
 */
export async function resetOssRenderSessions(
  root: ParentNode,
  resolver: UrlResolver,
  pdfRenderer: PdfRenderer = defaultPdfRenderer,
  contextMenu?: AttachmentContextMenuBinder,
  lifetime?: RenderSessionLifetime,
): Promise<void> {
  if (lifetime && !lifetime.isActive) return;
  await resetRenderOwners(outermostRenderOwners(root), resolver, pdfRenderer, contextMenu, lifetime);
}

/** Reset attached and detached sessions after a verified configuration switch. */
export async function resetOssRenderLifetime(
  lifetime: RenderSessionLifetime,
  resolver: UrlResolver,
  pdfRenderer: PdfRenderer = defaultPdfRenderer,
  contextMenu?: AttachmentContextMenuBinder,
): Promise<void> {
  if (!lifetime.isActive) return;
  const owners = outermostOwners(lifetime.snapshot());
  await resetRenderOwners(owners, resolver, pdfRenderer, contextMenu, lifetime);
}

async function resetRenderOwners(
  owners: readonly HTMLElement[],
  resolver: UrlResolver,
  pdfRenderer: PdfRenderer,
  contextMenu?: AttachmentContextMenuBinder,
  lifetime?: RenderSessionLifetime,
): Promise<void> {
  await Promise.allSettled(owners.map(async (element) => {
    const key = renderStateKey(element);
    if (!key) return;
    const sourcePath = contextMenu?.sourcePathFor?.(element, key);
    const displayName = renderedDisplayName(element);
    cleanupRenderState(element);
    const restored = restoreCanonicalRenderSource(element, key, displayName);
    await hydrateElement(restored, resolver, pdfRenderer, contextMenu, sourcePath, lifetime);
  }));
}

/**
 * Synchronously release every live renderer owned by this plugin instance.
 * The canonical source remains in the DOM so a hot-reloaded instance can own it.
 */
export function disposeOssRenderSessions(
  root: ParentNode,
  contextMenu?: AttachmentContextMenuBinder,
): void {
  for (const element of outermostRenderOwners(root)) {
    disposeRenderOwner(element, contextMenu);
  }
}

/** Release only sessions contained by nodes removed in this observer delivery. */
export function disposeRemovedOssRenderSessions(
  records: readonly MutationRecord[],
  contextMenu?: AttachmentContextMenuBinder,
): void {
  for (const record of records) {
    if (record.type !== "childList") continue;
    for (const node of Array.from(record.removedNodes ?? [])) {
      if (node.nodeType !== 1 && node.nodeType !== 11) continue;
      disposeOssRenderSessions(node as ParentNode, contextMenu);
    }
  }
}

function outermostRenderOwners(root: ParentNode): HTMLElement[] {
  const tracked: HTMLElement[] = [];
  const rootElement = root as unknown as HTMLElement;
  if (rootElement.nodeType === 1 && renderStateKey(rootElement)) tracked.push(rootElement);
  if (typeof root.querySelectorAll === "function") {
    tracked.push(...Array.from(root.querySelectorAll<HTMLElement>("[data-oss-render-key]")));
  }
  return outermostOwners(tracked);
}

function outermostOwners(tracked: readonly HTMLElement[]): HTMLElement[] {
  return tracked.filter((element) =>
    !tracked.some((candidate) => candidate !== element && candidate.contains?.(element))
  );
}

function renderedDisplayName(element: HTMLElement): string {
  return element.dataset.ossDisplayName?.trim() || mediaDisplayName(element) ||
    element.querySelector?.<HTMLElement>(".oss-pdf-name")?.textContent?.trim() || "";
}

function restoreCanonicalRenderSource(
  element: HTMLElement,
  key: string,
  displayName: string,
): HTMLElement {
  const canonicalSource = formatOssUrl(key);
  if (mediaKind(key) === "embed" && !isLivePreviewEmbedHost(element) && !isNativePdfPlaceholder(element)) {
    const placeholder = element.ownerDocument.createElement("img");
    if (displayName) placeholder.setAttribute("alt", displayName);
    placeholder.setAttribute("src", canonicalSource);
    element.replaceWith(placeholder);
    return placeholder;
  }
  if (displayName) element.setAttribute("alt", displayName);
  element.setAttribute(element.tagName === "A" ? "href" : "src", canonicalSource);
  return element;
}

function isNativePdfPlaceholder(element: HTMLElement): boolean {
  return element.tagName === "IMG" || element.tagName === "A" || element.tagName === "EMBED";
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
  contextMenu?: AttachmentContextMenuBinder,
  sourcePath?: string,
  lifetime?: RenderSessionLifetime,
): Promise<void> {
  const html = element as HTMLElement;
  if (isUrlResolverDisposed(resolver) || (lifetime && !lifetime.isActive)) return;
  const attribute = element.tagName === "A" ? "href" : "src";
  const source = element.getAttribute(attribute);
  const key = source ? ossKeyFromImageSource(source) : null;
  if (!key || key.startsWith("uploading/")) {
    if (ownsCurrentSource(html)) return;
    cleanupRenderState(html);
    cancelMediaLoading(element);
    clearOssRenderError(element);
    return;
  }

  const desired = mediaKind(key);
  beginRenderState(html, key, attribute);
  if (!trackRenderSession(html, lifetime, contextMenu)) return;
  if (desired) bindContextMenu(html, desired, key, contextMenu, sourcePath);
  if (html.dataset.ossSigningKey === key) return;
  html.dataset.ossSigningKey = key;

  try {
    const lease = await resolveUrlLease(resolver, key);
    if (isUrlResolverDisposed(resolver) || (lifetime && !lifetime.isActive)) {
      abandonPendingRender(html);
      return;
    }
    if (html.dataset.ossSigningKey !== key || !isCurrentRender(html, key)) return;

    clearOssRenderError(element);
    const current = tagKind(element.tagName);
    const displayName = mediaDisplayName(element);
    if (desired && isLivePreviewEmbedHost(element)) {
      const replacement = buildMediaElement(element, desired, lease, key, resolver, pdfRenderer);
      const slot = mountInLivePreviewSlot(html, replacement);
      setRenderCleanup(html, "slot", () => {
        cleanupRenderedMedia(replacement, contextMenu);
        slot.remove();
      });
      applyLivePreviewHostLayout(html, desired, html);
      configureRenderedMedia(replacement, desired, key, resolver, lease, contextMenu, sourcePath, false, lifetime);
      const hostClass = `oss-${contextKind(desired)}-live-preview-host`;
      html.classList.add(hostClass);
      setRenderCleanup(html, "host-kind", () => html.classList.remove(hostClass));
      if (desired !== "embed") mountTrackedLabel(replacement, displayName, key, slot);
    } else if (desired === "embed" || (desired && desired !== current && (current === "img" || current === "a"))) {
      const replacement = buildMediaElement(element, desired, lease, key, resolver, pdfRenderer);
      beginRenderState(replacement, key, replacement.tagName === "A" ? "href" : "src");
      if (!trackRenderSession(replacement, lifetime, contextMenu)) return;
      applyLivePreviewHostLayout(element, desired, replacement);
      element.replaceWith(replacement);
      cleanupRenderState(html);
      configureRenderedMedia(replacement, desired, key, resolver, lease, contextMenu, sourcePath, false, lifetime);
      if (desired !== "embed") mountTrackedLabel(replacement, displayName, key);
    } else if (element.tagName === "A") {
      const anchor = element as HTMLAnchorElement;
      anchor.href = lease.url;
      anchor.target = "_blank";
    } else if (desired) {
      configureRenderedMedia(html, desired, key, resolver, lease, contextMenu, sourcePath, true, lifetime);
      applyLivePreviewHostLayout(html, desired, html);
      mountTrackedLabel(html, displayName, key);
    }
  } catch (error) {
    if (
      error instanceof SignedUrlResolverDisposedError ||
      isUrlResolverDisposed(resolver) ||
      (lifetime && !lifetime.isActive)
    ) {
      abandonPendingRender(html);
      return;
    }
    if (html.dataset.ossSigningKey !== key || !isCurrentRender(html, key)) return;
    const prefix = error instanceof Error && error.message.startsWith("OSS 未配置")
      ? "OSS 未配置"
      : "OSS 媒体签名失败";
    showOssRenderError(element, key, `${prefix}: ${key}`);
  } finally {
    if (html.dataset.ossSigningKey === key) delete html.dataset.ossSigningKey;
  }
}

function trackRenderSession(
  element: HTMLElement,
  lifetime?: RenderSessionLifetime,
  contextMenu?: AttachmentContextMenuBinder,
): boolean {
  if (!lifetime) return true;
  // Replacing this cleanup releases a previous binding before the same element
  // is re-tracked, so repeated hydration cannot accumulate strong references.
  setRenderCleanup(element, "render-lifetime", () => lifetime.release(element));
  return lifetime.track(element, () => disposeRenderOwner(element, contextMenu));
}

function disposeRenderOwner(
  element: HTMLElement,
  contextMenu?: AttachmentContextMenuBinder,
): void {
  const key = renderStateKey(element);
  if (!key) return;
  const displayName = renderedDisplayName(element);
  cleanupRenderState(element);
  cancelMediaLoading(element);
  if (element.dataset.ossContextMenuBound === "true") contextMenu?.unbind?.(element);
  clearOssRenderError(element);
  restoreCanonicalRenderSource(element, key, displayName);
}

function bindContextMenu(
  element: HTMLElement,
  kind: Exclude<MediaKind, "a">,
  key: string,
  contextMenu?: AttachmentContextMenuBinder,
  sourcePath?: string,
): void {
  if (!contextMenu) return;
  // Replace the old cleanup before binding. Doing this in the opposite order
  // lets the previous cleanup immediately remove the just-reused listener.
  setRenderCleanup(element, "context-menu", () => contextMenu.unbind?.(element));
  contextMenu.bind(element, contextKind(kind), "", key, sourcePath);
}

function abandonPendingRender(element: HTMLElement): void {
  cleanupRenderState(element);
  cancelMediaLoading(element);
  clearOssRenderError(element);
}

function configureRenderedMedia(
  element: HTMLElement,
  kind: Exclude<MediaKind, "a">,
  key: string,
  resolver: UrlResolver,
  lease: SignedUrlLease,
  contextMenu?: AttachmentContextMenuBinder,
  sourcePath?: string,
  contextAlreadyBound = false,
  lifetime?: RenderSessionLifetime,
): void {
  beginRenderState(element, key, element.tagName === "A" ? "href" : "src");
  if (!trackRenderSession(element, lifetime, contextMenu)) return;
  if (!contextAlreadyBound) bindContextMenu(element, kind, key, contextMenu, sourcePath);
  setRenderCleanup(element, "media-loader", () => cancelMediaLoading(element));
  if (kind === "img") loadImageNearViewport(element as HTMLImageElement, key, resolver, lease);
  else if (kind === "video") loadVideoNearViewport(element as HTMLVideoElement, key, resolver, lease);
  else if (kind === "audio") loadMediaOnInteraction(element as HTMLMediaElement, key, resolver, lease);
}

function cleanupRenderedMedia(element: HTMLElement, _contextMenu?: AttachmentContextMenuBinder): void {
  cleanupRenderState(element);
}

function mountTrackedLabel(media: HTMLElement, name: string, key: string, host?: Element): void {
  if (name) media.dataset.ossDisplayName = name;
  setRenderCleanup(media, "display-name", () => delete media.dataset.ossDisplayName);
  const label = mountMediaLabel(media, name, key, host);
  if (label) {
    const container = label.parentElement;
    const generatedFrame = container?.dataset.ossMediaFrame === "true";
    setRenderCleanup(media, "media-label", () => {
      label.remove();
      if (!container || container.querySelector?.(":scope > .oss-media-label")) return;
      container.classList.remove("oss-media-caption-host");
      if (generatedFrame && media.parentElement === container && container.parentElement) {
        container.parentElement.insertBefore(media, container);
        container.remove();
      }
    });
  }
}

function isLivePreviewEmbedHost(element: Element): boolean {
  return element.matches?.('.internal-embed[src^="oss://"]') === true;
}

function mountInLivePreviewSlot(host: HTMLElement, media: HTMLElement): HTMLElement {
  let slot = host.querySelector<HTMLElement>(":scope > .oss-render-slot");
  if (!slot) {
    slot = host.ownerDocument.createElement("span");
    slot.className = "oss-render-slot";
    host.appendChild(slot);
  }
  slot.replaceChildren(media);
  return slot;
}

function contextKind(kind: Exclude<MediaKind, "a">): AttachmentKind {
  return kind === "embed" ? "pdf" : kind;
}

type MediaKind = "img" | "video" | "audio" | "embed" | "a";

function mediaKind(key: string): Exclude<MediaKind, "a"> | null {
  const dot = key.lastIndexOf(".");
  const ext = dot >= 0 ? key.slice(dot + 1).toLowerCase() : "";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp"].includes(ext)) return "img";
  if (["mp4", "mov", "webm", "mkv", "ogv", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg", "flac", "aac", "opus"].includes(ext)) return "audio";
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
  lease: SignedUrlLease,
  key: string,
  resolver: UrlResolver,
  pdfRenderer: PdfRenderer,
): HTMLElement {
  const doc = from.ownerDocument;
  if (kind === "img") {
    const image = doc.createElement("img");
    image.alt = from.getAttribute("alt") ?? "";
    image.setAttribute("src", formatOssUrl(key));
    return image;
  }
  if (kind === "video") {
    const video = doc.createElement("video");
    video.controls = true;
    video.style.maxWidth = "100%";
    return video;
  }
  if (kind === "audio") {
    const audio = doc.createElement("audio");
    audio.controls = true;
    return audio;
  }
  return pdfRenderer.mount(
    from,
    lease.url,
    key,
    from.getAttribute("alt") ?? from.textContent ?? undefined,
    resolver,
    lease,
  );
}

type HostKind = "audio" | "pdf";
const hostClassRefs = new WeakMap<Element, Map<string, number>>();

function applyLivePreviewHostLayout(
  from: Element,
  kind: Exclude<MediaKind, "a">,
  owner: HTMLElement,
): void {
  const hostKind: HostKind | null = kind === "audio" ? "audio" : kind === "embed" ? "pdf" : null;
  if (!hostKind || !from.closest(".markdown-source-view")) return;
  const prefix = `oss-${hostKind}-live-preview`;
  const targets: Array<[Element | null, string]> = [
    [from.closest(".image-wrapper"), `${prefix}-wrapper`],
    [from.closest(".cm-embed-block"), `${prefix}-block`],
    [from.closest(".internal-embed, .image-embed"), `${prefix}-host`],
    [from.closest(".cm-line"), `${prefix}-line`],
  ];
  const cleanups = targets
    .filter((entry): entry is [Element, string] => Boolean(entry[0]))
    .map(([target, className]) => retainHostClass(target, className));
  setRenderCleanup(owner, "live-preview-layout", () => cleanups.forEach((cleanup) => cleanup()));
}

function retainHostClass(element: Element, className: string): () => void {
  const refs = hostClassRefs.get(element) ?? new Map<string, number>();
  refs.set(className, (refs.get(className) ?? 0) + 1);
  hostClassRefs.set(element, refs);
  element.classList.add(className);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const next = (refs.get(className) ?? 1) - 1;
    if (next <= 0) {
      refs.delete(className);
      element.classList.remove(className);
    } else refs.set(className, next);
  };
}

function isHydrationCandidate(node: ParentNode): boolean {
  const candidate = node as unknown as Element;
  if (candidate.nodeType !== 1 || (!MEDIA_TAGS.has(candidate.tagName) && !isLivePreviewEmbedHost(candidate))) return false;
  if (renderStateKey(candidate as HTMLElement)) return true;
  const attribute = candidate.tagName === "A" ? "href" : "src";
  return candidate.getAttribute(attribute)?.startsWith("oss://") === true ||
    candidate.getAttribute("data-oss-render-error") === "true";
}
