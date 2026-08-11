import assert from "node:assert/strict";
import test from "node:test";
import { buildPdfLink } from "../../src/render/pdf-link";

function fakeDocument(listeners?: Map<string, () => void>) {
  return {
    createElement(tagName: string) {
      return {
        tagName: tagName.toUpperCase(),
        className: "",
        textContent: "",
        href: "",
        target: "",
        rel: "",
        title: "",
        dataset: {} as Record<string, string>,
        children: [] as unknown[],
        append(...children: unknown[]) { this.children.push(...children); },
        addEventListener(type: string, listener: () => void) { listeners?.set(type, listener); },
      };
    },
  } as unknown as Document;
}

test("builds a lightweight browser-open PDF attachment link", () => {
  const element = buildPdfLink(
    fakeDocument(),
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
      fakeDocument(listeners),
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
    fakeDocument(),
    "https://signed.example/vault/uuid.pdf",
    "vault/7c4d2943-d8e0-4d5b-bd27-e09470e9dba3.pdf",
    "  百鸟数据-声纹检测报告.pdf  ",
  ) as unknown as { children: Array<{ children?: Array<Record<string, string>> }> };

  assert.equal(element.children[1].children?.[0].textContent, "百鸟数据-声纹检测报告.pdf");
  assert.equal(element.children[1].children?.[0].title, "百鸟数据-声纹检测报告.pdf");
});

test("creates independent links for three consecutive PDFs", () => {
  const doc = fakeDocument();
  const links = ["one.pdf", "two.pdf", "three.pdf"].map((name) =>
    buildPdfLink(doc, `https://signed.example/${name}`, `vault/${name}`),
  ) as unknown as Array<{ children: Array<Record<string, string> & { children?: Array<Record<string, string>> }> }>;

  assert.deepEqual(links.map((item) => item.children[1].children?.[0].textContent), ["one.pdf", "two.pdf", "three.pdf"]);
  assert.deepEqual(links.map((item) => item.children[2].href), [
    "https://signed.example/one.pdf",
    "https://signed.example/two.pdf",
    "https://signed.example/three.pdf",
  ]);
});
