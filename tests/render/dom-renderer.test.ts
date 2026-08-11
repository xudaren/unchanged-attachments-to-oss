import assert from "node:assert/strict";
import test from "node:test";
import type { AttachmentContextMenuBinder } from "../../src/render/context-menu";
import { RenderSessionLifetime } from "../../src/render/lifetime";
import {
  disposeRemovedOssRenderSessions,
  disposeOssRenderSessions,
  hydrateOssSubtree,
  resetOssRenderLifetime,
  resetOssRenderSessions,
  selectMutationRoots,
} from "../../src/render/dom-renderer";

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
  const element = {
    nodeType: 1,
    tagName,
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    closest: (selector: string) => (
      selector.includes("markdown-source-view") || selector.includes("canvas-node")
        ? ({} as Element)
        : null
    ),
    ownerDocument: {
      createElement: () => ({
        dataset: {} as Record<string, string>,
        remove: () => { errorMarker = null; },
      }),
    },
    insertAdjacentElement: (_position: string, marker: typeof errorMarker) => {
      errorMarker = marker;
      return marker;
    },
    querySelectorAll: () => [],
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

test("replaces an Obsidian image placeholder with the actual media type", async () => {
  const image = mediaElement("IMG", "oss://vault/a.mp4") as ReturnType<typeof mediaElement> & {
    ownerDocument?: { createElement(tag: string): unknown };
    replacement?: { tagName: string; src: string; preload: string; dispatch(name: string): void };
  };
  image.ownerDocument = {
    createElement: (tag: string) => mediaElement(tag.toUpperCase(), ""),
  };

  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => "https://signed.example/vault/a.mp4",
  });

  assert.equal(image.replacement?.tagName, "VIDEO");
  assert.equal(image.replacement?.preload, "metadata");
  assert.equal(image.replacement?.src, "https://signed.example/vault/a.mp4#t=0.001");
});

test("replaces an Obsidian image placeholder with an interactive audio player", async () => {
  const image = mediaElement("IMG", "oss://vault/a.mp3") as ReturnType<typeof mediaElement> & {
    ownerDocument?: { createElement(tag: string): unknown };
    replacement?: { tagName: string; src: string; preload: string; dispatch(name: string): void };
  };
  image.ownerDocument = {
    createElement: (tag: string) => mediaElement(tag.toUpperCase(), ""),
  };
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

test("repeated hydration keeps the newest context-menu binding", async () => {
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

  assert.equal(binds, 2);
  assert.equal(unbinds, 1);
  assert.equal(bound, true, "the second bind must happen after the old cleanup");

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
