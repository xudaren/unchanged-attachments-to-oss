import { ossKeyFromImageSource } from "./oss-source";

const IMAGE_ROOT_MARGIN = "300px";

type ObservedImage = {
  key: string;
  url: string;
};

const pendingImages = new WeakMap<Element, ObservedImage>();
let imageObserver: IntersectionObserver | null = null;
const pendingVideos = new WeakMap<Element, string>();
let videoObserver: IntersectionObserver | null = null;

/** Attach the network URL only when an image approaches the viewport. */
export function loadImageNearViewport(image: HTMLImageElement, url: string, key: string): void {
  image.loading = "lazy";
  const Observer = globalThis.IntersectionObserver;
  if (typeof Observer !== "function") {
    image.src = url;
    return;
  }

  pendingImages.set(image, { key, url });
  getImageObserver(Observer).observe(image);
}

/** Expose the source to native controls without preloading audio bytes. */
export function loadMediaOnInteraction(media: HTMLMediaElement, url: string): void {
  media.preload = "none";
  media.src = url;
}

/** Attach video metadata near the viewport so the browser can show its first frame. */
export function loadVideoNearViewport(video: HTMLVideoElement, url: string): void {
  video.preload = "metadata";
  video.removeAttribute("src");
  const Observer = globalThis.IntersectionObserver;
  if (typeof Observer !== "function") {
    video.src = previewUrl(url);
    return;
  }
  pendingVideos.set(video, url);
  getVideoObserver(Observer).observe(video);
}

export function disconnectMediaLoading(): void {
  imageObserver?.disconnect();
  imageObserver = null;
  videoObserver?.disconnect();
  videoObserver = null;
}

function getVideoObserver(Observer: typeof IntersectionObserver): IntersectionObserver {
  if (videoObserver) return videoObserver;
  videoObserver = new Observer((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const video = entry.target as HTMLVideoElement;
      const url = pendingVideos.get(video);
      observer.unobserve(video);
      pendingVideos.delete(video);
      if (url && !video.getAttribute("src")) video.src = previewUrl(url);
    }
  }, { rootMargin: IMAGE_ROOT_MARGIN });
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
      pendingImages.delete(image);
      if (!pending || currentOssKey(image) !== pending.key) continue;
      image.src = pending.url;
    }
  }, { rootMargin: IMAGE_ROOT_MARGIN });
  return imageObserver;
}

function currentOssKey(image: HTMLImageElement): string | null {
  return ossKeyFromImageSource(image.getAttribute("src") ?? "");
}
