import assert from "node:assert/strict";
import test from "node:test";
import { isSupportedExt, mimeOf } from "../../src/types";

test("supports the extended browser-native media formats", () => {
  const expected = {
    avif: "image/avif",
    ogv: "video/ogg",
    m4v: "video/x-m4v",
    aac: "audio/aac",
    opus: "audio/ogg",
  } as const;

  for (const [extension, mime] of Object.entries(expected)) {
    assert.equal(isSupportedExt(extension), true, extension);
    assert.equal(mimeOf(extension), mime, extension);
  }
});

test("keeps Vault-native structured files out of OSS uploads", () => {
  for (const extension of ["md", "canvas", "base"]) {
    assert.equal(isSupportedExt(extension), false, extension);
  }
});
