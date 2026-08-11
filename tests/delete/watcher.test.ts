import assert from "node:assert/strict";
import test from "node:test";
import { TFile } from "obsidian";
import {
  collectDocumentOssKeys,
  DeleteWatcher,
  deleteRemoteObject,
} from "../../src/delete/watcher";
import { OssError } from "../../src/oss/client";

function makeHarness(content = "") {
  let fileMenu: ((menu: any, file: TFile) => void) | undefined;
  const actions: string[] = [];
  const client = {
    deleteObject: async (key: string) => { actions.push(`remote:${key}`); },
  };
  const plugin = {
    app: {
      vault: { cachedRead: async () => content },
      workspace: {
        on: (name: string, callback: (menu: any, file: TFile) => void) => {
          if (name === "file-menu") fileMenu = callback;
          return { name, callback };
        },
      },
      fileManager: {
        promptForDeletion: async () => true,
        trashFile: async (file: TFile) => { actions.push(`trash:${file.path}`); },
      },
    },
    registerEvent: () => undefined,
  };
  return {
    actions,
    client,
    plugin,
    getFileMenu: () => fileMenu,
    watcher: () => new DeleteWatcher(plugin as never, client as never),
  };
}

test("startup only registers the explicit file menu and does not read Markdown", () => {
  const harness = makeHarness();
  const watcher = harness.watcher();

  watcher.register();

  assert.equal(typeof harness.getFileMenu(), "function");
  assert.deepEqual(harness.actions, []);
});

test("adds the explicit document deletion action only for Markdown files", () => {
  const harness = makeHarness();
  harness.watcher().register();
  const titles: string[] = [];
  const menu = {
    addSeparator: () => undefined,
    addItem: (build: (item: any) => void) => build({
      setTitle(title: string) { titles.push(title); return this; },
      setIcon() { return this; },
      onClick() { return this; },
    }),
  };

  harness.getFileMenu()?.(menu, new TFile("note.md"));
  harness.getFileMenu()?.(menu, new TFile("image.png"));

  assert.deepEqual(titles, ["删除文档并处理 OSS 附件"]);
});

test("extracts unique real OSS keys and ignores uploading placeholders", () => {
  assert.deepEqual(collectDocumentOssKeys([
    "![](oss://vault/a.png)",
    "![](oss://vault/a.png)",
    "![](oss:///vault/%E6%8A%A5%E5%91%8A.pdf)",
    "![](oss://uploading/temp)",
  ].join("\n")), ["vault/a.png", "vault/报告.pdf"]);
});

test("moves the document to trash before deleting selected OSS objects", async () => {
  const harness = makeHarness();
  const watcher = harness.watcher();

  await (watcher as any).trashDocumentThenDeleteSelected(
    new TFile("note.md"),
    ["vault/a.png", "vault/b.pdf"],
  );

  assert.deepEqual(harness.actions, [
    "trash:note.md",
    "remote:vault/a.png",
    "remote:vault/b.pdf",
  ]);
});

test("never deletes remote objects when moving the document to trash fails", async () => {
  const harness = makeHarness();
  (harness.plugin.app.fileManager as any).trashFile = async () => { throw new Error("locked"); };
  const watcher = harness.watcher();

  await (watcher as any).trashDocumentThenDeleteSelected(new TFile("note.md"), ["vault/a.png"]);

  assert.deepEqual(harness.actions, []);
});

test("remote deletion failure prevents the local reference step", async () => {
  let localRemovalCalled = false;
  const client = { deleteObject: async () => { throw new Error("offline"); } };

  const deleted = await deleteRemoteObject(client as never, "vault/a.png");
  if (deleted) localRemovalCalled = true;

  assert.equal(deleted, false);
  assert.equal(localRemovalCalled, false);
});

test("remote 404 is treated as a configuration failure and preserves the local reference", async () => {
  const client = { deleteObject: async () => { throw new OssError(404, "", "DELETE", "vault/a.png"); } };

  assert.equal(await deleteRemoteObject(client as never, "vault/a.png"), false);
});
