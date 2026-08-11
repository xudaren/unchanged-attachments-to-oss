import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("uses one incremental observer only for Live Preview", () => {
  const source = readFileSync("src/main.ts", "utf8");

  assert.doesNotMatch(source, /registerEditorExtension/);
  assert.match(
    source,
    /workspace\.onLayoutReady\(\(\) => \{[\s\S]*?new MutationObserver\(\(records\)/,
  );
  assert.match(source, /new MutationObserver\(\(records\)/);
  assert.match(source, /selectMutationRoots\(records\)/);
  assert.match(
    source,
    /hydrateOssSubtree\([\s\S]*?root,[\s\S]*?this\.urlResolver,[\s\S]*?this\.attachmentContextMenu,[\s\S]*?this\.renderLifetime/,
  );
  assert.match(source, /renderObserver\.observe\(this\.app\.workspace\.containerEl/);
  assert.match(source, /attributeFilter:\s*\["src", "href"\]/);
  assert.match(source, /let layoutDisposed = false/);
  assert.match(source, /if \(layoutDisposed \|\| !this\.lifecycle\.isActive\) return/);
  assert.match(source, /layoutDisposed = true;[\s\S]*?renderObserver\?\.disconnect\(\)/);
  assert.match(source, /renderObserver\?\.disconnect\(\)/);
  assert.match(
    source,
    /renderObserver\?\.disconnect\(\);[\s\S]*?this\.urlResolver\.dispose\(\);[\s\S]*?this\.renderLifetime\.dispose\(\);[\s\S]*?disposeOssRenderSessions\(this\.app\.workspace\.containerEl, this\.attachmentContextMenu\);[\s\S]*?this\.attachmentContextMenu\.dispose\(\);[\s\S]*?disconnectMediaLoading\(\)/,
  );
  assert.match(source, /disposeRemovedOssRenderSessions\(records, this\.attachmentContextMenu\)/);
  assert.match(source, /createOssPostProcessor\([\s\S]*?this\.renderLifetime/);
  const renderer = readFileSync("src/render/dom-renderer.ts", "utf8");
  assert.match(renderer, /RENDER_SURFACE_SELECTOR = "\.markdown-source-view"/);
  assert.doesNotMatch(renderer, /RENDER_SURFACE_SELECTOR = [^\n]*canvas-node/);
});

test("does not rescan the whole document inside mutation callbacks", () => {
  const source = readFileSync("src/main.ts", "utf8");
  const callback = source.match(/new MutationObserver\(\(records\) => \{([\s\S]*?)\n\s*\}\);/);

  assert.ok(callback, "MutationObserver callback not found");
  assert.doesNotMatch(callback[1], /hydrateOssSubtree\(document/);
  assert.doesNotMatch(callback[1], /querySelectorAll/);
});

test("mounts fallback media in a plugin slot without replacing the editable host children", () => {
  const source = readFileSync("src/render/dom-renderer.ts", "utf8");
  assert.match(source, /oss-render-slot/);
  assert.match(source, /host\.appendChild\(slot\)/);
  assert.doesNotMatch(source, /element\.replaceChildren\(replacement\)|host\.replaceChildren\(/);
});
