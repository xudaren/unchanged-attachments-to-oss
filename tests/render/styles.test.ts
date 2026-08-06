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

test("styles a lightweight full-width PDF attachment card", () => {
  const css = readFileSync("styles.css", "utf8");

  assert.match(css, /\.oss-pdf-attachment/);
  assert.match(css, /\.oss-pdf-name/);
  assert.match(css, /\.oss-pdf-badge/);
  assert.match(css, /\.oss-pdf-details/);
  assert.match(css, /\.oss-pdf-meta/);
  assert.match(css, /\.oss-pdf-open/);
  assert.match(css, /width:\s*100%/);
  assert.match(css, /var\(--background-secondary/);
  assert.match(css, /\.markdown-source-view \.cm-embed-block:has\(\.oss-pdf-attachment\)/);
  assert.match(css, /\.markdown-source-view \.internal-embed:has\(\.oss-pdf-attachment\)/);
  assert.match(css, /\.markdown-source-view \.cm-line:has\(\.oss-pdf-attachment\)/);
  assert.match(css, /\.markdown-source-view \.oss-pdf-live-preview-host/);
  assert.match(css, /\.markdown-source-view \.oss-pdf-live-preview-line/);
  assert.match(css, /\.markdown-reading-view \.oss-pdf-attachment/);
  assert.match(css, /\.canvas-node \.oss-pdf-attachment/);
});

test("does not include inline PDF viewer or canvas styles", () => {
  const css = readFileSync("styles.css", "utf8");

  assert.doesNotMatch(css, /oss-pdf-viewer/);
  assert.doesNotMatch(css, /oss-pdf-canvas/);
});
