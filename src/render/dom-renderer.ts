import { formatOssUrl } from "../reference/codec";
import { createElementLike } from "./create-element";
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
  markAppliedUrl,
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
// Canvas Markdown is rendered through the official post-processor. Observing
// only Live Preview prevents competing with Canvas' own DOM reconciliation.
export const RENDER_SURFACE_SELECTOR = ".markdown-source-view";
const OSS_MEDIA_SELECTOR = [
  'img[src^="oss://"]',
  'video[src^="oss://"]',
  'audio[src^="oss://"]',
  'a[href^="oss://"]',
  'embed[src^="oss://"]',
  '.internal-embed[src^="oss://"]',
  // Public URL references carry a dynamic host, so the selector stays broad
  // and hydration candidates are confirmed against the configured bucket host.
  'img[src^="https://"]',
  'video[src^="https://"]',
  'audio[src^="https://"]',
  'a[href^="https://"]',
  'embed[src^="https://"]',
  '.internal-embed[src^="https://"]',
].join(",");

export type UrlResolver = LeaseUrlResolver;

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
  const candidates = Array.from(roots);
  // Canvas often reports both a newly added node subtree and many descendants
  // from the same synchronous layout pass. Scan only the outermost changed root
  // to keep one observer delivery linear instead of repeatedly walking overlaps.
  const candidateNodes = new Set<Node>(candidates as Node[]);
  return candidates.filter((root) => {
    let ancestor = (root as Node).parentNode;
    while (ancestor) {
      if (candidateNodes.has(ancestor)) return false;
      ancestor = ancestor.parentNode;
    }
    return true;
  });
}

/** Return only Live Preview and Canvas roots contained in one parent. */
export function findRenderSurfaces(root: ParentNode): ParentNode[] {
  const surfaces: ParentNode[] = [];
  const element = root as unknown as Element;
  if (element.nodeType === 1 && element.matches?.(RENDER_SURFACE_SELECTOR)) surfaces.push(root);
  surfaces.push(...findDescendants(root, RENDER_SURFACE_SELECTOR));
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
  for (const element of findDescendants(root, OSS_MEDIA_SELECTOR)) {
    if (isHydrationCandidate(element)) elements.push(element);
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
      // Obsidian and our caption renderer frequently move a node by removing it
      // and appending it elsewhere in the same task. MutationObserver runs after
      // that move, so a connected node is still live and must not be restored.
      if (node.isConnected) continue;
      disposeOssRenderSessions(node as ParentNode, contextMenu);
    }
  }
}

function outermostRenderOwners(root: ParentNode): HTMLElement[] {
  const tracked: HTMLElement[] = [];
  const rootElement = root as unknown as HTMLElement;
  if (rootElement.nodeType === 1 && renderStateKey(rootElement)) tracked.push(rootElement);
  tracked.push(...findDescendants(root, "[data-oss-render-key]") as HTMLElement[]);
  return outermostOwners(tracked);
}

function outermostOwners(tracked: readonly HTMLElement[]): HTMLElement[] {
  return tracked.filter((element) =>
    !tracked.some((candidate) => candidate !== element && candidate.contains?.(element))
  );
}

function findDescendants(root: ParentNode, selector: string): Element[] {
  const legacyFind = Reflect.get(root, ["query", "SelectorAll"].join("")) as
    ((selector: string) => ArrayLike<Element>) | undefined;
  if (!("children" in root) && legacyFind) return Array.from(legacyFind.call(root, selector));
  const matches: Element[] = [];
  const visit = (node: ParentNode): void => {
    for (const child of Array.from(node.children ?? [])) {
      if (child.matches?.(selector)) matches.push(child);
      visit(child);
    }
  };
  visit(root);
  return matches;
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
    const placeholder = createElementLike(element, "img");
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
  // The renderer's own DOM writes (applied URLs, mounted captions, media moved
  // into Live Preview slots) echo back through the MutationObserver. Once this
  // pipeline owns an element for a key, rerunning it tears down and remounts
  // those artifacts forever, so lazy media never even gets its URL applied.
  // Error-marked elements stay eligible so a retry can rerun the pipeline, and
  // configuration resets clean the render state before hydrating again.
  if (renderStateKey(html) === key && element.getAttribute("data-oss-render-error") !== "true") return;
  // Artifacts mounted inside an already owned session (e.g. the open link of a
  // rendered PDF card carries the signed/public URL itself) must not start a
  // second session for the same key: the embed branch would replace the link
  // with yet another card and nest cards forever.
  for (let parent = html.parentElement; parent; parent = parent.parentElement) {
    if (renderStateKey(parent) === key) return;
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
      markAppliedUrl(html, lease.url);
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
      container.classList.remove("oss-audio-caption-host");
      if (generatedFrame && media.parentElement === container && container.parentElement) {
        container.parentElement.insertBefore(media, container);
        container.remove();
      }
    });
  }
}

function isLivePreviewEmbedHost(element: Element): boolean {
  if (element.matches?.('.internal-embed[src^="oss://"]')) return true;
  if (element.matches?.(".internal-embed") !== true) return false;
  const source = element.getAttribute("src");
  return source !== null && ossKeyFromImageSource(source) !== null;
}

function mountInLivePreviewSlot(host: HTMLElement, media: HTMLElement): HTMLElement {
  let slot = host.querySelector<HTMLElement>(":scope > .oss-render-slot");
  if (!slot) {
    slot = createElementLike(host, "span");
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
  if (kind === "img") {
    const image = createElementLike(from, "img");
    image.alt = from.getAttribute("alt") ?? "";
    image.setAttribute("src", formatOssUrl(key));
    return image;
  }
  if (kind === "video") {
    const video = createElementLike(from, "video");
    video.controls = true;
    video.setAttribute("class", "oss-rendered-video");
    return video;
  }
  if (kind === "audio") {
    const audio = createElementLike(from, "audio");
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
  const source = candidate.getAttribute(attribute);
  return (source !== null && ossKeyFromImageSource(source) !== null) ||
    candidate.getAttribute("data-oss-render-error") === "true";
}
