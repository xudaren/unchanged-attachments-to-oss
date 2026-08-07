import assert from "node:assert/strict";
import test from "node:test";
import {
  disconnectMediaLoading,
  loadImageNearViewport,
  loadMediaOnInteraction,
  loadVideoNearViewport,
} from "../../src/render/media-loading";

test("keeps an image on oss protocol until it approaches the viewport", () => {
  let callback!: IntersectionObserverCallback;
  let observed: Element | null = null;
  let unobserved: Element | null = null;
  const original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(next: IntersectionObserverCallback) { callback = next; }
    observe(target: Element) { observed = target; }
    unobserve(target: Element) { unobserved = target; }
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] { return []; }
    root = null;
    rootMargin = "300px";
    thresholds = [0];
  } as unknown as typeof IntersectionObserver;

  try {
    let source = "oss://vault/offscreen.jpg";
    const image = {
      loading: "eager",
      get src() { return source; },
      set src(value: string) { source = value; },
      getAttribute: (name: string) => name === "src" ? source : null,
    } as HTMLImageElement;

    loadImageNearViewport(image, "https://signed.example/vault/offscreen.jpg", "vault/offscreen.jpg");
    assert.equal(source, "oss://vault/offscreen.jpg");
    assert.equal(image.loading, "lazy");
    assert.equal(observed, image);

    callback([{ target: image, isIntersecting: true } as IntersectionObserverEntry], {
      unobserve: (target: Element) => { unobserved = target; },
    } as IntersectionObserver);
    assert.equal(source, "https://signed.example/vault/offscreen.jpg");
    assert.equal(unobserved, image);
  } finally {
    disconnectMediaLoading();
    globalThis.IntersectionObserver = original;
  }
});

test("exposes audio to native controls without preloading content", () => {
  const attributes = new Map<string, string>([["src", "oss://vault/audio.mp3"]]);
  const media = {
    preload: "auto",
    getAttribute: (name: string) => attributes.get(name) ?? null,
    removeAttribute: (name: string) => attributes.delete(name),
    get src() { return attributes.get("src") ?? ""; },
    set src(value: string) { attributes.set("src", value); },
  } as unknown as HTMLMediaElement;

  loadMediaOnInteraction(media, "https://signed.example/vault/audio.mp3");
  assert.equal(media.preload, "none");
  assert.equal(media.src, "https://signed.example/vault/audio.mp3");
});

test("loads video metadata only when it approaches the viewport", () => {
  let callback!: IntersectionObserverCallback;
  let observed: Element | null = null;
  const original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(next: IntersectionObserverCallback) { callback = next; }
    observe(target: Element) { observed = target; }
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] { return []; }
    root = null;
    rootMargin = "300px";
    thresholds = [0];
  } as unknown as typeof IntersectionObserver;

  try {
    const attributes = new Map<string, string>([["src", "oss://vault/video.mp4"]]);
    const video = {
      preload: "none",
      getAttribute: (name: string) => attributes.get(name) ?? null,
      removeAttribute: (name: string) => attributes.delete(name),
      get src() { return attributes.get("src") ?? ""; },
      set src(value: string) { attributes.set("src", value); },
    } as HTMLVideoElement;

    loadVideoNearViewport(video, "https://signed.example/vault/video.mp4");
    assert.equal(video.preload, "metadata");
    assert.equal(video.getAttribute("src"), null);
    assert.equal(observed, video);

    callback([{ target: video, isIntersecting: true } as IntersectionObserverEntry], {
      unobserve: () => undefined,
    } as unknown as IntersectionObserver);
    assert.equal(video.src, "https://signed.example/vault/video.mp4#t=0.001");
  } finally {
    disconnectMediaLoading();
    globalThis.IntersectionObserver = original;
  }
});
