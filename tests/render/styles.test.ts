import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("keeps a visible placeholder for lazy OSS image nodes", () => {
  const css = readFileSync("styles.css", "utf8");

  assert.match(css, /img\[src\^=["']oss:\/\/["']\]/);
  assert.match(css, /\.canvas-node[^\n]*img\[src\^=["']oss:\/\/["']\]/);
  assert.match(css, /min-height:\s*120px/);
  assert.doesNotMatch(css, /img\[src\^=["']oss:\/\/[^}]+display:\s*none/s);
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
  assert.match(css, /\.markdown-source-view \.oss-pdf-live-preview-block/);
  assert.match(css, /\.markdown-source-view \.oss-pdf-live-preview-line/);
  assert.match(css, /\.markdown-reading-view \.oss-pdf-attachment/);
  assert.match(css, /\.canvas-node \.oss-pdf-attachment/);
});

test("does not include inline PDF viewer or canvas styles", () => {
  const css = readFileSync("styles.css", "utf8");

  assert.doesNotMatch(css, /oss-pdf-viewer/);
  assert.doesNotMatch(css, /oss-pdf-canvas/);
});

test("styles the OSS image zoom button and preview modal", () => {
  const css = readFileSync("styles.css", "utf8");
  assert.match(css, /\.oss-image-zoom-button/);
  assert.match(css, /\.modal\.mod-oss-image-preview/);
  assert.match(css, /\.oss-image-preview-content/);
  assert.match(css, /max-height:\s*82vh/);
  assert.match(css, /\.oss-image-zoom-button\s*\{[^}]*right:\s*80px/s);
  assert.doesNotMatch(css, /\.oss-image-preview-host[^}]+display:\s*none/s);
});

test("styles Markdown media names below OSS media", () => {
  const css = readFileSync("styles.css", "utf8");
  assert.match(css, /\.oss-media-label/);
  assert.match(css, /\.oss-media-caption-host/);
  assert.match(css, /\.oss-render-slot/);
  assert.match(css, /text-overflow:\s*ellipsis/);
  assert.match(css, /white-space:\s*nowrap/);
  assert.match(css, /\.oss-audio-live-preview-host/);
  assert.match(css, /\.oss-audio-live-preview-host\s*>\s*audio/);
  assert.match(css, /\.oss-media-caption-host:has\(> audio\)/);
  assert.match(css, /\.oss-pdf-attachment\s*\{[\s\S]*?width:\s*100%/);
  assert.match(css, /\.markdown-source-view \.cm-embed-block:has\(\.oss-audio-live-preview-host\)/);
  assert.match(css, /\.markdown-source-view \.internal-embed:has\(\.oss-audio-live-preview-host\)/);
  assert.match(css, /\.markdown-source-view \.cm-line:has\(\.oss-audio-live-preview-host\)/);
  assert.match(css, /\.markdown-source-view \.oss-audio-live-preview-block/);
  assert.match(css, /\.markdown-source-view \.oss-audio-live-preview-wrapper/);
  assert.match(css, /\.markdown-source-view \.oss-audio-live-preview-wrapper > audio/);
  assert.match(css, /\.markdown-source-view \.oss-audio-live-preview-line/);
  assert.match(css, /\.markdown-source-view \.oss-pdf-live-preview-wrapper/);
  assert.match(css, /\.oss-audio-live-preview-host > audio/);
  assert.match(css, /\.oss-audio-live-preview-host > audio\s*\{[^}]*width:\s*100%/s);
  assert.match(css, /\.oss-audio-live-preview-wrapper > audio[^}]*width:\s*100%\s*!important/s);
  assert.doesNotMatch(css, /420px/);
});
