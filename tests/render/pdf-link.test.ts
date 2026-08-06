import assert from "node:assert/strict";
import test from "node:test";
import { buildPdfLink } from "../../src/render/pdf-link";

function fakeDocument() {
  return {
    createElement(tagName: string) {
      return {
        tagName: tagName.toUpperCase(),
        className: "",
        textContent: "",
        href: "",
        target: "",
        rel: "",
        dataset: {} as Record<string, string>,
        children: [] as unknown[],
        append(...children: unknown[]) { this.children.push(...children); },
      };
    },
  } as unknown as Document;
}

test("builds a lightweight browser-open PDF attachment link", () => {
  const element = buildPdfLink(
    fakeDocument(),
    "https://signed.example/vault/report.pdf",
    "vault/report.pdf",
  ) as unknown as { className: string; children: Array<Record<string, string>> };

  assert.equal(element.className, "oss-pdf-attachment");
  assert.equal(element.children[0].textContent, "report.pdf");
  assert.equal(element.children[1].href, "https://signed.example/vault/report.pdf");
  assert.equal(element.children[1].target, "_blank");
  assert.equal(element.children[1].className, "oss-pdf-open");
});

test("creates independent links for three consecutive PDFs", () => {
  const doc = fakeDocument();
  const links = ["one.pdf", "two.pdf", "three.pdf"].map((name) =>
    buildPdfLink(doc, `https://signed.example/${name}`, `vault/${name}`),
  ) as unknown as Array<{ children: Array<Record<string, string>> }>;

  assert.deepEqual(links.map((item) => item.children[0].textContent), ["one.pdf", "two.pdf", "three.pdf"]);
  assert.deepEqual(links.map((item) => item.children[1].href), [
    "https://signed.example/one.pdf",
    "https://signed.example/two.pdf",
    "https://signed.example/three.pdf",
  ]);
});
