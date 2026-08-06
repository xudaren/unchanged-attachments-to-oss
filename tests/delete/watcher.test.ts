import assert from "node:assert/strict";
import test from "node:test";
import { TFile } from "obsidian";
import { DeleteWatcher, deleteRemoteObject } from "../../src/delete/watcher";
import { OssError } from "../../src/oss/client";

type EventName = "create" | "modify" | "delete" | "rename";

function makeHarness(files: TFile[] = []) {
  const listeners = new Map<EventName, Array<(...args: any[]) => void>>();
  const contents = new Map<string, string>();
  const vault = {
    getMarkdownFiles: () => files,
    cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
    on: (name: EventName, callback: (...args: any[]) => void) => {
      const entries = listeners.get(name) ?? [];
      entries.push(callback);
      listeners.set(name, entries);
      return { name, callback };
    },
  };
  const plugin = {
    app: { vault },
    registerEvent: () => undefined,
    register: () => undefined,
  };
  const emit = (name: EventName, ...args: any[]) => {
    for (const callback of listeners.get(name) ?? []) callback(...args);
  };
  return { contents, plugin, emit };
}

async function flushTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

// DeleteWatcher uses the Obsidian window timer API; make debounce immediate in unit tests.
(globalThis as any).window = {
  setTimeout: (callback: () => void) => setTimeout(callback, 0),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
};

test("registers listeners before the initial vault scan finishes", async () => {
  const file = new TFile("note.md");
  const harness = makeHarness([file]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const initial = "![](oss://vault/a.png)";
  harness.contents.set(file.path, initial);
  (harness.plugin.app.vault as any).cachedRead = async () => {
    const snapshot = initial;
    await gate;
    return snapshot;
  };
  const prompts: string[][] = [];
  const watcher = new DeleteWatcher(harness.plugin as never, {} as never);
  (watcher as any).promptDelete = (keys: string[]) => prompts.push(keys);

  const registering = watcher.register();
  harness.contents.set(file.path, "");
  harness.emit("modify", file);
  release();
  await registering;
  // Subsequent reads must observe the changed content.
  (harness.plugin.app.vault as any).cachedRead = async () => "";
  await flushTimers();

  assert.deepEqual(prompts, [["vault/a.png"]]);
});

test("tracks markdown files created after startup", async () => {
  const harness = makeHarness();
  const prompts: string[][] = [];
  const watcher = new DeleteWatcher(harness.plugin as never, {} as never);
  (watcher as any).promptDelete = (keys: string[]) => prompts.push(keys);
  await watcher.register();

  const file = new TFile("new.md");
  harness.contents.set(file.path, "![](oss://vault/new.png)");
  harness.emit("create", file);
  await flushTimers();
  harness.contents.set(file.path, "");
  harness.emit("modify", file);
  await flushTimers();

  assert.deepEqual(prompts, [["vault/new.png"]]);
});

test("document deletion defaults remote objects to unselected", async () => {
  const file = new TFile("note.md");
  const harness = makeHarness([file]);
  harness.contents.set(file.path, "![](oss://vault/a.png)");
  const selections: boolean[] = [];
  const watcher = new DeleteWatcher(harness.plugin as never, {} as never);
  (watcher as any).promptDelete = (_keys: string[], _path: string, _reason: string, selected: boolean) => {
    selections.push(selected);
  };
  await watcher.register();
  harness.emit("delete", file);

  assert.deepEqual(selections, [false]);
});

test("remote deletion failure prevents the local reference step", async () => {
  let localRemovalCalled = false;
  const client = { deleteObject: async () => { throw new Error("offline"); } };

  const deleted = await deleteRemoteObject(client as never, "vault/a.png");
  if (deleted) localRemovalCalled = true;

  assert.equal(deleted, false);
  assert.equal(localRemovalCalled, false);
});

test("remote 404 is treated as deleted so the local reference can be removed", async () => {
  const client = { deleteObject: async () => { throw new OssError(404, "", "DELETE", "vault/a.png"); } };

  assert.equal(await deleteRemoteObject(client as never, "vault/a.png"), true);
});
