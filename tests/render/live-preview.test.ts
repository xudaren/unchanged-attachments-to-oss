import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("uses one incremental observer for Live Preview and Canvas", () => {
  const source = readFileSync("src/main.ts", "utf8");

  assert.doesNotMatch(source, /registerEditorExtension/);
  assert.match(
    source,
    /workspace\.onLayoutReady\(\(\) => \{[\s\S]*?new MutationObserver\(\(records\)/,
  );
  assert.match(source, /new MutationObserver\(\(records\)/);
  assert.match(source, /selectMutationRoots\(records\)/);
  assert.match(source, /hydrateOssSubtree\(root, this\.urlResolver, undefined, this\.attachmentContextMenu\)/);
  assert.match(source, /renderObserver\.observe\(this\.app\.workspace\.containerEl/);
  assert.match(source, /attributeFilter:\s*\["src", "href"\]/);
  assert.match(source, /let renderDisposed = false/);
  assert.match(source, /if \(renderDisposed\) return/);
  assert.match(source, /renderDisposed = true;[\s\S]*?renderObserver\?\.disconnect\(\)/);
  assert.match(source, /renderObserver\?\.disconnect\(\)/);
});

test("does not rescan the whole document inside mutation callbacks", () => {
  const source = readFileSync("src/main.ts", "utf8");
  const callback = source.match(/new MutationObserver\(\(records\) => \{([\s\S]*?)\n\s*\}\);/);

  assert.ok(callback, "MutationObserver callback not found");
  assert.doesNotMatch(callback[1], /hydrateOssSubtree\(document/);
  assert.doesNotMatch(callback[1], /querySelectorAll/);
});
