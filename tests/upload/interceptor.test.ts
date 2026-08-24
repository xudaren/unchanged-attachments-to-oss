import assert from "node:assert/strict";
import test from "node:test";
import {
  AttachmentInterceptor,
  captureAttachment,
  clipboardFiles,
  formatInputReadError,
  formatInputReadFailureMarker,
  isInternalStagingPath,
} from "../../src/upload/interceptor";
import { MarkdownView, TFile, TFolder } from "obsidian";
import { setOssReferenceHost } from "../../src/reference/codec";
import { DEFAULT_SETTINGS, PendingUpload } from "../../src/types";
import { LifecycleQuiescedError, PluginLifecycle } from "../../src/lifecycle";

// New uploads commit the unsigned public URL once the storage host is installed.
const HOST = "bucket-a.oss-cn-hangzhou.aliyuncs.com";
setOssReferenceHost(HOST);

test("captures an input File into a stable Blob before asynchronous upload", async () => {
  let reads = 0;
  const source = {
    name: "clipboard.png",
    type: "image/png",
    arrayBuffer: async () => {
      reads += 1;
      return new TextEncoder().encode("stable bytes").buffer;
    },
  } as File;

  const captured = await captureAttachment(source);
  assert.equal(reads, 1);
  assert.equal(captured.name, "clipboard.png");
  assert.equal(captured.type, "image/png");
  assert.equal(await captured.blob.text(), "stable bytes");
});

test("turns an unreadable cloud placeholder error into an actionable notice", () => {
  const message = formatInputReadError(new DOMException(
    "The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.",
    "NotReadableError",
  ));
  assert.match(message, /云盘/);
  assert.match(message, /iCloud/);
  assert.match(message, /OneDrive/);
  assert.match(message, /下载到本地/);
  assert.doesNotMatch(message, /permission problems/);
  assert.equal(
    formatInputReadFailureMarker("cloud[copy].png"),
    "⚠ 附件读取失败：cloud\\[copy\\].png（请下载到本地后重新粘贴）",
  );
});

test("registers editor interception immediately and create fallback only when requested", () => {
  const workspaceEvents: string[] = [];
  const vaultEvents: string[] = [];
  const metadataEvents: string[] = [];
  const plugin = {
    app: {
      workspace: { on: (name: string) => { workspaceEvents.push(name); return {}; } },
      vault: { on: (name: string) => { vaultEvents.push(name); return {}; } },
      metadataCache: {
        resolvedLinks: {},
        on: (name: string) => { metadataEvents.push(name); return {}; },
      },
    },
    registerEvent: () => undefined,
    register: () => undefined,
  };
  const interceptor = new AttachmentInterceptor(
    plugin as never,
    {} as never,
    { autoUpload: true } as never,
  );

  interceptor.registerEditorEvents();
  assert.deepEqual(workspaceEvents, ["editor-paste", "editor-drop"]);
  assert.deepEqual(metadataEvents, ["resolved"]);
  assert.deepEqual(vaultEvents, ["rename", "delete"]);

  interceptor.registerCreateFallback();
  assert.deepEqual(vaultEvents, ["rename", "delete", "create"]);
});

test("keeps supported clipboard files even when text is an alternate representation", () => {
  const image = { name: "clipboard.png", type: "image/png" } as File;
  const event = {
    clipboardData: {
      items: [{ kind: "file", getAsFile: () => image }],
      files: [image],
      getData: (type: string) => type === "text/plain" ? "clipboard.png" : "<img>",
    },
  };

  assert.deepEqual(clipboardFiles(event as never), [image]);
});

test("merges clipboard item files with the authoritative file list", () => {
  const image = { name: "clipboard.png", type: "image/png" } as File;
  const archive = { name: "archive.zip", type: "application/zip" } as File;
  const event = {
    clipboardData: {
      items: [{ kind: "file", getAsFile: () => image }],
      files: [image, archive],
    },
  };

  assert.deepEqual(clipboardFiles(event as never), [image, archive]);
});

test("deduplicates clipboard files by size+type+name when sources yield different references", () => {
  const a = { name: "clipboard.png", type: "image/png", size: 1234 } as File;
  const b = { name: "clipboard.png", type: "image/png", size: 1234 } as File;
  const event = {
    clipboardData: {
      items: [{ kind: "file", getAsFile: () => a }],
      files: [b],
    },
  };

  const result = clipboardFiles(event as never);
  assert.equal(result.length, 1);
  assert.equal(result[0], a);
});

test("recognizes the durable staging namespace so create fallback cannot re-upload it", () => {
  assert.equal(isInternalStagingPath(".oss-plugin-staging"), true);
  assert.equal(isInternalStagingPath(".oss-plugin-staging/task.png.stage"), true);
  assert.equal(isInternalStagingPath("attachments/task.png"), false);
});

test("startup recovers a byte-first staging file that has no journal", async () => {
  const orphan = new TFile(
    ".oss-plugin-staging/11111111-1111-4111-8111-111111111111.png.stage",
  );
  const claimed = new TFile(
    ".oss-plugin-staging/22222222-2222-4222-8222-222222222222.png.stage",
  );
  const renamed: Array<[string, string]> = [];
  const settings = {
    ...DEFAULT_SETTINGS,
    pendingUploads: {
      claimed: {
        tempId: "claimed",
        objectKey: "vault/claimed.png",
        uploadId: "",
        ext: "png",
        size: 1,
        parts: [],
        phase: "staged" as const,
        sourcePath: "note.md",
        localPath: claimed.path,
        stagingPath: claimed.path,
        createdAt: 1,
        updatedAt: 1,
      },
    },
  };
  const interceptor = new AttachmentInterceptor({
    app: {
      vault: {
        adapter: {
          list: async () => ({ files: [orphan.path, claimed.path], folders: [] }),
          rename: async (path: string, target: string) => { renamed.push([path, target]); },
        },
      },
      fileManager: {
        getAvailablePathForAttachment: async (name: string) => `attachments/${name}`,
      },
      metadataCache: { resolvedLinks: {} },
    },
  } as never, {} as never, settings);

  const recovered = await interceptor.recoverUnjournaledStaging();

  assert.deepEqual(recovered, ["attachments/recovered-11111111-1111-4111-8111-111111111111.png"]);
  assert.deepEqual(renamed, [[
    orphan.path,
    "attachments/recovered-11111111-1111-4111-8111-111111111111.png",
  ]]);
});

test("reuses an existing hidden staging directory that is absent from the Vault index", async () => {
  const result = await runDurabilityFailure("none", false, false, true);

  assert.deepEqual(result.order.slice(0, 2), ["stage", "journal"]);
  assert.equal(result.uploadCalls, 1);
  assert.equal(result.stagingExists, false);
});

test("writes an ordinary local attachment when staging creation fails after capture", async () => {
  const result = await runDurabilityFailure("staging");

  assert.equal(result.prevented, true);
  assert.equal(result.uploadCalls, 0);
  assert.equal(result.localBytes, "captured bytes");
  assert.equal(result.markdown, "![[attachments/clipboard.png]]");
});

test("keeps a visible non-uploading marker when the OS File cannot be captured", async () => {
  let editorValue = "";
  const editor = {
    getCursor: () => ({ line: 0, ch: editorValue.length }),
    posToOffset: (position: { ch: number }) => position.ch,
    offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
    getValue: () => editorValue,
    replaceRange: (replacement: string, from: { ch: number }, to?: { ch: number }) => {
      editorValue = editorValue.slice(0, from.ch) + replacement + editorValue.slice(to?.ch ?? from.ch);
    },
  };
  const source = new TFile("note.md", "note.md");
  const view = new MarkdownView();
  view.file = source;
  const interceptor = new AttachmentInterceptor({
    app: { metadataCache: { resolvedLinks: {} } },
  } as never, {} as never, { ...DEFAULT_SETTINGS, autoUpload: true });
  const unreadable = {
    name: "cloud.png",
    type: "image/png",
    arrayBuffer: async () => { throw new DOMException("unreadable", "NotReadableError"); },
  } as File;

  await (interceptor as unknown as {
    takeOverInput: (files: File[], event: { preventDefault: () => void }, editor: unknown, view: MarkdownView) => Promise<void>;
  }).takeOverInput([unreadable], { preventDefault: () => undefined }, editor, view);

  assert.equal(editorValue, "⚠ 附件读取失败：cloud.png（请下载到本地后重新粘贴）");
  assert.doesNotMatch(editorValue, /oss:\/\/uploading/);
});

test("stages bytes before journaling and safely falls back when journal persistence fails", async () => {
  const result = await runDurabilityFailure("journal");

  assert.deepEqual(result.order.slice(0, 2), ["stage", "journal"]);
  assert.equal(result.uploadCalls, 0);
  assert.equal(result.localBytes, "captured bytes");
  assert.equal(result.markdown, "![[attachments/clipboard.png]]");
  assert.equal(result.stagingExists, false);
});

test("quiescing after a staging failure still preserves already captured bytes locally", async () => {
  const result = await runDurabilityFailure("staging", true);

  assert.equal(result.lifecycleStopped, true);
  assert.equal(result.uploadCalls, 0);
  assert.equal(result.localBytes, "captured bytes");
  assert.match(result.editorValue, /oss:\/\/uploading\//);
});

test("deferred File capture finishes staging and journal before quiesced root drains", async () => {
  const result = await runDurabilityFailure("none", false, true);

  assert.equal(result.lifecycleStopped, true);
  assert.deepEqual(result.order.slice(0, 2), ["stage", "journal"]);
  assert.equal(result.stagingExists, true);
  assert.equal(result.uploadCalls, 0);
});

test("cleanup retry preserves a local attachment changed after upload", async () => {
  const local = Object.assign(new TFile("attachments/image.png", "image.png"), {
    stat: { size: 4, mtime: 200 },
  });
  const pending: PendingUpload = {
    tempId: "task",
    objectKey: "vault/a.png",
    uploadId: "upload-1",
    ext: "png",
    size: 4,
    parts: [{ partNumber: 1, etag: '"etag"' }],
    phase: "cleanup_pending",
    sourcePath: "note.md",
    occurrenceId: "note.md:0:10",
    localPath: local.path,
    sourceMtime: 100,
    createdAt: 1,
    updatedAt: 1,
  };
  let deleted = false;
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: { task: pending } };
  const interceptor = new AttachmentInterceptor({
    app: {
      vault: {
        getAbstractFileByPath: (path: string) => path === local.path ? local : null,
        delete: async () => { deleted = true; },
      },
      metadataCache: { resolvedLinks: {} },
    },
  } as never, {
    getPending: () => pending,
    ensurePendingStorageIdentity: async () => undefined,
  } as never, settings);

  const entry = {
    tempId: pending.tempId,
    mdPath: pending.sourcePath,
    localPath: local.path,
    ext: pending.ext,
    occurrenceId: pending.occurrenceId,
  };
  const retry = await interceptor.retryEntries([entry]);

  assert.equal(deleted, false);
  assert.deepEqual(retry.succeeded, []);
  assert.deepEqual(retry.failed, [entry]);
});

test("cleanup retry never deletes an ordinary same-size file when legacy mtime is missing", async () => {
  const local = Object.assign(new TFile("attachments/image.png", "image.png"), {
    stat: { size: 4, mtime: 200 },
  });
  const pending: PendingUpload = {
    tempId: "legacy-cleanup",
    objectKey: "vault/a.png",
    uploadId: "upload-1",
    ext: "png",
    size: 4,
    parts: [],
    phase: "cleanup_pending",
    sourcePath: "note.md",
    localPath: local.path,
    createdAt: 1,
    updatedAt: 1,
  };
  let deleted = false;
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: { [pending.tempId]: pending } };
  const interceptor = new AttachmentInterceptor({
    app: {
      vault: {
        getAbstractFileByPath: () => local,
        delete: async () => { deleted = true; },
      },
      metadataCache: { resolvedLinks: {} },
    },
  } as never, {
    getPending: () => pending,
    ensurePendingStorageIdentity: async () => undefined,
  } as never, settings);

  const result = await interceptor.retryEntries([{
    tempId: pending.tempId,
    mdPath: pending.sourcePath,
    localPath: local.path,
    ext: pending.ext,
  }]);

  assert.equal(deleted, false);
  assert.equal(result.failed.length, 1);
});

test("cleanup waits until every pending occurrence for one local attachment is cleanup-ready", () => {
  const local = Object.assign(new TFile("attachments/image.png", "image.png"), {
    stat: { size: 4, mtime: 100 },
  });
  const base: PendingUpload = {
    tempId: "ready",
    objectKey: "vault/a.png",
    uploadId: "upload-1",
    ext: "png",
    size: 4,
    parts: [{ partNumber: 1, etag: '"etag"' }],
    phase: "cleanup_pending",
    sourcePath: "note.md",
    localPath: local.path,
    sourceMtime: 100,
    createdAt: 1,
    updatedAt: 1,
  };
  const settings = {
    ...DEFAULT_SETTINGS,
    pendingUploads: {
      ready: base,
      failed: { ...base, tempId: "failed", objectKey: "vault/b.png", phase: "uploading" as const },
    },
  };
  const interceptor = new AttachmentInterceptor({
    app: { metadataCache: { resolvedLinks: {} } },
  } as never, {} as never, settings);

  const canCleanup = (interceptor as unknown as {
    cleanupTasksMatchFile: (file: TFile) => boolean;
  }).cleanupTasksMatchFile(local);
  assert.equal(canCleanup, false);
});

test("cleanup retry rechecks same-size mtime after the stable MetadataCache wait", async () => {
  let current = Object.assign(new TFile("attachments/image.png", "image.png"), {
    stat: { size: 4, mtime: 100 },
  });
  const pending: PendingUpload = {
    tempId: "task",
    objectKey: "vault/a.png",
    uploadId: "upload-1",
    ext: "png",
    size: 4,
    parts: [{ partNumber: 1, etag: '"etag"' }],
    phase: "cleanup_pending",
    sourcePath: "note.md",
    localPath: current.path,
    sourceMtime: 100,
    createdAt: 1,
    updatedAt: 1,
  };
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: { task: pending } };
  let deleted = false;
  const interceptor = new AttachmentInterceptor({
    app: {
      vault: {
        getAbstractFileByPath: () => current,
        delete: async () => { deleted = true; },
      },
      metadataCache: { resolvedLinks: {} },
    },
  } as never, {
    getPending: () => pending,
    ensurePendingStorageIdentity: async () => undefined,
    finalizeCleanupForPath: async () => undefined,
  } as never, settings);
  setTimeout(() => {
    current = Object.assign(new TFile("attachments/image.png", "image.png"), {
      stat: { size: 4, mtime: 200 },
    });
  }, 200);

  const entry = {
    tempId: pending.tempId,
    mdPath: pending.sourcePath,
    localPath: pending.localPath!,
    ext: pending.ext,
  };
  const result = await interceptor.retryEntries([entry]);

  assert.equal(deleted, false);
  assert.deepEqual(result.succeeded, []);
  assert.deepEqual(result.failed, [entry]);
});

test("retryAll reports a legacy journal with no recoverable local path as failed", async () => {
  const pending: PendingUpload = {
    tempId: "legacy",
    objectKey: "vault/a.png",
    uploadId: "upload-1",
    ext: "png",
    size: 4,
    parts: [],
    phase: "uploaded",
    sourcePath: "note.md",
    createdAt: 1,
    updatedAt: 1,
  };
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: { legacy: pending } };
  const interceptor = new AttachmentInterceptor({
    app: {
      vault: { getAbstractFileByPath: () => null },
      metadataCache: { resolvedLinks: {} },
    },
  } as never, {
    getPending: () => pending,
  } as never, settings);

  const retry = await interceptor.retryAll();

  assert.equal(retry.succeeded.length, 0);
  assert.equal(retry.failed.length, 1);
  assert.equal(retry.failed[0].tempId, "legacy");
});

test("cold-start retry uses the persisted local attachment locator after placeholder recovery", async () => {
  const local = Object.assign(new TFile("attachments/image.png", "image.png"), {
    stat: { size: 4, mtime: 100 },
  });
  const note = new TFile("note.md", "note.md");
  let markdown = "![[attachments/image.png]]";
  let deleted = false;
  const pending: PendingUpload = {
    tempId: "task",
    objectKey: "vault/a.png",
    uploadId: "upload-1",
    ext: "png",
    size: 4,
    parts: [{ partNumber: 1, etag: '"etag"' }],
    phase: "uploaded",
    sourcePath: note.path,
    occurrenceId: "direct-task",
    localPath: local.path,
    stagingPath: ".oss-plugin-staging/task.png.stage",
    displayName: "image.png",
    sourceMtime: 100,
    locator: {
      kind: "attachment",
      sourcePath: note.path,
      original: markdown,
      start: 0,
      end: markdown.length,
      alt: "image.png",
      before: "",
      after: "",
    },
    createdAt: 1,
    updatedAt: 1,
  };
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: { task: pending } };
  const vault = {
    getAbstractFileByPath: (path: string) => path === local.path ? local : path === note.path ? note : null,
    readBinary: async () => new TextEncoder().encode("data").buffer,
    cachedRead: async () => markdown,
    process: async (_file: TFile, fn: (content: string) => string) => {
      markdown = fn(markdown);
      return markdown;
    },
    delete: async (file: TFile) => { if (file.path === local.path) deleted = true; },
  };
  const manager = {
    getPending: () => pending,
    ensurePendingStorageIdentity: async () => undefined,
    upload: async () => ({ tempId: pending.tempId, objectKey: pending.objectKey }),
    markReferenceCommitting: async () => { pending.phase = "reference_committing"; },
    markCleanupPending: async () => { pending.phase = "cleanup_pending"; },
    finalizeCleanupForPath: async () => { delete settings.pendingUploads.task; },
  };
  const interceptor = new AttachmentInterceptor({
    app: {
      vault,
      metadataCache: {
        resolvedLinks: { [note.path]: { [local.path]: 1 } },
        getFirstLinkpathDest: () => local,
      },
    },
  } as never, manager as never, settings);

  const result = await interceptor.retryEntries([{
    tempId: pending.tempId,
    mdPath: note.path,
    localPath: local.path,
    ext: pending.ext,
    occurrenceId: pending.occurrenceId,
  }]);

  assert.equal(result.failed.length, 0);
  assert.equal(deleted, true);
  assert.equal(markdown, `![image.png](https://${HOST}/vault/a.png)`);
});

async function runDurabilityFailure(
  failAt: "staging" | "journal" | "none",
  quiesceOnFailure = false,
  deferCapture = false,
  hiddenStagingExists = false,
): Promise<{
  prevented: boolean;
  uploadCalls: number;
  localBytes: string;
  markdown: string;
  stagingExists: boolean;
  order: string[];
  editorValue: string;
  lifecycleStopped: boolean;
}> {
  const lifecycle = quiesceOnFailure || deferCapture
    ? await PluginLifecycle.activate(`interceptor-durability-${crypto.randomUUID()}`)
    : undefined;
  let resolveCapture: ((value: ArrayBuffer) => void) | undefined;
  let readStarted = false;
  const deferredBytes = new Promise<ArrayBuffer>((resolve) => { resolveCapture = resolve; });
  const order: string[] = [];
  const files = new Map<string, TFile | TFolder>();
  const bytes = new Map<string, ArrayBuffer>();
  const source = new TFile("note.md", "note.md");
  files.set(source.path, source);
  let markdown = "";
  let editorValue = "";
  let prevented = false;
  let uploadCalls = 0;
  const targetPath = "attachments/clipboard.png";
  const plugin = {
    app: {
      vault: {
        adapter: {
          exists: async (path: string) => path === ".oss-plugin-staging"
            ? hiddenStagingExists || files.has(path)
            : files.has(path),
          stat: async (path: string) => {
            if (path === ".oss-plugin-staging" && hiddenStagingExists) {
              return { type: "folder", size: 0, ctime: 0, mtime: 0 };
            }
            const file = files.get(path);
            if (!file) return null;
            if (file instanceof TFolder) return { type: "folder", size: 0, ctime: 0, mtime: 0 };
            return { type: "file", size: file.stat.size, ctime: 0, mtime: file.stat.mtime };
          },
          mkdir: async (path: string) => { files.set(path, new TFolder(path)); },
          writeBinary: async (path: string, value: ArrayBuffer) => {
            order.push("stage");
            if (failAt === "staging") {
              lifecycle?.quiesce();
              throw new Error("staging unavailable");
            }
            const file = Object.assign(new TFile(path), { stat: { size: value.byteLength, mtime: 1 } });
            files.set(path, file);
            bytes.set(path, value);
          },
          remove: async (path: string) => { files.delete(path); bytes.delete(path); },
        },
        getAbstractFileByPath: (path: string) => files.get(path) ?? null,
        createFolder: async (path: string) => { files.set(path, new TFolder(path)); },
        createBinary: async (path: string, value: ArrayBuffer) => {
          const file = Object.assign(new TFile(path), { stat: { size: value.byteLength, mtime: 1 } });
          files.set(path, file);
          bytes.set(path, value);
          return file;
        },
        delete: async (file: TFile) => { files.delete(file.path); bytes.delete(file.path); },
        read: async () => markdown,
        cachedRead: async () => markdown,
        process: async (_file: TFile, fn: (content: string) => string) => {
          markdown = fn(markdown);
          return markdown;
        },
      },
      fileManager: {
        getAvailablePathForAttachment: async () => targetPath,
        generateMarkdownLink: () => `[[${targetPath}]]`,
      },
      metadataCache: { resolvedLinks: {} },
    },
  };
  const manager = {
    prepareStagedTask: async () => {
      order.push("journal");
      if (failAt === "journal") throw new Error("persist failed");
    },
    getPending: () => undefined,
    upload: async () => { uploadCalls++; throw new Error("network must not start"); },
  };
  const editor = {
    getCursor: () => ({ line: 0, ch: editorValue.length }),
    posToOffset: (position: { ch: number }) => position.ch,
    offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
    getValue: () => editorValue,
    replaceRange: (replacement: string, from: { ch: number }, to?: { ch: number }) => {
      editorValue = editorValue.slice(0, from.ch) + replacement + editorValue.slice(to?.ch ?? from.ch);
    },
  };
  const view = new MarkdownView();
  view.file = source;
  (view as MarkdownView & { save: () => Promise<void> }).save = async () => { markdown = editorValue; };
  const input = {
    name: "clipboard.png",
    type: "image/png",
    size: 14,
    arrayBuffer: async () => {
      readStarted = true;
      return deferCapture
        ? deferredBytes
        : new TextEncoder().encode("captured bytes").buffer;
    },
  } as File;
  const interceptor = new AttachmentInterceptor(
    plugin as never,
    manager as never,
    { ...DEFAULT_SETTINGS, autoUpload: true },
    undefined,
    undefined,
    lifecycle,
  );

  const takeOver = () => (interceptor as unknown as {
    takeOverInput: (
      files: File[],
      event: { preventDefault: () => void },
      editor: unknown,
      view: MarkdownView,
    ) => Promise<void>;
  }).takeOverInput([input], { preventDefault: () => { prevented = true; } }, editor, view);
  let lifecycleStopped = false;
  if (lifecycle) {
    const work = lifecycle.run(takeOver);
    if (deferCapture) {
      assert.equal(readStarted, true);
      lifecycle.quiesce();
      resolveCapture!(new TextEncoder().encode("captured bytes").buffer);
    }
    await assert.rejects(work, LifecycleQuiescedError);
    lifecycleStopped = true;
    await lifecycle.drain();
  } else {
    await takeOver();
  }

  return {
    prevented,
    uploadCalls,
    localBytes: new TextDecoder().decode(bytes.get(targetPath)),
    markdown,
    stagingExists: [...files.keys()].some((path) => path.startsWith(".oss-plugin-staging/")),
    order,
    editorValue,
    lifecycleStopped,
  };
}
