import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelMediaLoading,
  disconnectMediaLoading,
  loadImageNearViewport,
  loadMediaOnInteraction,
  loadVideoNearViewport,
} from "../../src/render/media-loading";
import type { LeaseUrlResolver, SignedUrlLease } from "../../src/render/url-resolver";

function lease(url: string, generation = 0): SignedUrlLease {
  return { url, generation, expireAt: Date.now() + 3_600_000 };
}

function resolver(url: string, generation = 0): LeaseUrlResolver {
  return {
    resolve: async () => url,
    resolveLease: async () => lease(url, generation),
    isLeaseCurrent: (value) => value.generation === generation && value.expireAt > Date.now() + 60_000,
  };
}

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

    const url = "https://signed.example/vault/offscreen.jpg";
    loadImageNearViewport(image, "vault/offscreen.jpg", resolver(url), lease(url));
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

  const url = "https://signed.example/vault/audio.mp3";
  loadMediaOnInteraction(media, "vault/audio.mp3", resolver(url), lease(url));
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

    const url = "https://signed.example/vault/video.mp4";
    loadVideoNearViewport(video, "vault/video.mp4", resolver(url), lease(url));
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

test("re-signs an old image lease before delayed viewport attachment", async () => {
  let callback!: IntersectionObserverCallback;
  let generation = 1;
  let resolutions = 0;
  const original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(next: IntersectionObserverCallback) { callback = next; }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] { return []; }
    root = null;
    rootMargin = "300px";
    thresholds = [0];
  } as unknown as typeof IntersectionObserver;

  try {
    let source = "oss://vault/stale.jpg";
    const image = {
      loading: "eager",
      get src() { return source; },
      set src(value: string) { source = value; },
      getAttribute: (name: string) => name === "src" ? source : null,
    } as HTMLImageElement;
    const activeResolver: LeaseUrlResolver = {
      resolve: async () => "https://signed.example/new.jpg",
      resolveLease: async () => {
        resolutions += 1;
        return lease("https://signed.example/new.jpg", generation);
      },
      isLeaseCurrent: (value) => value.generation === generation && value.expireAt > Date.now() + 60_000,
    };

    loadImageNearViewport(image, "vault/stale.jpg", activeResolver, lease("https://signed.example/old.jpg", 0));
    callback([{ target: image, isIntersecting: true } as IntersectionObserverEntry], {
      unobserve: () => undefined,
    } as unknown as IntersectionObserver);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(resolutions, 1);
    assert.equal(source, "https://signed.example/new.jpg");
  } finally {
    generation = 0;
    disconnectMediaLoading();
    globalThis.IntersectionObserver = original;
  }
});

test("refreshes an audio lease when playback starts after a generation change", async () => {
  let generation = 0;
  const listeners = new Map<string, () => void>();
  const attributes = new Map<string, string>();
  const media = {
    tagName: "AUDIO",
    preload: "auto",
    getAttribute: (name: string) => attributes.get(name) ?? null,
    get src() { return attributes.get("src") ?? ""; },
    set src(value: string) { attributes.set("src", value); },
    addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as HTMLMediaElement;
  const activeResolver: LeaseUrlResolver = {
    resolve: async () => `https://signed.example/${generation}.mp3`,
    resolveLease: async () => lease(`https://signed.example/${generation}.mp3`, generation),
    isLeaseCurrent: (value) => value.generation === generation && value.expireAt > Date.now() + 60_000,
  };

  loadMediaOnInteraction(media, "vault/audio.mp3", activeResolver, lease("https://signed.example/0.mp3", 0));
  assert.equal(media.src, "https://signed.example/0.mp3");
  generation = 1;
  listeners.get("play")?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(media.src, "https://signed.example/1.mp3");
  cancelMediaLoading(media);
});
