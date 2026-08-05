import assert from "node:assert/strict";
import test from "node:test";
import { ossKeyFromImageSource } from "../../src/render/oss-source";

test("restores Electron-normalized Chinese oss image sources", () => {
  assert.equal(
    ossKeyFromImageSource("oss:///%E8%AE%B8%E5%87%AF%E6%B5%8B%E8%AF%95oss%E6%8F%92%E4%BB%B6/a.jpg"),
    "许凯测试oss插件/a.jpg",
  );
});

test("keeps raw oss keys and rejects other protocols", () => {
  assert.equal(ossKeyFromImageSource("oss://vault/a.jpg"), "vault/a.jpg");
  assert.equal(ossKeyFromImageSource("https://example.com/a.jpg"), null);
});
