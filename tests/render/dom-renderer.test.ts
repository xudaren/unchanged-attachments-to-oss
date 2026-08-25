import assert from "node:assert/strict";
import test from "node:test";
import type { AttachmentContextMenuBinder } from "../../src/render/context-menu";
import { RenderSessionLifetime } from "../../src/render/lifetime";
import { setOssReferenceHost } from "../../src/reference/codec";
import {
  disposeRemovedOssRenderSessions,
  disposeOssRenderSessions,
  hydrateOssSubtree,
  resetOssRenderLifetime,
  resetOssRenderSessions,
  selectMutationRoots,
} from "../../src/render/dom-renderer";
import { clearUploadingProgressBus, commitUploadingPlaceholder } from "../../src/render/uploading-placeholder";

const HOST = "bucket-a.oss-cn-hangzhou.aliyuncs.com";
setOssReferenceHost(HOST);

interface DomElementInfoLike {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  href?: string;
}

function node(
  nodeType: number,
  tagName?: string,
  options: { inSurface?: boolean; nestedSurfaces?: Node[] } = {},
): Node {
  return {
    nodeType,
    tagName,
    closest: () => options.inSurface === false ? null : ({} as Element),
    matches: () => false,
    querySelectorAll: () => options.nestedSurfaces ?? [],
  } as unknown as Node;
}

function record(type: MutationRecordType, target: Node, addedNodes: Node[] = []): MutationRecord {
  return { type, target, addedNodes } as unknown as MutationRecord;
}

function documentDouble(create: (tag: string) => unknown) {
  return {
    createDocumentFragment: () => ({ createEl: create }),
    createElement: create,
  };
}

test("selects only the changed media element for src and href mutations", () => {
  const image = node(1, "IMG");
  const anchor = node(1, "A");
  const unrelated = node(1, "DIV");

  assert.deepEqual(
    selectMutationRoots([
      record("attributes", image),
      record("attributes", anchor),
      record("attributes", unrelated),
    ]),
    [image, anchor],
  );
});

test("selects only added element subtrees from child-list mutations", () => {
  const subtree = node(1, "DIV");
  const fragment = node(11);
  const text = node(3);

  assert.deepEqual(
    selectMutationRoots([record("childList", node(1, "SECTION"), [subtree, text, fragment])]),
    [subtree, fragment],
  );
});

test("deduplicates mutation roots within one observer batch", () => {
  const image = node(1, "IMG");
  assert.deepEqual(
    selectMutationRoots([record("attributes", image), record("attributes", image)]),
    [image],
  );
});

test("collapses overlapping Live Preview mutation roots to one outer subtree scan", () => {
  const child = node(1, "IMG") as Node & { parentNode: Node | null };
  const outer = node(1, "DIV");
  child.parentNode = outer;
  const surface = node(1, "SECTION");

  assert.deepEqual(
    selectMutationRoots([
      record("childList", surface, [outer]),
      record("childList", outer, [child]),
    ]),
    [outer],
  );
});

test("ignores mutations outside Live Preview surfaces", () => {
  const image = node(1, "IMG", { inSurface: false });
  const unrelatedTarget = node(1, "DIV", { inSurface: false });
  const unrelatedChild = node(1, "DIV", { inSurface: false });

  assert.deepEqual(
    selectMutationRoots([
      record("attributes", image),
      record("childList", unrelatedTarget, [unrelatedChild]),
    ]),
    [],
  );
});

test("selects a newly added Live Preview surface without hydrating its outer UI container", () => {
  const livePreview = node(1, "DIV");
  const outer = node(1, "DIV", { inSurface: false, nestedSurfaces: [livePreview] });
  const unrelatedTarget = node(1, "DIV", { inSurface: false });

  assert.deepEqual(
    selectMutationRoots([record("childList", unrelatedTarget, [outer])]),
    [livePreview],
  );
});

function mediaElement(tagName: string, source: string) {
  const attributes = new Map<string, string>([[tagName === "A" ? "href" : "src", source]]);
  let errorMarker: { className?: string; textContent?: string | null; remove(): void } | null = null;
  const listeners = new Map<string, Set<(event: { key?: string }) => void>>();
  const children: unknown[] = [];
  const classSet = new Set<string>();
  const element: Record<string, unknown> = {
    nodeType: 1,
    tagName,
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    children,
    classList: {
      contains: (name: string) => classSet.has(name),
      add: (name: string) => { classSet.add(name); },
      remove: (name: string) => { classSet.delete(name); },
    },
    closest: (selector: string) => (
      selector.includes("markdown-source-view") || selector.includes("canvas-node")
        ? ({} as Element)
        : null
    ),
    ownerDocument: documentDouble(() => ({
        dataset: {} as Record<string, string>,
        remove: () => { errorMarker = null; },
      })),
    insertAdjacentElement: (_position: string, marker: typeof errorMarker) => {
      errorMarker = marker;
      return marker;
    },
    querySelectorAll: () => [],
    matches: () => false,
    querySelector: () => null,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    addEventListener: (name: string, listener: (event: { key?: string }) => void) => {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
    },
    removeEventListener: (name: string, listener: (event: { key?: string }) => void) => {
      listeners.get(name)?.delete(listener);
    },
    dispatch: (name: string, event: { key?: string } = {}) => {
      for (const listener of Array.from(listeners.get(name) ?? [])) listener(event);
    },
    play: async () => undefined,
    replaceWith(replacement: unknown) { (this as { replacement?: unknown }).replacement = replacement; },
    remove() {
      const parent = (this as { parentElement?: { children?: unknown[] } }).parentElement;
      if (parent?.children) {
        const i = parent.children.indexOf(this);
        if (i >= 0) parent.children.splice(i, 1);
      }
      (this as { parentElement?: unknown }).parentElement = undefined;
    },
    append(...items: unknown[]) {
      children.push(...items);
      for (const item of items) {
        if (item && typeof item === "object") (item as { parentElement?: unknown }).parentElement = element;
      }
    },
    createEl(tag: string, options?: DomElementInfoLike | string) {
      // Delegate creation to ownerDocument.createElement so tests can swap
      // in specialized element factories (e.g. mediaElement with src setters).
      const doc = element.ownerDocument as { createElement?: (tag: string) => unknown };
      const child = doc.createElement?.(tag) ?? {
        tagName: tag.toUpperCase(),
        className: "",
        textContent: "",
        dataset: {} as Record<string, string>,
        children: [] as unknown[],
        append() {},
        setAttribute() {},
        getAttribute() { return null; },
        remove() {},
      };
      // Inherit the parent's ownerDocument so cross-element creation
      // (e.g. hydrate creating an AUDIO from an IMG's host) uses the same
      // document double that the test installed on the parent.
      if (child && typeof child === "object") {
        (child as { ownerDocument?: unknown }).ownerDocument = element.ownerDocument;
      }
      if (typeof options === "string") (child as { className?: string }).className = options;
      else if (options) {
        if (options.cls) (child as { className?: string }).className = typeof options.cls === "string" ? options.cls : options.cls.join(" ");
        if (options.text !== undefined) (child as { textContent?: unknown }).textContent = options.text;
        if (options.title !== undefined) (child as { title?: string }).title = options.title;
        if (options.href !== undefined) (child as { href?: string }).href = options.href;
        if (options.attr) {
          for (const [key, value] of Object.entries(options.attr)) {
            if (value === null) continue;
            (child as { setAttribute?: (k: string, v: string) => void }).setAttribute?.(key, String(value));
          }
        }
      }
      children.push(child);
      if (child && typeof child === "object") (child as { parentElement?: unknown }).parentElement = element;
      if (typeof (child as { remove?: () => void }).remove === "function") {
        const originalRemove = (child as { remove: () => void }).remove.bind(child);
        (child as { remove: () => void }).remove = () => {
          const i = children.indexOf(child);
          if (i >= 0) children.splice(i, 1);
          originalRemove();
        };
      }
      return child;
    },
    get src() { return attributes.get("src") ?? ""; },
    set src(value: string) { attributes.set("src", value); },
    get href() { return attributes.get("href") ?? ""; },
    set href(value: string) { attributes.set("href", value); },
    get errorText() { return errorMarker?.textContent ?? ""; },
  };
  return element;
}

test("hydrates only the supplied OSS image subtree", async () => {
  const image = mediaElement("IMG", "oss://vault/a.jpg");
  const keys: string[] = [];

  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async (key: string) => {
      keys.push(key);
      return "https://signed.example/vault/a.jpg";
    },
  });

  assert.deepEqual(keys, ["vault/a.jpg"]);
  assert.equal(image.src, "https://signed.example/vault/a.jpg");
});

test("hydrates a public URL reference under the configured bucket host", async () => {
  const image = mediaElement("IMG", `https://${HOST}/vault/a.jpg`);
  const keys: string[] = [];

  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async (key: string) => {
      keys.push(key);
      return "https://signed.example/vault/a.jpg";
    },
  });

  assert.deepEqual(keys, ["vault/a.jpg"]);
  assert.equal(image.src, "https://signed.example/vault/a.jpg");
});

test("leaves foreign https media to the host renderer", async () => {
  const image = mediaElement("IMG", "https://external.example.com/vault/a.jpg");

  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => { throw new Error("must not sign foreign media"); },
  });

  assert.equal(image.src, "https://external.example.com/vault/a.jpg");
  assert.equal(image.errorText, "");
  assert.equal(image.dataset.ossRenderKey, undefined);
});

test("does not re-sign when the applied signed URL echoes back through the observer", async () => {
  const image = mediaElement("IMG", `https://${HOST}/vault/a.jpg`);
  let signings = 0;
  const resolver = {
    resolve: async (key: string) => {
      signings += 1;
      return `https://${HOST}/${key}?x-oss-date=20260820&x-oss-signature=abc`;
    },
  };

  await hydrateOssSubtree(image as unknown as ParentNode, resolver);
  // The src attribute mutation produced by the renderer itself is delivered
  // back through the MutationObserver; it must not restart the render pipeline.
  await hydrateOssSubtree(image as unknown as ParentNode, resolver);

  assert.equal(image.src, `https://${HOST}/vault/a.jpg?x-oss-date=20260820&x-oss-signature=abc`);
  assert.equal(signings, 1);
});

test("does not re-hydrate when the applied public URL equals the canonical source", async () => {
  const image = mediaElement("IMG", `https://${HOST}/vault/a.jpg`);
  let resolutions = 0;
  const resolver = {
    resolve: async () => {
      resolutions += 1;
      return `https://${HOST}/vault/a.jpg`;
    },
  };

  await hydrateOssSubtree(image as unknown as ParentNode, resolver);
  await hydrateOssSubtree(image as unknown as ParentNode, resolver);

  assert.equal(image.src, `https://${HOST}/vault/a.jpg`);
  assert.equal(resolutions, 1);
});

test("does not rebind or remount when a pending media echoes through the observer", async () => {
  // The media keeps its canonical source until lazy loading applies the lease
  // URL, so every observer echo must not rerun the full pipeline: each pass
  // would tear down and remount the caption, producing fresh mutations forever.
  const image = mediaElement("IMG", `https://${HOST}/vault/slow.jpg`);
  const completions = new Map<string, (url: string) => void>();
  const resolver = {
    resolve: (key: string) => new Promise<string>((resolve) => completions.set(key, resolve)),
  };
  let binds = 0;
  const binder: AttachmentContextMenuBinder = {
    bind: () => { binds += 1; },
    unbind: () => undefined,
  };

  const first = hydrateOssSubtree(image as unknown as ParentNode, resolver, undefined, binder);
  await Promise.resolve();
  // Echoes must short-circuit before awaiting the still-pending lease again.
  const echoes = Promise.allSettled([
    hydrateOssSubtree(image as unknown as ParentNode, resolver, undefined, binder),
    hydrateOssSubtree(image as unknown as ParentNode, resolver, undefined, binder),
  ]);
  await Promise.resolve();

  assert.equal(binds, 1);
  completions.get("vault/slow.jpg")?.("https://signed.example/vault/slow.jpg");
  await first;
  await echoes;
  assert.equal(image.src, "https://signed.example/vault/slow.jpg");
});

test("replaces an Obsidian image placeholder with the actual media type", async () => {
  const image = mediaElement("IMG", "oss://vault/a.mp4") as ReturnType<typeof mediaElement> & {
    ownerDocument?: ReturnType<typeof documentDouble>;
    replacement?: { tagName: string; src: string; preload: string; dispatch(name: string): void };
  };
  image.ownerDocument = documentDouble((tag) => mediaElement(tag.toUpperCase(), ""));

  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => "https://signed.example/vault/a.mp4",
  });

  assert.equal(image.replacement?.tagName, "VIDEO");
  assert.equal(image.replacement?.preload, "metadata");
  assert.equal(image.replacement?.src, "https://signed.example/vault/a.mp4#t=0.001");
});

test("replaces an Obsidian image placeholder with an interactive audio player", async () => {
  const image = mediaElement("IMG", "oss://vault/a.mp3") as ReturnType<typeof mediaElement> & {
    ownerDocument?: ReturnType<typeof documentDouble>;
    replacement?: { tagName: string; src: string; preload: string; dispatch(name: string): void };
  };
  image.ownerDocument = documentDouble((tag) => mediaElement(tag.toUpperCase(), ""));
  image.setAttribute("alt", "访谈录音.mp3");
  const embedClasses: string[] = [];
  const wrapperClasses: string[] = [];
  const blockClasses: string[] = [];
  const lineClasses: string[] = [];
  const embed = { classList: { add: (name: string) => embedClasses.push(name) } } as Element;
  const wrapper = { classList: { add: (name: string) => wrapperClasses.push(name) } } as Element;
  const block = { classList: { add: (name: string) => blockClasses.push(name) } } as Element;
  const line = { classList: { add: (name: string) => lineClasses.push(name) } } as Element;
  image.closest = (selector: string) => {
    if (selector === ".markdown-source-view") return {} as Element;
    if (selector.includes(".internal-embed")) return embed;
    if (selector === ".image-wrapper") return wrapper;
    if (selector === ".cm-embed-block") return block;
    if (selector === ".cm-line") return line;
    return null;
  };

  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => "https://signed.example/vault/a.mp3",
  });

  assert.equal(image.replacement?.tagName, "AUDIO");
  assert.equal(image.replacement?.preload, "none");
  assert.equal(image.replacement?.src, "https://signed.example/vault/a.mp3");
  assert.equal((image.replacement as unknown as { errorText: string })?.errorText, "访谈录音.mp3");
  assert.deepEqual(embedClasses, ["oss-audio-live-preview-host"]);
  assert.deepEqual(wrapperClasses, ["oss-audio-live-preview-wrapper"]);
  assert.deepEqual(blockClasses, ["oss-audio-live-preview-block"]);
  assert.deepEqual(lineClasses, ["oss-audio-live-preview-line"]);
});

test("mounts audio inside the editable Live Preview embed host", async () => {
  const host = mediaElement("SPAN", "oss://vault/live.mp3") as ReturnType<typeof mediaElement> & {
    matches(selector: string): boolean;
    querySelector(selector: string): unknown;
    appendChild(child: unknown): void;
    children: unknown[];
    mounted?: ReturnType<typeof mediaElement>;
    label?: { textContent?: string };
    classList: { add(name: string): void };
    ownerDocument: { createElement(tag: string): ReturnType<typeof mediaElement> };
  };
  const classes: string[] = [];
  const nativeControl = { className: "internal-embed-button" };
  host.children = [nativeControl];
  host.matches = (selector) => selector === '.internal-embed[src^="oss://"]';
  host.querySelector = () => null;
  host.appendChild = (child) => {
    host.children.push(child);
    const slot = child as { replaceChildren?: (media: unknown) => void };
    slot.replaceChildren = (media) => { host.mounted = media as ReturnType<typeof mediaElement>; };
  };
  host.classList = { add: (name) => classes.push(name) };
  host.ownerDocument = {
    createElement: (tag) => {
      const created = mediaElement(tag.toUpperCase(), "") as ReturnType<typeof mediaElement> & {
        className: string;
        replaceChildren(child: unknown): void;
        remove(): void;
      };
      created.className = "";
      created.replaceChildren = (child) => { host.mounted = child as ReturnType<typeof mediaElement>; };
      created.remove = () => undefined;
      return created;
    },
  };
  host.setAttribute("alt", "现场录音.mp3");

  await hydrateOssSubtree(host as unknown as ParentNode, {
    resolve: async () => "https://signed.example/vault/live.mp3",
  });

  assert.equal(host.tagName, "SPAN");
  assert.equal(host.mounted?.tagName, "AUDIO");
  assert.equal(host.mounted?.src, "https://signed.example/vault/live.mp3");
  assert.equal(host.children[0], nativeControl);
  assert.ok(classes.includes("oss-audio-live-preview-host"));
});

test("replaces a PDF placeholder with the shared browser link", async () => {
  const image = mediaElement("IMG", "oss://vault/a.pdf") as ReturnType<typeof mediaElement> & {
    replacement?: unknown;
  };
  const pdfHost = mediaElement("DIV", "") as ReturnType<typeof mediaElement> & { className: string };
  pdfHost.className = "oss-pdf-viewer";
  const mounts: string[] = [];
  const names: Array<string | undefined> = [];
  image.setAttribute("alt", "百鸟数据-声纹检测报告.pdf");

  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => "https://signed.example/vault/a.pdf",
  }, {
    mount: (_from, url, _key, displayName) => {
      mounts.push(url);
      names.push(displayName);
      return pdfHost as unknown as HTMLElement;
    },
  });

  assert.deepEqual(mounts, ["https://signed.example/vault/a.pdf"]);
  assert.deepEqual(names, ["百鸟数据-声纹检测报告.pdf"]);
  assert.equal(image.replacement, pdfHost);
});

test("observer echo of a rendered PDF card does not nest another card", async () => {
  // The card's own open link carries the signed/public URL, so an observer
  // echo of the inserted subtree must not start a second session for the key.
  const image = mediaElement("IMG", `oss://vault/a.pdf`) as ReturnType<typeof mediaElement> & {
    replacement?: unknown;
  };
  const card = mediaElement("DIV", "");
  const mounts: string[] = [];
  const pdfRenderer = {
    mount: (_from: Element, url: string) => {
      mounts.push(url);
      return card as unknown as HTMLElement;
    },
  };
  const resolver = { resolve: async () => `https://${HOST}/vault/a.pdf` };

  await hydrateOssSubtree(image as unknown as ParentNode, resolver, pdfRenderer);
  const openLink = mediaElement("A", `https://${HOST}/vault/a.pdf`) as ReturnType<typeof mediaElement> & {
    parentElement?: unknown;
    replacement?: unknown;
  };
  openLink.parentElement = card;

  await hydrateOssSubtree(openLink as unknown as ParentNode, resolver, pdfRenderer);

  assert.deepEqual(mounts, [`https://${HOST}/vault/a.pdf`]);
  assert.equal(openLink.replacement, undefined);
});

test("expands a Live Preview PDF host without replacing its editable CodeMirror node", async () => {
  const image = mediaElement("IMG", "oss://vault/a.pdf") as ReturnType<typeof mediaElement> & {
    replacement?: unknown;
    closest(selector: string): Element | null;
  };
  const hostClasses: string[] = [];
  const blockClasses: string[] = [];
  const wrapperClasses: string[] = [];
  const lineClasses: string[] = [];
  const embedHost = { classList: { add: (name: string) => hostClasses.push(name) } };
  const blockHost = { classList: { add: (name: string) => blockClasses.push(name) } };
  const wrapper = { classList: { add: (name: string) => wrapperClasses.push(name) } };
  const line = { classList: { add: (name: string) => lineClasses.push(name) } };
  image.closest = (selector: string) => {
    if (selector === ".markdown-source-view") return {} as Element;
    if (selector === ".image-wrapper") return wrapper as unknown as Element;
    if (selector === ".cm-embed-block") return blockHost as unknown as Element;
    if (selector.includes(".internal-embed")) return embedHost as unknown as Element;
    if (selector === ".cm-line") return line as unknown as Element;
    return null;
  };
  const pdfCard = mediaElement("DIV", "") as ReturnType<typeof mediaElement> & { className: string };
  pdfCard.className = "oss-pdf-attachment";

  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => "https://signed.example/vault/a.pdf",
  }, {
    mount: () => pdfCard as unknown as HTMLElement,
  });

  assert.deepEqual(hostClasses, ["oss-pdf-live-preview-host"]);
  assert.deepEqual(blockClasses, ["oss-pdf-live-preview-block"]);
  assert.deepEqual(wrapperClasses, ["oss-pdf-live-preview-wrapper"]);
  assert.deepEqual(lineClasses, ["oss-pdf-live-preview-line"]);
  assert.equal(image.replacement, pdfCard);
});

test("replaces an existing PDF embed with the shared browser link", async () => {
  const embed = mediaElement("EMBED", "oss://vault/legacy.pdf") as ReturnType<typeof mediaElement> & {
    replacement?: unknown;
  };
  const host = mediaElement("DIV", "") as ReturnType<typeof mediaElement> & { className: string };
  host.className = "oss-pdf-viewer";

  await hydrateOssSubtree(embed as unknown as ParentNode, {
    resolve: async () => "https://signed.example/vault/legacy.pdf",
  }, {
    mount: () => host as unknown as HTMLElement,
  });

  assert.equal(embed.replacement, host);
});

test("does not let an older signature overwrite a reused media node", async () => {
  const image = mediaElement("IMG", "oss://vault/first.jpg");
  const completions = new Map<string, (url: string) => void>();
  const resolver = {
    resolve: (key: string) => new Promise<string>((resolve) => completions.set(key, resolve)),
  };

  const firstHydration = hydrateOssSubtree(image as unknown as ParentNode, resolver);
  image.src = "oss://vault/second.jpg";
  const secondHydration = hydrateOssSubtree(image as unknown as ParentNode, resolver);

  completions.get("vault/second.jpg")?.("https://signed.example/vault/second.jpg");
  await secondHydration;
  completions.get("vault/first.jpg")?.("https://signed.example/vault/first.jpg");
  await firstHydration;

  assert.equal(image.src, "https://signed.example/vault/second.jpg");
});

test("does not attach an old signing error after a node switches to a non-OSS source", async () => {
  const image = mediaElement("IMG", "oss://vault/old.jpg");
  let rejectSigning!: (error: Error) => void;
  const hydration = hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: () => new Promise<string>((_resolve, reject) => { rejectSigning = reject; }),
  });

  image.src = "app://local/image.jpg";
  rejectSigning(new Error("old signing failed"));
  await hydration;

  assert.equal(image.errorText, "");
});

test("clears a visible OSS error after the node switches to a local source", async () => {
  const image = mediaElement("IMG", "oss://vault/failed.jpg");
  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => { throw new Error("signing failed"); },
  });
  assert.equal(image.errorText, "OSS 媒体签名失败: vault/failed.jpg");

  image.src = "app://local/image.jpg";
  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => { throw new Error("must not sign local media"); },
  });

  assert.equal(image.errorText, "");
});

test("binds the OSS menu before signing so permanent actions survive signing failure", async () => {
  const image = mediaElement("IMG", "oss://vault/failed.mp4");
  const bound: Array<{ kind: string; key: string }> = [];

  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => { throw new Error("offline"); },
  }, undefined, {
    bind: (_element, kind, _url, key) => bound.push({ kind, key }),
  });

  assert.deepEqual(bound, [{ kind: "video", key: "vault/failed.mp4" }]);
  assert.equal(image.errorText, "OSS 媒体签名失败: vault/failed.mp4");
});

test("cleans menu state when CodeMirror reuses an OSS node for a local source", async () => {
  const image = mediaElement("IMG", "oss://vault/a.jpg");
  let unbound = 0;
  const binder = {
    bind: () => undefined,
    unbind: () => { unbound += 1; },
  };
  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => "https://signed.example/vault/a.jpg",
  }, undefined, binder);

  image.src = "app://local/image.jpg";
  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => { throw new Error("local media must not be signed"); },
  }, undefined, binder);

  assert.equal(unbound, 1);
  assert.equal(image.dataset.ossRenderKey, undefined);
});

test("resets an existing render session onto the current signing generation", async () => {
  const image = mediaElement("IMG", "oss://vault/a.jpg");
  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => "https://signed.example/old.jpg",
  });
  assert.equal(image.src, "https://signed.example/old.jpg");

  await resetOssRenderSessions(image as unknown as ParentNode, {
    resolve: async () => "https://signed.example/new.jpg",
  });

  assert.equal(image.src, "https://signed.example/new.jpg");
});

test("reset preserves a replaced media label, source path and single-owner cleanup", async () => {
  const image = mediaElement("IMG", "oss://vault/interview.mp3") as ReturnType<typeof mediaElement> & {
    ownerDocument?: { createElement(tag: string): unknown };
    replacement?: ReturnType<typeof mediaElement>;
  };
  image.ownerDocument = {
    createElement: (tag: string) => mediaElement(tag.toUpperCase(), ""),
  };
  image.setAttribute("alt", "访谈录音.mp3");
  const boundSourcePaths: Array<string | undefined> = [];
  let unbound = 0;
  const binder: AttachmentContextMenuBinder = {
    bind: (_element, _kind, _url, _key, sourcePath) => {
      boundSourcePaths.push(sourcePath);
    },
    unbind: () => { unbound += 1; },
    sourcePathFor: () => "notes/interview.md",
  };

  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => "https://signed.example/old.mp3",
  }, undefined, binder);
  const audio = image.replacement!;
  const unboundBeforeReset = unbound;

  await resetOssRenderSessions(audio as unknown as ParentNode, {
    resolve: async () => "https://signed.example/new.mp3",
  }, undefined, binder);

  assert.equal(audio.src, "https://signed.example/new.mp3");
  assert.equal(audio.getAttribute("alt"), "访谈录音.mp3");
  assert.equal(audio.dataset.ossDisplayName, "访谈录音.mp3");
  assert.equal(boundSourcePaths.at(-1), "notes/interview.md");
  assert.equal(unbound, unboundBeforeReset + 1);
});

test("dispose releases the old menu owner and leaves a canonical source for hot reload", async () => {
  const image = mediaElement("IMG", "oss://vault/hot.jpg");
  let oldBindings = 0;
  let oldUnbindings = 0;
  const oldMenu: AttachmentContextMenuBinder = {
    bind: () => { oldBindings += 1; },
    unbind: () => { oldUnbindings += 1; },
  };
  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => "https://old.example/hot.jpg",
  }, undefined, oldMenu);

  disposeOssRenderSessions(image as unknown as ParentNode, oldMenu);

  assert.equal(oldBindings, 1);
  assert.equal(oldUnbindings, 1);
  assert.equal(image.src, "oss:///vault/hot.jpg");
  assert.equal(image.dataset.ossRenderKey, undefined);

  let newBindings = 0;
  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => "https://new.example/hot.jpg",
  }, undefined, {
    bind: () => { newBindings += 1; },
  });

  assert.equal(newBindings, 1);
  assert.equal(oldUnbindings, 1);
  assert.equal(image.src, "https://new.example/hot.jpg");
});

test("dispose recursively removes a Live Preview slot and every expanded host class", async () => {
  const classTarget = () => {
    const names = new Set<string>();
    return {
      names,
      element: {
        classList: {
          add: (name: string) => names.add(name),
          remove: (name: string) => names.delete(name),
        },
      } as unknown as Element,
    };
  };
  const wrapper = classTarget();
  const block = classTarget();
  const line = classTarget();
  const hostClasses = new Set<string>();
  const nativeControl = { className: "internal-embed-button" };
  let slot: (ReturnType<typeof mediaElement> & { className: string; replaceChildren(child: unknown): void; remove(): void }) | null = null;
  const host = mediaElement("SPAN", "oss://vault/live.mp3") as ReturnType<typeof mediaElement> & {
    matches(selector: string): boolean;
    querySelector(selector: string): unknown;
    appendChild(child: unknown): void;
    children: unknown[];
    classList: { add(name: string): void; remove(name: string): void };
    ownerDocument: { createElement(tag: string): ReturnType<typeof mediaElement> & { className: string; replaceChildren(child: unknown): void; remove(): void } };
  };
  host.children = [nativeControl];
  host.matches = (selector) => selector === '.internal-embed[src^="oss://"]';
  host.querySelector = (selector) => selector === ":scope > .oss-render-slot" ? slot : null;
  host.appendChild = (child) => {
    slot = child as typeof slot;
    host.children.push(child);
  };
  host.classList = {
    add: (name) => hostClasses.add(name),
    remove: (name) => hostClasses.delete(name),
  };
  host.closest = (selector: string) => {
    if (selector === ".markdown-source-view") return {} as Element;
    if (selector === ".image-wrapper") return wrapper.element;
    if (selector === ".cm-embed-block") return block.element;
    if (selector.includes(".internal-embed")) return host as unknown as Element;
    if (selector === ".cm-line") return line.element;
    return null;
  };
  host.ownerDocument = {
    createElement: (tag) => {
      const created = mediaElement(tag.toUpperCase(), "") as ReturnType<typeof mediaElement> & {
        className: string;
        replaceChildren(child: unknown): void;
        remove(): void;
      };
      created.className = "";
      created.replaceChildren = () => undefined;
      created.remove = () => {
        host.children = host.children.filter((child) => child !== created);
        if (slot === created) slot = null;
      };
      return created;
    },
  };
  let unbound = 0;
  const menu: AttachmentContextMenuBinder = {
    bind: () => undefined,
    unbind: () => { unbound += 1; },
  };

  await hydrateOssSubtree(host as unknown as ParentNode, {
    resolve: async () => "https://old.example/live.mp3",
  }, undefined, menu);
  assert.ok(slot);
  assert.ok(wrapper.names.size && block.names.size && line.names.size && hostClasses.size);

  disposeOssRenderSessions(host as unknown as ParentNode, menu);

  assert.equal(slot, null);
  assert.deepEqual(host.children, [nativeControl]);
  assert.equal(wrapper.names.size, 0);
  assert.equal(block.names.size, 0);
  assert.equal(line.names.size, 0);
  assert.equal(hostClasses.size, 0);
  assert.equal(host.src, "oss:///vault/live.mp3");
  assert.equal(host.dataset.ossRenderKey, undefined);
  assert.equal(unbound, 2, "host and plugin-slot media each release one binding");
});

test("dispose turns a plugin PDF card back into a hot-reloadable canonical placeholder", async () => {
  const image = mediaElement("IMG", "oss://vault/report.pdf") as ReturnType<typeof mediaElement> & {
    ownerDocument: { createElement(tag: string): ReturnType<typeof mediaElement> };
    replacement?: ReturnType<typeof mediaElement>;
  };
  image.setAttribute("alt", "季度报告.pdf");
  const card = mediaElement("DIV", "") as ReturnType<typeof mediaElement> & {
    querySelector(selector: string): { textContent: string } | null;
    ownerDocument: { createElement(tag: string): ReturnType<typeof mediaElement> };
    replacement?: ReturnType<typeof mediaElement>;
  };
  const createElement = (tag: string) => mediaElement(tag.toUpperCase(), "");
  image.ownerDocument = { createElement };
  card.ownerDocument = { createElement };
  card.querySelector = (selector) => selector === ".oss-pdf-name" ? { textContent: "季度报告.pdf" } : null;

  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => "https://old.example/report.pdf",
  }, {
    mount: () => card as unknown as HTMLElement,
  });
  disposeOssRenderSessions(card as unknown as ParentNode);

  const placeholder = card.replacement!;
  assert.equal(placeholder.tagName, "IMG");
  assert.equal(placeholder.src, "oss:///vault/report.pdf");
  assert.equal(placeholder.getAttribute("alt"), "季度报告.pdf");
  assert.equal(card.dataset.ossRenderKey, undefined);

  let remounted = 0;
  await hydrateOssSubtree(placeholder as unknown as ParentNode, {
    resolve: async () => "https://new.example/report.pdf",
  }, {
    mount: () => {
      remounted += 1;
      return mediaElement("DIV", "") as unknown as HTMLElement;
    },
  });
  assert.equal(remounted, 1);
});

test("repeated hydration keeps the original context-menu binding", async () => {
  const image = mediaElement("IMG", "oss://vault/retry.jpg");
  let release!: (url: string) => void;
  let bound = false;
  let binds = 0;
  let unbinds = 0;
  const binder: AttachmentContextMenuBinder = {
    bind: () => {
      bound = true;
      binds += 1;
    },
    unbind: () => {
      bound = false;
      unbinds += 1;
    },
  };
  const resolver = {
    resolve: () => new Promise<string>((resolve) => { release = resolve; }),
  };

  const first = hydrateOssSubtree(image as unknown as ParentNode, resolver, undefined, binder);
  await Promise.resolve();
  await hydrateOssSubtree(image as unknown as ParentNode, resolver, undefined, binder);

  // An observer echo must not tear down the live binding for the same key.
  assert.equal(binds, 1);
  assert.equal(unbinds, 0);
  assert.equal(bound, true);

  release("https://signed.example/vault/retry.jpg");
  await first;
  assert.equal(bound, true);
});

test("render lifetime restores a completed detached Reading fragment on unload", async () => {
  const image = mediaElement("IMG", "oss://vault/detached.jpg");
  const lifetime = new RenderSessionLifetime();
  let unbound = 0;

  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => "https://signed.example/vault/detached.jpg",
  }, undefined, {
    bind: () => undefined,
    unbind: () => { unbound += 1; },
  }, lifetime);
  assert.equal(image.src, "https://signed.example/vault/detached.jpg");

  lifetime.dispose();

  assert.equal(image.src, "oss:///vault/detached.jpg");
  assert.equal(image.dataset.ossRenderKey, undefined);
  assert.equal(unbound, 1);
});

test("render lifetime blocks a detached fragment's in-flight signature after unload", async () => {
  const image = mediaElement("IMG", "oss://vault/pending.jpg");
  const lifetime = new RenderSessionLifetime();
  let release!: (url: string) => void;
  const processing = hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: () => new Promise<string>((resolve) => { release = resolve; }),
  }, undefined, undefined, lifetime);
  await Promise.resolve();

  lifetime.dispose();
  release("https://stale.example/vault/pending.jpg");
  await processing;

  assert.equal(image.src, "oss:///vault/pending.jpg");
  assert.equal(image.errorText, "");
  assert.equal(image.dataset.ossRenderKey, undefined);
});

test("configuration reset re-signs detached sessions through the shared lifetime", async () => {
  const first = mediaElement("IMG", "oss://vault/first.jpg");
  const second = mediaElement("IMG", "oss://vault/second.jpg");
  const lifetime = new RenderSessionLifetime();
  let generation = "old";
  const resolver = {
    resolve: async (key: string) => `https://${generation}.example/${key}`,
  };

  await hydrateOssSubtree(first as unknown as ParentNode, resolver, undefined, undefined, lifetime);
  await hydrateOssSubtree(second as unknown as ParentNode, resolver, undefined, undefined, lifetime);
  generation = "new";
  await resetOssRenderLifetime(lifetime, resolver);

  assert.equal(first.src, "https://new.example/vault/first.jpg");
  assert.equal(second.src, "https://new.example/vault/second.jpg");
});

test("removed-node cleanup ignores Canvas media that was only moved", async () => {
  const image = mediaElement("IMG", "oss://vault/canvas.jpg") as ReturnType<typeof mediaElement> & {
    isConnected: boolean;
  };
  image.isConnected = true;
  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => "https://signed.example/vault/canvas.jpg",
  });

  const removal = {
    type: "childList",
    removedNodes: [image],
  } as unknown as MutationRecord;
  disposeRemovedOssRenderSessions([removal]);
  assert.equal(image.src, "https://signed.example/vault/canvas.jpg");
  assert.equal(image.dataset.ossRenderKey, "vault/canvas.jpg");

  image.isConnected = false;
  disposeRemovedOssRenderSessions([removal]);
  assert.equal(image.src, "oss:///vault/canvas.jpg");
  assert.equal(image.dataset.ossRenderKey, undefined);
});

interface UploadingElement {
  nodeType: number;
  tagName: string;
  className: string;
  textContent: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
  children: UploadingElement[];
  parentElement: UploadingElement | null;
  removed: boolean;
  adjacent: UploadingElement | null;
  replacedBy: UploadingElement | null;
  insertions: number;
  isConnected?: boolean;
  classList: { add(name: string): void; remove(name: string): void; contains(name: string): boolean };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  closest(selector: string): UploadingElement | null;
  matches(selector: string): boolean;
  createEl(tag: string, options?: { cls?: string; text?: string }): UploadingElement;
  insertAdjacentElement(position: string, child: UploadingElement): UploadingElement;
  replaceWith(replacement: UploadingElement): void;
  remove(): void;
  ownerDocument: { createElement(tag: string): UploadingElement };
}

function uploadingMediaElement(
  tagName: string,
  attributes: Record<string, string> = {},
  className = "",
): UploadingElement {
  const attrs = new Map(Object.entries(attributes));
  const classSet = new Set(className.split(" ").filter(Boolean));
  const element: UploadingElement = {
    nodeType: 1,
    tagName,
    className,
    textContent: "",
    dataset: {},
    style: {},
    children: [],
    parentElement: null,
    removed: false,
    adjacent: null,
    replacedBy: null,
    insertions: 0,
    classList: {
      add: (name) => { classSet.add(name); },
      remove: (name) => { classSet.delete(name); },
      contains: (name) => classSet.has(name),
    },
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => { attrs.set(name, value); },
    removeAttribute: (name) => { attrs.delete(name); },
    closest: () => null,
    matches(selector: string): boolean {
      if (selector.includes("data-oss-render-key")) return element.dataset.ossRenderKey !== undefined;
      const src = attrs.get("src") ?? attrs.get("href") ?? "";
      const remote = src.startsWith("oss://") || src.startsWith("https://");
      if (selector.includes(".internal-embed")) return classSet.has("internal-embed") && remote;
      return remote;
    },
    createEl(tag, options) {
      const child = uploadingMediaElement(tag.toUpperCase());
      if (options?.cls) child.className = options.cls;
      if (options?.text !== undefined) child.textContent = options.text;
      child.parentElement = element;
      element.children.push(child);
      return child;
    },
    insertAdjacentElement: (_position, child) => {
      element.insertions += 1;
      element.adjacent = child;
      return child;
    },
    replaceWith: (replacement) => {
      element.replacedBy = replacement;
      element.removed = true;
    },
    remove() { element.removed = true; },
    ownerDocument: { createElement: (tag) => uploadingMediaElement(tag.toUpperCase()) },
  };
  return element;
}

function append(parent: UploadingElement, child: UploadingElement): void {
  child.parentElement = parent;
  parent.children.push(child);
}

test("mounts the uploading placeholder by swapping the broken media without signing", async () => {
  clearUploadingProgressBus();
  const image = uploadingMediaElement("IMG", {
    src: "oss://uploading/task-1",
    alt: "上传中 截图.png",
  });

  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => { throw new Error("uploading placeholder must never be signed"); },
  });

  assert.equal(image.dataset.ossRenderKey, "uploading/task-1");
  assert.equal(image.replacedBy?.className, "oss-uploading-placeholder");
  assert.equal(image.getAttribute("data-oss-uploading-swapped"), "true");
  assert.equal(image.getAttribute("src"), "oss://uploading/task-1");
  clearUploadingProgressBus();
});

test("observer echoes of the uploading placeholder never mount a second card", async () => {
  clearUploadingProgressBus();
  const image = uploadingMediaElement("IMG", { src: "oss://uploading/task-2" });

  await hydrateOssSubtree(image as unknown as ParentNode, { resolve: async () => "" });
  const card = image.replacedBy;
  await hydrateOssSubtree(image as unknown as ParentNode, { resolve: async () => "" });

  assert.equal(image.replacedBy, card);
  assert.equal(card?.replacedBy, null);
  clearUploadingProgressBus();
});

test("nested embed host and broken image share one uploading card", async () => {
  clearUploadingProgressBus();
  const host = uploadingMediaElement("SPAN", {
    src: "oss://uploading/task-3",
  }, "internal-embed image-embed");
  const image = uploadingMediaElement("IMG", { src: "oss://uploading/task-3" });
  append(host, image);

  await hydrateOssSubtree(host as unknown as ParentNode, { resolve: async () => "" });

  assert.equal(host.replacedBy, null);
  assert.notEqual(image.replacedBy, null);
  assert.equal(image.getAttribute("data-oss-uploading-swapped"), "true");
  assert.equal(host.dataset.ossRenderKey, "uploading/task-3");
  clearUploadingProgressBus();
});

test("disposing an uploading session restores the broken media and keeps the md source", async () => {
  clearUploadingProgressBus();
  const image = uploadingMediaElement("IMG", {
    src: "oss://uploading/task-4",
    alt: "上传中 视频.mp4",
  });

  await hydrateOssSubtree(image as unknown as ParentNode, { resolve: async () => "" });
  const card = image.replacedBy;
  disposeOssRenderSessions(image as unknown as ParentNode);

  assert.equal(card?.replacedBy, image);
  assert.equal(image.getAttribute("data-oss-uploading-swapped"), null);
  assert.equal(image.getAttribute("src"), "oss://uploading/task-4");
  assert.equal(image.dataset.ossRenderKey, undefined);
  clearUploadingProgressBus();
});

test("removal cleanup skips media that the placeholder swapped out on purpose", async () => {
  clearUploadingProgressBus();
  const image = uploadingMediaElement("IMG", { src: "oss://uploading/task-7" }) as UploadingElement;
  await hydrateOssSubtree(image as unknown as ParentNode, { resolve: async () => "" });
  const card = image.replacedBy;
  image.isConnected = false;

  disposeRemovedOssRenderSessions([{
    type: "childList",
    removedNodes: [image],
  } as unknown as MutationRecord]);

  assert.equal(image.dataset.ossRenderKey, "uploading/task-7");
  assert.equal(card?.replacedBy, null);
  clearUploadingProgressBus();
});

test("committing the reference swaps a stale uploading placeholder in place", async () => {
  clearUploadingProgressBus();
  const image = uploadingMediaElement("IMG", {
    src: "oss://uploading/task-5",
    alt: "上传中 截图.png",
  });
  const keys: string[] = [];
  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async (key: string) => {
      keys.push(key);
      return "https://signed.example/vault/a.png";
    },
  });
  const card = image.replacedBy;
  assert.notEqual(card, null);

  // Stale surfaces never rebuild the node themselves; the commit signal must
  // remove the card and render the committed reference on the same element.
  commitUploadingPlaceholder("task-5", `https://${HOST}/vault/a.png`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(card?.replacedBy, image);
  assert.deepEqual(keys, ["vault/a.png"]);
  assert.equal(image.src, "https://signed.example/vault/a.png");
  assert.equal(image.dataset.ossRenderKey, "vault/a.png");
  clearUploadingProgressBus();
});

test("commit signal ignores placeholders whose session already ended", async () => {
  clearUploadingProgressBus();
  const image = uploadingMediaElement("IMG", { src: "oss://uploading/task-6" });
  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => { throw new Error("ended session must not re-sign"); },
  });
  disposeOssRenderSessions(image as unknown as ParentNode);

  commitUploadingPlaceholder("task-6", `https://${HOST}/vault/b.jpg`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(image.getAttribute("src"), "oss://uploading/task-6");
  assert.equal(image.dataset.ossRenderKey, undefined);
  clearUploadingProgressBus();
});
