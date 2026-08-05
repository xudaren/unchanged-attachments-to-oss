import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("hides only Obsidian native oss image nodes", () => {
  const css = readFileSync("styles.css", "utf8");

  assert.match(css, /img\[src\^=["']oss:\/\/["']\]/);
  assert.match(css, /\.canvas-node[^\n]*img\[src\^=["']oss:\/\/["']\]/);
  assert.match(css, /display:\s*none/);
  assert.match(css, /\.oss-render-error/);
  assert.doesNotMatch(css, /img\[src\^=["']https:\/\/["']\]/);
});
