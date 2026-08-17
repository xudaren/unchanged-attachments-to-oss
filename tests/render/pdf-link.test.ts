import assert from "node:assert/strict";
import test from "node:test";
import { buildPdfLink } from "../../src/render/pdf-link";

function fakeWindow(): { open: () => null; CSS: { escape: (s: string) => string } } {
  return {
    open: () => null,
    CSS: { escape: (value: string) => value.replace(/["\\]/g, "\\$&") },
  };
}

function fakeNode(listeners?: Map<string, () => void>) {
  const children: unknown[] = [];
  const node = {
    nodeType: 1,
    ownerDocument: {
      defaultView: fakeWindow(),
      createElement(tagName: string) {
        return createElementFromDoc(tagName, listeners);
      },
    },
    children,
    append(...items: unknown[]) {
      children.push(...items);
      for (const item of items) {
        if (item && typeof item === "object" && "parent" in item) {
          (item as { parent: unknown }).parent = node;
        }
      }
    },
    createEl(tag: string, options?: DomElementInfoLike | string) {
      const element = createElementFromDoc(tag, listeners);
      applyOptions(element, options);
      node.append(element);
      return element;
    },
  };
  return node as unknown as Node;
}

function createElementFromDoc(tagName: string, listeners?: Map<string, () => void>) {
  const element: Record<string, unknown> & { parent?: unknown; remove(): void } = {
    tagName: tagName.toUpperCase(),
    className: "",
    textContent: "",
    href: "",
    target: "",
    rel: "",
    title: "",
    dataset: {} as Record<string, string>,
    children: [] as unknown[],
    append(...children: unknown[]) {
      (this.children as unknown[]).push(...children);
      for (const child of children) {
        if (child && typeof child === "object") (child as { parent?: unknown }).parent = this;
      }
    },
    addEventListener(type: string, listener: () => void) {
      listeners?.set(type, listener);
    },
    remove() {
      const parent = this.parent as { children?: unknown[] } | undefined;
      if (parent?.children) {
        const index = parent.children.indexOf(this);
        if (index >= 0) parent.children.splice(index, 1);
      }
      this.parent = undefined;
    },
    setAttribute() {},
    getAttribute() { return null; },
  };
  return element as unknown as HTMLElement;
}

interface DomElementInfoLike {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
  title?: string;
  href?: string;
}

function applyOptions(element: Record<string, unknown>, options?: DomElementInfoLike | string) {
  if (typeof options === "string") {
    element.className = options;
    return;
  }
  if (!options) return;
  if (options.cls) element.className = options.cls;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.title !== undefined) element.title = options.title;
  if (options.href !== undefined) element.href = options.href;
  if (options.attr) {
    for (const [key, value] of Object.entries(options.attr)) {
      if (value === null) continue;
      if (key === "class") element.className = String(value);
      else (element as Record<string, unknown>)[key] = value;
    }
  }
}

test("builds a lightweight browser-open PDF attachment link", () => {
  const element = buildPdfLink(
    fakeNode(),
    "https://signed.example/vault/report.pdf",
    "vault/report.pdf",
  ) as unknown as { className: string; children: Array<Record<string, string> & { children?: Array<Record<string, string>> }> };

  assert.equal(element.className, "oss-pdf-attachment");
  assert.equal(element.children[0].textContent, "PDF");
  assert.equal(element.children[1].children?.[0].textContent, "report.pdf");
  assert.equal(element.children[2].href, "https://signed.example/vault/report.pdf");
  assert.equal(element.children[2].target, "_blank");
  assert.equal(element.children[2].className, "oss-pdf-open");
});

test("contains a rejected speculative PDF lease warmup", async () => {
  const listeners = new Map<string, () => void>();
  const rejection = new Error("signing unavailable");
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    buildPdfLink(
      fakeNode(listeners),
      "https://signed.example/old.pdf",
      "vault/report.pdf",
      undefined,
      {
        resolve: async () => Promise.reject(rejection),
        resolveLease: async () => Promise.reject(rejection),
      },
    );

    listeners.get("pointerdown")?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("uses Markdown alt text as the PDF display name", () => {
  const element = buildPdfLink(
    fakeNode(),
    "https://signed.example/vault/uuid.pdf",
    "vault/7c4d2943-d8e0-4d5b-bd27-e09470e9dba3.pdf",
    "  百鸟数据-声纹检测报告.pdf  ",
  ) as unknown as { children: Array<{ children?: Array<Record<string, string>> }> };

  assert.equal(element.children[1].children?.[0].textContent, "百鸟数据-声纹检测报告.pdf");
  assert.equal(element.children[1].children?.[0].title, "百鸟数据-声纹检测报告.pdf");
});

test("creates independent links for three consecutive PDFs", () => {
  const host = fakeNode();
  const links = ["one.pdf", "two.pdf", "three.pdf"].map((name) =>
    buildPdfLink(host, `https://signed.example/${name}`, `vault/${name}`),
  ) as unknown as Array<{ children: Array<Record<string, string> & { children?: Array<Record<string, string>> }> }>;

  assert.deepEqual(links.map((item) => item.children[1].children?.[0].textContent), ["one.pdf", "two.pdf", "three.pdf"]);
  assert.deepEqual(links.map((item) => item.children[2].href), [
    "https://signed.example/one.pdf",
    "https://signed.example/two.pdf",
    "https://signed.example/three.pdf",
  ]);
});
