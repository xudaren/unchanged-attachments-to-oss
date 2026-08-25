import assert from "node:assert/strict";
import test from "node:test";
import {
  clearUploadingProgressBus,
  commitUploadingPlaceholder,
  currentUploadingProgress,
  mountUploadingPlaceholder,
  publishUploadingProgress,
  registerUploadingCommitHandler,
  subscribeUploadingProgress,
} from "../../src/render/uploading-placeholder";

interface RichElement {
  nodeType: number;
  tagName: string;
  className: string;
  textContent: string;
  title?: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
  children: RichElement[];
  parentElement: RichElement | null;
  removed: boolean;
  adjacent: RichElement | null;
  replacedBy: RichElement | null;
  classList: {
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
  };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  closest(selector: string): RichElement | null;
  createEl(tag: string, options?: { cls?: string; text?: string }): RichElement;
  append(...nodes: RichElement[]): void;
  insertAdjacentElement(position: string, child: RichElement): RichElement;
  replaceWith(replacement: RichElement): void;
  remove(): void;
  ownerDocument: { createElement(tag: string): RichElement };
}

function richElement(tagName: string, attributes: Record<string, string> = {}): RichElement {
  const attrs = new Map(Object.entries(attributes));
  const classSet = new Set<string>();
  const element: RichElement = {
    nodeType: 1,
    tagName,
    className: "",
    textContent: "",
    dataset: {},
    style: {},
    children: [],
    parentElement: null,
    removed: false,
    adjacent: null,
    replacedBy: null,
    classList: {
      add: (name) => classSet.add(name),
      remove: (name) => classSet.delete(name),
      contains: (name) => classSet.has(name),
    },
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => { attrs.set(name, value); },
    removeAttribute: (name) => { attrs.delete(name); },
    closest: () => null,
    createEl(tag, options) {
      const child = richElement(tag.toUpperCase());
      if (options?.cls) child.className = options.cls;
      if (options?.text !== undefined) child.textContent = options.text;
      child.parentElement = element;
      element.children.push(child);
      return child;
    },
    append(...nodes) {
      for (const node of nodes) {
        node.parentElement = element;
        element.children.push(node);
      }
    },
    insertAdjacentElement: (_position, child) => {
      element.adjacent = child;
      return child;
    },
    replaceWith: (replacement) => {
      element.replacedBy = replacement;
      element.removed = true;
    },
    remove() { element.removed = true; },
    ownerDocument: { createElement: (tag) => richElement(tag.toUpperCase()) },
  };
  return element;
}

function findByClass(root: RichElement, className: string): RichElement | undefined {
  if (root.className.split(" ").includes(className)) return root;
  for (const child of root.children) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return undefined;
}

test("publishing upload progress notifies subscribers and keeps only in-flight state", () => {
  clearUploadingProgressBus();
  const seen: Array<{ done: number; total: number }> = [];
  const unsubscribe = subscribeUploadingProgress("task-a", (state) => seen.push(state));

  publishUploadingProgress("task-a", 1, 4);
  assert.deepEqual(currentUploadingProgress("task-a"), { done: 1, total: 4 });
  publishUploadingProgress("task-a", 4, 4);
  assert.equal(currentUploadingProgress("task-a"), undefined);
  assert.deepEqual(seen, [{ done: 1, total: 4 }, { done: 4, total: 4 }]);

  unsubscribe();
  publishUploadingProgress("task-a", 1, 2);
  assert.equal(seen.length, 2);
  clearUploadingProgressBus();
});

test("mounts one unified uploading card by swapping the broken media in place", () => {
  clearUploadingProgressBus();
  const media = richElement("IMG", { src: "oss://uploading/task-1", alt: "上传中 截图.png" });

  const mount = mountUploadingPlaceholder(media as unknown as HTMLElement, "uploading/task-1");
  const card = mount.element as unknown as RichElement;

  assert.equal(card.className, "oss-uploading-placeholder");
  assert.equal(media.replacedBy, card);
  assert.equal(media.getAttribute("data-oss-uploading-swapped"), "true");
  assert.equal(findByClass(card, "oss-uploading-badge")?.textContent, "PNG");
  assert.equal(findByClass(card, "oss-uploading-name")?.textContent, "截图.png");
  assert.equal(findByClass(card, "oss-uploading-status")?.textContent, "上传中…");
  assert.equal(card.classList.contains("oss-uploading-indeterminate"), true);
  clearUploadingProgressBus();
});

test("published progress drives the deterministic bar and survives later mounts", () => {
  clearUploadingProgressBus();
  publishUploadingProgress("task-b", 2, 4);
  const media = richElement("IMG", { src: "oss://uploading/task-b", alt: "上传中 录音.mp3" });

  const mount = mountUploadingPlaceholder(media as unknown as HTMLElement, "uploading/task-b");
  const card = mount.element as unknown as RichElement;
  assert.equal(findByClass(card, "oss-uploading-status")?.textContent, "正在上传 OSS… 50%");
  assert.equal(findByClass(card, "oss-uploading-bar-fill")?.style.width, "50%");

  publishUploadingProgress("task-b", 3, 4);
  assert.equal(findByClass(card, "oss-uploading-status")?.textContent, "正在上传 OSS… 75%");
  assert.equal(findByClass(card, "oss-uploading-bar-fill")?.style.width, "75%");

  mount.dispose();
  assert.equal(card.replacedBy, media);
  assert.equal(media.getAttribute("data-oss-uploading-swapped"), null);
  publishUploadingProgress("task-b", 4, 4);
  assert.equal(findByClass(card, "oss-uploading-status")?.textContent, "正在上传 OSS… 75%");
  clearUploadingProgressBus();
});

test("falls back to a generic badge when the placeholder alt carries no extension", () => {
  clearUploadingProgressBus();
  const media = richElement("IMG", { src: "oss://uploading/task-c" });
  const mount = mountUploadingPlaceholder(media as unknown as HTMLElement, "uploading/task-c");
  const card = mount.element as unknown as RichElement;
  assert.equal(findByClass(card, "oss-uploading-badge")?.textContent, "OSS");
  assert.equal(findByClass(card, "oss-uploading-name")?.textContent, "附件");
  clearUploadingProgressBus();
});

test("commit signal notifies handlers once and clears the tempId bus state", () => {
  clearUploadingProgressBus();
  const seen: string[] = [];
  const unregister = registerUploadingCommitHandler("task-x", (source) => seen.push(source));
  publishUploadingProgress("task-x", 1, 2);

  commitUploadingPlaceholder("task-x", "https://bucket.example/vault/a.jpg");
  assert.deepEqual(seen, ["https://bucket.example/vault/a.jpg"]);
  assert.equal(currentUploadingProgress("task-x"), undefined);

  commitUploadingPlaceholder("task-x", "https://bucket.example/vault/a.jpg");
  assert.equal(seen.length, 1);
  unregister();
  clearUploadingProgressBus();
});

test("unregistering a commit handler keeps it silent on commit", () => {
  clearUploadingProgressBus();
  let calls = 0;
  const unregister = registerUploadingCommitHandler("task-y", () => { calls += 1; });
  unregister();

  commitUploadingPlaceholder("task-y", "https://bucket.example/vault/b.jpg");
  assert.equal(calls, 0);
  clearUploadingProgressBus();
});

test("commit sweeps marked leftover cards without a session handle", () => {
  clearUploadingProgressBus();
  const media = richElement("IMG", { src: "oss://uploading/task-z", alt: "上传中 视频.mp4" });
  const mount = mountUploadingPlaceholder(media as unknown as HTMLElement, "uploading/task-z");
  const card = mount.element as unknown as RichElement;

  // The sweep must find the card by its tempId marker alone, so it works even
  // when the render session handle was lost (hot reload, reused host nodes).
  const globals = globalThis as { document?: unknown };
  globals.document = {
    querySelectorAll: (selector: string) => {
      const id = /data-oss-uploading-id="(.+)"/.exec(selector)?.[1];
      return [card].filter((candidate) => candidate.getAttribute("data-oss-uploading-id") === id);
    },
  };
  try {
    commitUploadingPlaceholder("task-z", "https://bucket.example/vault/v.mp4");
    assert.equal(card.removed, true);
  } finally {
    delete globals.document;
    clearUploadingProgressBus();
  }
});
