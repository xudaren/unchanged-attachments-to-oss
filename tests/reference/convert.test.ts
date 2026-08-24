import assert from "node:assert/strict";
import test from "node:test";
import { TFile } from "obsidian";
import { setOssReferenceHost, setOssReferenceHosts } from "../../src/reference/codec";
import { normalizeVaultReferencesToAccessHost } from "../../src/reference/convert";

const HOST = "bucket-a.oss-cn-hangzhou.aliyuncs.com";
const CUSTOM = "cdn.example.com";

function makeVault(contents: Record<string, string>, unreadable: string[] = []) {
  const files = Object.keys(contents).map((path) => new TFile(path));
  const processed: string[] = [];
  const vault = {
    getFiles: () => files,
    read: async (file: TFile) => {
      if (unreadable.includes(file.path)) throw new Error("unreadable");
      return contents[file.path];
    },
    process: async (file: TFile, fn: (content: string) => string) => {
      processed.push(file.path);
      contents[file.path] = fn(contents[file.path]);
      return contents[file.path];
    },
  };
  return { vault: vault as never, contents, processed };
}

test("converts legacy oss:// references across md, canvas and base", async () => {
  const { vault, contents, processed } = makeVault({
    "note.md": "![](oss://vault/a.png)",
    "board.canvas": `"text": "![](oss:///vault/%E6%8A%A5%E5%91%8A.pdf)"`,
    "index.base": "![](oss://vault/b.mp4)",
    "image.png": "binary",
  });

  const result = await normalizeVaultReferencesToAccessHost(vault, HOST);

  assert.equal(result.scanned, 3);
  assert.equal(result.converted, 3);
  assert.deepEqual(result.failedPaths, []);
  assert.equal(contents["note.md"], `![](https://${HOST}/vault/a.png)`);
  assert.equal(contents["board.canvas"], `"text": "![](https://${HOST}/vault/%E6%8A%A5%E5%91%8A.pdf)"`);
  assert.equal(contents["index.base"], `![](https://${HOST}/vault/b.mp4)`);
  assert.ok(!processed.includes("image.png"));
});

test("is idempotent and skips files without legacy references", async () => {
  const { vault, contents, processed } = makeVault({
    "modern.md": `![](https://${HOST}/vault/a.png)`,
    "mixed.md": `![](oss://vault/b.png)`,
  });

  const first = await normalizeVaultReferencesToAccessHost(vault, HOST);
  assert.equal(first.converted, 1);

  const second = await normalizeVaultReferencesToAccessHost(vault, HOST);
  assert.equal(second.scanned, 2);
  assert.equal(second.converted, 0);
  assert.deepEqual(processed, ["mixed.md"]);
  assert.equal(contents["modern.md"], `![](https://${HOST}/vault/a.png)`);
});

test("reports unreadable files without aborting the conversion", async () => {
  const { vault, contents } = makeVault(
    {
      "good.md": "![](oss://vault/a.png)",
      "broken.md": "![](oss://vault/b.png)",
    },
    ["broken.md"],
  );

  const result = await normalizeVaultReferencesToAccessHost(vault, HOST);

  assert.equal(result.converted, 1);
  assert.deepEqual(result.failedPaths, ["broken.md"]);
  assert.equal(contents["good.md"], `![](https://${HOST}/vault/a.png)`);
});

test("stops writing once the lifecycle gate quiesces", async () => {
  const { vault, contents, processed } = makeVault({
    "a.md": "![](oss://vault/a.png)",
    "b.md": "![](oss://vault/b.png)",
  });
  let allowed = true;

  const result = await normalizeVaultReferencesToAccessHost(vault, HOST, {
    concurrency: 1,
    shouldContinue: () => allowed,
  });
  allowed = false;

  assert.equal(result.converted, 2);
  const stopped = await normalizeVaultReferencesToAccessHost(vault, HOST, {
    concurrency: 1,
    shouldContinue: () => allowed,
  });
  assert.equal(stopped.converted, 0);
  assert.equal(processed.length, 2);
  assert.equal(contents["a.md"], `![](https://${HOST}/vault/a.png)`);
});

test("rewrites retired-host public URLs to the current access host", async () => {
  setOssReferenceHosts(CUSTOM, [CUSTOM, HOST]);
  try {
    const { vault, contents, processed } = makeVault({
      "old.md": `![](https://${HOST}/vault/a.png)`,
      "new.md": `![](https://${CUSTOM}/vault/b.png)`,
      "legacy.md": "![](oss:///vault/c.png)",
    });

    const result = await normalizeVaultReferencesToAccessHost(vault, CUSTOM);

    assert.equal(result.converted, 2);
    assert.equal(contents["old.md"], `![](https://${CUSTOM}/vault/a.png)`);
    assert.equal(contents["legacy.md"], `![](https://${CUSTOM}/vault/c.png)`);
    assert.ok(!processed.includes("new.md"));
  } finally {
    setOssReferenceHost("");
  }
});

test("migrates retired custom-domain references after an access-host switch", async () => {
  // A domain replaced by a newer custom domain stays in the recognition set
  // (retiredAccessDomains), so the normalize command can still migrate it.
  const RETIRED = "old-cdn.example.com";
  const CURRENT = "new-cdn.example.com";
  setOssReferenceHosts(CURRENT, [CURRENT, HOST, RETIRED]);
  try {
    const { vault, contents } = makeVault({
      "old.md": `![](https://${RETIRED}/vault/a.png)`,
      "current.md": `![](https://${CURRENT}/vault/b.png)`,
    });

    const result = await normalizeVaultReferencesToAccessHost(vault, CURRENT);

    assert.equal(result.converted, 1);
    assert.equal(contents["old.md"], `![](https://${CURRENT}/vault/a.png)`);
    assert.equal(contents["current.md"], `![](https://${CURRENT}/vault/b.png)`);
  } finally {
    setOssReferenceHost("");
  }
});
