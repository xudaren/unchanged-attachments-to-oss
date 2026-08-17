import assert from "node:assert/strict";
import test from "node:test";
import {
  formatOssReference,
  formatOssUrl,
  parseOssUrl,
  removeFirstOssReference,
  scanOssReferences,
} from "../../src/reference/codec";

test("round-trips Object Keys containing spaces, unicode and Markdown punctuation", () => {
  const key = "My Vault (2026)/报告 #1?.pdf";
  const url = formatOssUrl(key);
  assert.equal(url, "oss:///My%20Vault%20%282026%29/%E6%8A%A5%E5%91%8A%20%231%3F.pdf");
  assert.equal(parseOssUrl(url), key);
  assert.equal(parseOssUrl(`oss://${key}`), key);
});

test("rejects dot path segments that URL normalization would silently collapse", () => {
  assert.throws(() => formatOssUrl("vault/.././report.pdf"), /路径段/);
  assert.equal(parseOssUrl("oss:///vault/%2E%2E/report.pdf"), null);
  assert.throws(() => formatOssUrl(""), /不能为空/);
});

test("preserves leading slash keys and rejects damaged percent escapes", () => {
  const key = "/legacy vault/report.pdf";
  const url = formatOssUrl(key);
  assert.equal(url, "oss:////legacy%20vault/report.pdf");
  assert.equal(parseOssUrl(url), key);
  assert.equal(parseOssUrl("oss:///vault/bad%escape.pdf"), null);
  assert.equal(parseOssUrl(" oss:///vault/report.pdf"), null);
});

test("formats and scans one canonical permanent Markdown reference", () => {
  const markdown = formatOssReference("My Vault/a)b.pdf", "季度[报告]");
  assert.equal(markdown, "![季度\\[报告\\]](oss:///My%20Vault/a%29b.pdf)");
  assert.deepEqual(scanOssReferences(markdown).map(({ key, alt }) => ({ key, alt })), [
    { key: "My Vault/a)b.pdf", alt: "季度[报告]" },
  ]);
});

test("scanner ignores frontmatter, comments, fenced code and inline code", () => {
  const real = formatOssReference("vault/real.png", "real");
  const fake = formatOssReference("vault/fake.png", "fake");
  const content = [
    "---",
    `cover: ${fake}`,
    "---",
    `<!-- ${fake} -->`,
    `\`${fake}\``,
    "```md",
    fake,
    "```",
    real,
  ].join("\n");
  assert.deepEqual(scanOssReferences(content).map((reference) => reference.key), ["vault/real.png"]);
});

test("scanner does not truncate frontmatter at a block-scalar --- inside YAML", () => {
  const real = formatOssReference("vault/real.png", "real");
  const fake = formatOssReference("vault/fake.png", "fake");
  // YAML block scalar whose body contains a line that looks like a frontmatter
  // closing marker. The real closing --- is on the last frontmatter line.
  // fake lives inside frontmatter and must be excluded.
  const content = [
    "---",
    "title: notes",
    "description: |",
    `  excerpt: ${fake}`,
    "  ---",
    "  some literal text",
    "---",
    real,
  ].join("\n");
  assert.deepEqual(scanOssReferences(content).map((reference) => reference.key), ["vault/real.png"]);
});

test("removes only one matching occurrence and can prefer a source offset", () => {
  const first = formatOssReference("vault/a.png", "first");
  const second = formatOssReference("vault/a.png", "second");
  const content = `${first}\ntext\n${second}`;
  const result = removeFirstOssReference(content, "vault/a.png", content.indexOf(second));
  assert.equal(result.removed, true);
  assert.equal(result.content, `${first}\ntext\n`);
  assert.equal(result.reference?.alt, "second");
});
