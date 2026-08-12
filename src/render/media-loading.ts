import { ossKeyFromImageSource } from "./oss-source";
import { markAppliedUrl } from "./render-state";
import {
  isUrlLeaseCurrent,
  LeaseUrlResolver,
  resolveUrlLease,
  SignedUrlLease,
} from "./url-resolver";

const MEDIA_ROOT_MARGIN = "300px";

interface PendingMedia {
  key: string;
  resolver: LeaseUrlResolver;
  lease?: SignedUrlLease;
}

const pendingImages = new WeakMap<Element, PendingMedia>();
const pendingVideos = new WeakMap<Element, PendingMedia>();
const interactiveStates = new WeakMap<HTMLMediaElement, PendingMedia>();
let imageObserver: IntersectionObserver | null = null;
let videoObserver: IntersectionObserver | null = null;

/** Attach the network URL only when an image approaches the viewport. */
export function loadImageNearViewport(
  image: HTMLImageElement,
  key: string,
  resolver: LeaseUrlResolver,
  lease?: SignedUrlLease,
): void {
  cancelMediaLoading(image);
  image.loading = "lazy";
  const pending = { key, resolver, lease };
  pendingImages.set(image, pending);
  const Observer = image.ownerDocument?.defaultView?.IntersectionObserver
    ?? window.IntersectionObserver;
  if (typeof Observer !== "function") {
    attachImage(image, pending);
    return;
  }
  getImageObserver(Observer).observe(image);
}

/** Expose the source to native controls without preloading audio bytes. */
export function loadMediaOnInteraction(
  media: HTMLMediaElement,
  key: string,
  resolver: LeaseUrlResolver,
  lease?: SignedUrlLease,
): void {
  cancelMediaLoading(media);
  const state = { key, resolver, lease };
  interactiveStates.set(media, state);
  media.preload = "none";
  if (lease) applyMediaLease(media, state, lease);
  installInteractionRefresh(media, state);
}

/** Attach video metadata near the viewport so the browser can show its first frame. */
export function loadVideoNearViewport(
  video: HTMLVideoElement,
  key: string,
  resolver: LeaseUrlResolver,
  lease?: SignedUrlLease,
): void {
  cancelMediaLoading(video);
  video.preload = "metadata";
  video.removeAttribute("src");
  markAppliedUrl(video, lease?.url ?? "", true);
  const pending = { key, resolver, lease };
  pendingVideos.set(video, pending);
  interactiveStates.set(video, pending);
  installInteractionRefresh(video, pending);
  const Observer = video.ownerDocument?.defaultView?.IntersectionObserver
    ?? window.IntersectionObserver;
  if (typeof Observer !== "function") {
    attachVideo(video, pending);
    return;
  }
  getVideoObserver(Observer).observe(video);
}

const mediaCleanup = new WeakMap<Element, () => void>();

export function cancelMediaLoading(element: Element): void {
  imageObserver?.unobserve(element);
  videoObserver?.unobserve(element);
  pendingImages.delete(element);
  pendingVideos.delete(element);
  mediaCleanup.get(element)?.();
  mediaCleanup.delete(element);
}

export function disconnectMediaLoading(): void {
  imageObserver?.disconnect();
  imageObserver = null;
  videoObserver?.disconnect();
  videoObserver = null;
}

function attachImage(image: HTMLImageElement, pending: PendingMedia): void {
  if (pendingImages.get(image) !== pending || currentOssKey(image) !== pending.key) return;
  if (pending.lease && isUrlLeaseCurrent(pending.resolver, pending.lease)) {
    applyImageLease(image, pending, pending.lease);
    return;
  }
  void resolveUrlLease(pending.resolver, pending.key).then((lease) => {
    if (pendingImages.get(image) !== pending || currentOssKey(image) !== pending.key) return;
    if (!isUrlLeaseCurrent(pending.resolver, lease)) {
      pending.lease = undefined;
      return attachImage(image, pending);
    }
    pending.lease = lease;
    applyImageLease(image, pending, lease);
  }, () => {
    // The hydration layer owns visible error state; keep the retryable oss:// source here.
  });
}

function applyImageLease(image: HTMLImageElement, pending: PendingMedia, lease: SignedUrlLease): void {
  if (pendingImages.get(image) !== pending || currentOssKey(image) !== pending.key) return;
  markAppliedUrl(image, lease.url);
  image.src = lease.url;
  pendingImages.delete(image);
}

function attachVideo(video: HTMLVideoElement, pending: PendingMedia): void {
  if (pendingVideos.get(video) !== pending) return;
  if (pending.lease && isUrlLeaseCurrent(pending.resolver, pending.lease)) {
    applyVideoLease(video, pending, pending.lease);
    return;
  }
  void resolveUrlLease(pending.resolver, pending.key).then((lease) => {
    if (pendingVideos.get(video) !== pending) return;
    if (!isUrlLeaseCurrent(pending.resolver, lease)) {
      pending.lease = undefined;
      return attachVideo(video, pending);
    }
    pending.lease = lease;
    applyVideoLease(video, pending, lease);
  }, () => {
    // Keep the empty, retryable video placeholder. A later render can try again.
  });
}

function applyVideoLease(video: HTMLVideoElement, pending: PendingMedia, lease: SignedUrlLease): void {
  if (pendingVideos.get(video) !== pending) return;
  const url = previewUrl(lease.url);
  markAppliedUrl(video, url);
  video.src = url;
  pendingVideos.delete(video);
}

async function refreshInteractiveMedia(media: HTMLMediaElement, state: PendingMedia): Promise<void> {
  if (interactiveStates.get(media) !== state) return;
  try {
    const lease = await resolveUrlLease(state.resolver, state.key, state.lease);
    if (interactiveStates.get(media) !== state) return;
    state.lease = lease;
    applyMediaLease(media, state, lease);
  } catch {
    // Preserve the previous URL; renderer error/retry remains independent per attachment.
  }
}

function applyMediaLease(media: HTMLMediaElement, state: PendingMedia, lease: SignedUrlLease): void {
  if (interactiveStates.get(media) !== state || !isUrlLeaseCurrent(state.resolver, lease)) return;
  const url = media.tagName === "VIDEO" ? previewUrl(lease.url) : lease.url;
  if (media.getAttribute("src") === url) return;
  markAppliedUrl(media, url);
  media.src = url;
}

function installInteractionRefresh(media: HTMLMediaElement, state: PendingMedia): void {
  const refresh = () => { void refreshInteractiveMedia(media, state); };
  media.addEventListener?.("pointerdown", refresh);
  media.addEventListener?.("keydown", refresh);
  media.addEventListener?.("play", refresh);
  media.addEventListener?.("seeking", refresh);
  mediaCleanup.set(media, () => {
    media.removeEventListener?.("pointerdown", refresh);
    media.removeEventListener?.("keydown", refresh);
    media.removeEventListener?.("play", refresh);
    media.removeEventListener?.("seeking", refresh);
    interactiveStates.delete(media);
  });
}

function getVideoObserver(Observer: typeof IntersectionObserver): IntersectionObserver {
  if (videoObserver) return videoObserver;
  videoObserver = new Observer((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const video = entry.target as HTMLVideoElement;
      const pending = pendingVideos.get(video);
      observer.unobserve(video);
      if (pending) attachVideo(video, pending);
    }
  }, { rootMargin: MEDIA_ROOT_MARGIN });
  return videoObserver;
}

function previewUrl(url: string): string {
  return `${url}#t=0.001`;
}

function getImageObserver(Observer: typeof IntersectionObserver): IntersectionObserver {
  if (imageObserver) return imageObserver;
  imageObserver = new Observer((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const image = entry.target as HTMLImageElement;
      const pending = pendingImages.get(image);
      observer.unobserve(image);
      if (pending) attachImage(image, pending);
    }
  }, { rootMargin: MEDIA_ROOT_MARGIN });
  return imageObserver;
}

function currentOssKey(image: HTMLImageElement): string | null {
  return ossKeyFromImageSource(image.getAttribute("src") ?? "");
}
