import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOssReferenceHostInstalled,
  formatOssReference,
  formatOssUrl,
  formatPublicUrl,
  normalizeOssReferencesToAccessHost,
  parseOssReferenceUrl,
  parseOssUrl,
  parsePublicUrl,
  removeFirstOssReference,
  scanOssReferences,
  setOssReferenceHost,
  setOssReferenceHosts,
} from "../../src/reference/codec";

const HOST = "bucket-a.oss-cn-hangzhou.aliyuncs.com";
const CUSTOM = "cdn.example.com";

test("installed recognition set accepts the access host and the permanent default host", () => {
  setOssReferenceHosts(CUSTOM, [CUSTOM, HOST]);
  try {
    // Formatting always targets the primary access host.
    assert.equal(
      formatOssReference("vault/a.png", ""),
      `![](https://${CUSTOM}/vault/a.png)`,
    );
    // Both the access host and the default host stay recognizable.
    assert.equal(parseOssReferenceUrl(`https://${CUSTOM}/vault/a.png`), "vault/a.png");
    assert.equal(parseOssReferenceUrl(`https://${HOST}/vault/a.png`), "vault/a.png");
    assert.equal(parseOssReferenceUrl("https://foreign.example.com/vault/a.png"), null);
    assert.deepEqual(
      scanOssReferences(`![x](https://${HOST}/vault/a.png)`).map((reference) => reference.key),
      ["vault/a.png"],
    );
  } finally {
    setOssReferenceHost("");
  }
});

test("single-host install keeps the legacy recognition contract", () => {
  setOssReferenceHost(HOST);
  try {
    assert.equal(parseOssReferenceUrl(`https://${HOST}/vault/a.png`), "vault/a.png");
    assert.equal(parseOssReferenceUrl(`https://${CUSTOM}/vault/a.png`), null);
  } finally {
    setOssReferenceHost("");
  }
});

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
  const markdown = formatOssReference("My Vault/a)b.pdf", "季度[报告]", HOST);
  assert.equal(markdown, "![季度\\[报告\\]](https://bucket-a.oss-cn-hangzhou.aliyuncs.com/My%20Vault/a%29b.pdf)");
  assert.deepEqual(scanOssReferences(markdown, HOST).map(({ key, alt }) => ({ key, alt })), [
    { key: "My Vault/a)b.pdf", alt: "季度[报告]" },
  ]);
});

test("public URL formatting requires a host and round-trips through parsing", () => {
  const key = "My Vault (2026)/报告 #1?.pdf";
  assert.throws(() => formatPublicUrl(key, ""), /host/);
  const url = formatPublicUrl(key, HOST);
  assert.equal(url, `https://${HOST}/My%20Vault%20%282026%29/%E6%8A%A5%E5%91%8A%20%231%3F.pdf`);
  assert.equal(parsePublicUrl(url, HOST), key);
  assert.equal(parseOssReferenceUrl(url, HOST), key);
  assert.equal(parseOssReferenceUrl(formatOssUrl(key), HOST), key);
});

test("public URL parsing rejects host mismatch, dot segments and damaged escapes", () => {
  assert.equal(parsePublicUrl(`https://other.example.com/vault/a.png`, HOST), null);
  assert.equal(parsePublicUrl(`https://${HOST}/vault/%2E%2E/a.png`, HOST), null);
  assert.equal(parsePublicUrl(`https://${HOST}/vault/bad%escape.png`, HOST), null);
  assert.equal(parsePublicUrl(` https://${HOST}/vault/a.png`, HOST), null);
  assert.equal(parsePublicUrl(`https://${HOST}/`, HOST), null);
  // Trailing query or fragment is tolerated: signing only ever appends query params.
  assert.equal(parsePublicUrl(`https://${HOST}/vault/a.png?x-oss-date=1`, HOST), "vault/a.png");
});

test("scanner matches both reference forms and ignores foreign hosts", () => {
  const legacy = formatOssReference("vault/legacy.png", "legacy");
  const current = formatOssReference("vault/current.png", "current", HOST);
  const foreign = `![foreign](https://other.example.com/vault/foreign.png)`;
  const content = [legacy, current, foreign].join("\n");
  assert.deepEqual(
    scanOssReferences(content, HOST).map((reference) => reference.key),
    ["vault/legacy.png", "vault/current.png"],
  );
  // Without a configured host only the legacy form remains recognizable.
  assert.deepEqual(
    scanOssReferences(content).map((reference) => reference.key),
    ["vault/legacy.png"],
  );
});

test("removes the public URL form of a reference exactly once", () => {
  const current = formatOssReference("vault/a.png", "a", HOST);
  const result = removeFirstOssReference(`text\n${current}`, "vault/a.png", undefined, HOST);
  assert.equal(result.removed, true);
  assert.equal(result.content, "text\n");
});

test("normalizes legacy and retired-host references to the access host idempotently", () => {
  setOssReferenceHosts(CUSTOM, [CUSTOM, HOST]);
  try {
    const legacy = formatOssReference("vault/a b.png", "报告");
    const retired = formatOssReference("vault/b.png", "b", HOST);
    const content = `${legacy}\n${retired}\n\`\`${legacy}\n\`\``;
    const once = normalizeOssReferencesToAccessHost(content, CUSTOM);
    assert.equal(
      once,
      `${formatOssReference("vault/a b.png", "报告", CUSTOM)}\n${formatOssReference("vault/b.png", "b", CUSTOM)}\n\`\`${legacy}\n\`\``,
    );
    assert.equal(normalizeOssReferencesToAccessHost(once, CUSTOM), once);
    // Already-normal references are byte-identical: no rewrite, no churn.
    const current = formatOssReference("vault/c.png", "c", CUSTOM);
    assert.equal(normalizeOssReferencesToAccessHost(current, CUSTOM), current);
  } finally {
    setOssReferenceHost("");
  }
});

test("scanner ignores frontmatter, comments, fenced code and inline code", () => {
  const real = formatOssReference("vault/real.png", "real", HOST);
  const fake = formatOssReference("vault/fake.png", "fake", HOST);
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
  assert.deepEqual(scanOssReferences(content, HOST).map((reference) => reference.key), ["vault/real.png"]);
});

test("scanner does not truncate frontmatter at a block-scalar --- inside YAML", () => {
  const real = formatOssReference("vault/real.png", "real", HOST);
  const fake = formatOssReference("vault/fake.png", "fake", HOST);
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
  assert.deepEqual(scanOssReferences(content, HOST).map((reference) => reference.key), ["vault/real.png"]);
});

test("removes only one matching occurrence and can prefer a source offset", () => {
  const first = formatOssReference("vault/a.png", "first", HOST);
  const second = formatOssReference("vault/a.png", "second", HOST);
  const content = `${first}\ntext\n${second}`;
  const result = removeFirstOssReference(content, "vault/a.png", content.indexOf(second), HOST);
  assert.equal(result.removed, true);
  assert.equal(result.content, `${first}\ntext\n`);
  assert.equal(result.reference?.alt, "second");
});

test("recognition set keeps retired access hosts parseable without formatting them", () => {
  const RETIRED = "old-cdn.example.com";
  setOssReferenceHosts(CUSTOM, [CUSTOM, HOST, RETIRED]);
  try {
    assert.equal(parseOssReferenceUrl(`https://${RETIRED}/vault/a.png`), "vault/a.png");
    // Formatting always targets the primary access host, never a retired one.
    assert.equal(formatOssReference("vault/a.png", ""), `![](https://${CUSTOM}/vault/a.png)`);
  } finally {
    setOssReferenceHost("");
  }
});

test("commit guard rejects new references while no access host is installed", () => {
  setOssReferenceHost("");
  assert.throws(() => assertOssReferenceHostInstalled(), /host/);
  setOssReferenceHost(HOST);
  try {
    assert.doesNotThrow(() => assertOssReferenceHostInstalled());
  } finally {
    setOssReferenceHost("");
  }
});
