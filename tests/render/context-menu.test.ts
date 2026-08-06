import assert from "node:assert/strict";
import test from "node:test";
import { removeOssReference } from "../../src/render/context-menu";

test("removes exactly one matching OSS attachment reference", () => {
  const source = [
    "before",
    "![video](oss://vault/video.mp4)",
    "![other](oss://vault/other.mp4)",
    "after",
  ].join("\n");

  const result = removeOssReference(source, "vault/video.mp4");

  assert.equal(result.removed, true);
  assert.doesNotMatch(result.content, /vault\/video\.mp4/);
  assert.match(result.content, /vault\/other\.mp4/);
});

test("matches Electron-encoded unicode OSS keys without touching siblings", () => {
  const source = "![](oss://%E8%AE%B8%E5%87%AF/a.pdf)\n![](oss://%E8%AE%B8%E5%87%AF/b.pdf)";

  const result = removeOssReference(source, "许凯/a.pdf");

  assert.equal(result.removed, true);
  assert.equal(result.content, "\n![](oss://%E8%AE%B8%E5%87%AF/b.pdf)");
});

test("leaves markdown unchanged when the requested OSS key is absent", () => {
  const source = "![](oss://vault/a.pdf)";
  assert.deepEqual(removeOssReference(source, "vault/missing.pdf"), { content: source, removed: false });
});
