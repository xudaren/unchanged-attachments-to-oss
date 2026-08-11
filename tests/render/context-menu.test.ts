import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TFile } from "obsidian";
import { OssAttachmentContextMenu, removeOssReference } from "../../src/render/context-menu";

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

test("refuses removal when the source document contains duplicate keys", async () => {
  const file = new TFile("note.md");
  let confirmations = 0;
  const plugin = {
    app: {
      vault: {
        getAbstractFileByPath: () => file,
        cachedRead: async () => "![](oss:///vault/a.pdf)\n![copy](oss:///vault/a.pdf)",
      },
    },
  };
  const menu = new OssAttachmentContextMenu(
    plugin as never,
    () => { confirmations += 1; },
    { resolve: async () => "https://signed.example/a.pdf" },
  );

  await (menu as unknown as { removeReference(path: string, key: string, label: string): Promise<void> })
    .removeReference("note.md", "vault/a.pdf", "PDF");

  assert.equal(confirmations, 0);
});

test("never guesses a Live Preview or Canvas source from the active Markdown view", () => {
  const source = readFileSync("src/render/context-menu.ts", "utf8");
  assert.doesNotMatch(source, /getActiveViewOfType|MarkdownView/);
  assert.match(source, /const sourcePath = data\.sourcePath \|\| null/);
  assert.match(source, /this\.lifetime\.abort\(\)/);
  assert.match(source, /for \(const modal of \[\.\.\.this\.previewModals\]\) modal\.close\(\)/);
});

test("dispose aborts a detached attachment listener and rejects future binds", () => {
  let listener: ((event: Event) => void) | undefined;
  const element = {
    dataset: {} as Record<string, string>,
    addEventListener: (_name: string, next: (event: Event) => void, options?: AddEventListenerOptions) => {
      listener = next;
      options?.signal?.addEventListener("abort", () => { listener = undefined; }, { once: true });
    },
    removeEventListener: () => { listener = undefined; },
  } as unknown as HTMLElement;
  const menu = new OssAttachmentContextMenu(
    { app: {} } as never,
    undefined,
    { resolve: async () => "https://signed.example/video.mp4" },
  );

  menu.bind(element, "video", "", "vault/video.mp4");
  assert.equal(typeof listener, "function");

  menu.dispose();
  assert.equal(listener, undefined);
  menu.bind(element, "video", "", "vault/video.mp4");
  assert.equal(listener, undefined);
});
