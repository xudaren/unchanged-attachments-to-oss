import assert from "node:assert/strict";
import test from "node:test";
import { OssError } from "../../src/oss/errors";
import { OssClient } from "../../src/oss/client";
import { LifecycleQuiescedError, PluginLifecycle } from "../../src/lifecycle";
import {
  LegacyStorageIdentityError,
  StorageIdentityMismatchError,
  UploadManager,
  UploadPausedError,
  UploadSourceChangedError,
} from "../../src/upload/manager";
import { DEFAULT_SETTINGS } from "../../src/types";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("keeps multipart state for recoverable server errors", async () => {
  let aborted = false;
  const client = {
    initiateMultipart: async () => ({ uploadId: "upload-1" }),
    uploadPart: async () => { throw new OssError(503, "", "PUT", "key"); },
    abortMultipart: async () => { aborted = true; },
  };
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault" };
  const manager = new UploadManager(client as never, settings, async () => undefined);

  await assert.rejects(
    manager.upload({ blob: new Blob(["data"]), ext: "png", sourcePath: "note.md", localPath: "image.png" }),
    UploadPausedError,
  );
  assert.equal(aborted, false);
  assert.equal(Object.keys(settings.pendingUploads).length, 1);
});

test("aborts and clears multipart state for non-recoverable errors", async () => {
  let aborted = false;
  const client = {
    initiateMultipart: async () => ({ uploadId: "upload-1" }),
    uploadPart: async () => { throw new OssError(403, "", "PUT", "key"); },
    abortMultipart: async () => { aborted = true; },
  };
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault" };
  const manager = new UploadManager(client as never, settings, async () => undefined);

  await assert.rejects(
    manager.upload({ blob: new Blob(["data"]), ext: "png", sourcePath: "note.md", localPath: "image.png" }),
    OssError,
  );
  assert.equal(aborted, true);
  assert.equal(Object.keys(settings.pendingUploads).length, 0);
});

test("keeps completed object state until reference commit is finalized", async () => {
  let initiateCount = 0;
  const client = {
    initiateMultipart: async () => { initiateCount++; return { uploadId: "upload-1" }; },
    uploadPart: async () => ({ etag: '"etag-1"' }),
    completeMultipart: async ({ key }: { key: string }) => ({ key, etag: '"done"', requestId: "request-1" }),
  };
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault" };
  const manager = new UploadManager(client as never, settings, async () => undefined);

  const first = await manager.upload({
    blob: new Blob(["data"]), ext: "png", sourcePath: "note.md", localPath: "image.png", sourceMtime: 100,
  });
  assert.equal(settings.pendingUploads[first.tempId]?.phase, "uploaded");

  const resumed = await manager.upload({
    blob: new Blob(["data"]), ext: "png", sourcePath: "note.md", localPath: "image.png", sourceMtime: 100,
  });
  assert.equal(resumed.objectKey, first.objectKey);
  assert.equal(initiateCount, 1);

  await manager.finalize(first.tempId);
  assert.equal(Object.keys(settings.pendingUploads).length, 0);
});

test("does not reuse multipart state across two occurrences of the same local attachment", async () => {
  let initiateCount = 0;
  const client = {
    initiateMultipart: async () => ({ uploadId: `upload-${++initiateCount}` }),
    uploadPart: async () => ({ etag: '"etag-1"' }),
    completeMultipart: async ({ key }: { key: string }) => ({ key, etag: '"done"', requestId: "request-1" }),
  };
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault" };
  const manager = new UploadManager(client as never, settings, async () => undefined);
  const shared = { blob: new Blob(["data"]), ext: "png", sourcePath: "note.md", localPath: "image.png" };

  const first = await manager.upload({ ...shared, occurrenceId: "note.md#0" });
  const second = await manager.upload({ ...shared, occurrenceId: "note.md#1" });

  assert.notEqual(first.objectKey, second.objectKey);
  assert.equal(initiateCount, 2);
});

test("journals a staged task before any network request", async () => {
  const order: string[] = [];
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault" };
  const client = {
    initiateMultipart: async () => {
      assert.equal(Object.values(settings.pendingUploads)[0]?.phase, "staged");
      order.push("network");
      return { uploadId: "upload-1" };
    },
    uploadPart: async () => ({ etag: '"etag-1"' }),
    completeMultipart: async ({ key }: { key: string }) => ({ key, etag: '"done"', requestId: "request-1" }),
  };
  const manager = new UploadManager(client as never, settings, async () => { order.push("persist"); });
  const locator = {
    kind: "placeholder" as const,
    sourcePath: "note.md",
    original: "![](oss://uploading/task-1)",
    start: 0,
    end: 28,
    alt: "image.png",
    before: "",
    after: "",
  };

  await manager.prepareStagedTask({
    tempId: "task-1",
    ext: "png",
    size: 4,
    sourcePath: "note.md",
    localPath: ".oss-plugin-staging/task-1.png.stage",
    stagingPath: ".oss-plugin-staging/task-1.png.stage",
    displayName: "image.png",
    occurrenceId: "task-1",
    locator,
    sourceMtime: 100,
  });
  await manager.upload({
    blob: new Blob(["data"]),
    ext: "png",
    sourcePath: "note.md",
    localPath: ".oss-plugin-staging/task-1.png.stage",
    tempId: "task-1",
    occurrenceId: "task-1",
    locator,
    sourceMtime: 100,
  });

  assert.equal(order[0], "persist");
  assert.ok(order.indexOf("network") > order.indexOf("persist"));
});

test("recovers an ambiguous CompleteMultipartUpload with HEAD instead of orphaning the object", async () => {
  let aborted = false;
  const client = {
    initiateMultipart: async () => ({ uploadId: "upload-1" }),
    uploadPart: async () => ({ etag: '"etag-1"' }),
    completeMultipart: async () => {
      throw new OssError(404, "<Error><Code>NoSuchUpload</Code></Error>", "POST", "vault/a.png");
    },
    headObject: async () => true,
    abortMultipart: async () => { aborted = true; },
  };
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault" };
  const manager = new UploadManager(client as never, settings, async () => undefined);

  const result = await manager.upload({ blob: new Blob(["data"]), ext: "png", sourcePath: "note.md" });

  assert.equal(settings.pendingUploads[result.tempId]?.phase, "uploaded");
  assert.equal(aborted, false);
});

test("preserves a completing journal when both Complete and HEAD are uncertain", async () => {
  let aborted = false;
  const client = {
    initiateMultipart: async () => ({ uploadId: "upload-1" }),
    uploadPart: async () => ({ etag: '"etag-1"' }),
    completeMultipart: async () => {
      throw new OssError(404, "<Error><Code>NoSuchUpload</Code></Error>", "POST", "vault/a.png");
    },
    headObject: async () => {
      throw new OssError(503, "", "HEAD", "vault/a.png");
    },
    abortMultipart: async () => { aborted = true; },
  };
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault" };
  const manager = new UploadManager(client as never, settings, async () => undefined);

  await assert.rejects(
    manager.upload({ blob: new Blob(["data"]), ext: "png", sourcePath: "note.md" }),
    UploadPausedError,
  );

  assert.equal(aborted, false);
  assert.equal(Object.values(settings.pendingUploads)[0]?.phase, "completing");
});

test("does not trust a 200 Complete response without RequestId and matching Key", async () => {
  let headCount = 0;
  const client = {
    initiateMultipart: async () => ({ uploadId: "upload-1" }),
    uploadPart: async () => ({ etag: '"etag-1"' }),
    completeMultipart: async () => ({ key: null, etag: null, requestId: null }),
    headObject: async () => { headCount++; return true; },
  };
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault" };
  const manager = new UploadManager(client as never, settings, async () => undefined);

  const result = await manager.upload({ blob: new Blob(["data"]), ext: "png", sourcePath: "note.md" });

  assert.equal(headCount, 1);
  assert.equal(settings.pendingUploads[result.tempId]?.phase, "uploaded");
});

test("keeps the journal when AbortMultipartUpload fails", async () => {
  const client = {
    initiateMultipart: async () => ({ uploadId: "upload-1" }),
    uploadPart: async () => { throw new OssError(403, "", "PUT", "vault/a.png"); },
    abortMultipart: async () => { throw new OssError(503, "", "DELETE", "vault/a.png"); },
  };
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault" };
  const manager = new UploadManager(client as never, settings, async () => undefined);

  await assert.rejects(
    manager.upload({ blob: new Blob(["data"]), ext: "png", sourcePath: "note.md" }),
    OssError,
  );
  assert.equal(Object.keys(settings.pendingUploads).length, 1);
});

test("canonicalizes storage identity and blocks a real target switch before network", async () => {
  let initiateCount = 0;
  const client = {
    initiateMultipart: async () => { initiateCount++; return { uploadId: "upload-1" }; },
    uploadPart: async () => ({ etag: '"etag-1"' }),
    completeMultipart: async ({ key }: { key: string }) => ({ key, etag: '"done"', requestId: "request-1" }),
  };
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault", bucketName: "bucket-one" };
  const manager = new UploadManager(client as never, settings, async () => undefined);
  const first = await manager.upload({ blob: new Blob(["data"]), ext: "png", sourcePath: "note.md", localPath: "a.png", sourceMtime: 100 });
  await manager.markCleanupPending(first.tempId);

  settings.region = "cn-hangzhou";
  settings.endpoint = "oss-cn-hangzhou.aliyuncs.com";
  await manager.upload({ blob: new Blob(["data"]), ext: "png", sourcePath: "note.md", localPath: "a.png", sourceMtime: 100 });
  assert.equal(initiateCount, 1, "legacy and canonical region/endpoint forms are one identity");

  settings.bucketName = "bucket-two";
  await assert.rejects(
    manager.upload({ blob: new Blob(["data"]), ext: "png", sourcePath: "note.md", localPath: "a.png", sourceMtime: 100 }),
    StorageIdentityMismatchError,
  );
  assert.equal(initiateCount, 1);
});

test("reports prefix-scoped unknown remote uploads without aborting them", async () => {
  let listedPrefix = "";
  let abortCount = 0;
  const client = {
    listMultipartUploads: async (prefix: string) => {
      listedPrefix = prefix;
      return [{ key: "vault/other.bin", uploadId: "external", initiated: "2020-01-01T00:00:00Z" }];
    },
    abortMultipart: async () => { abortCount++; },
  };
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault" };
  const manager = new UploadManager(client as never, settings, async () => undefined);

  assert.equal(await manager.cleanupOrphans(), 0);
  assert.equal(listedPrefix, "vault/");
  assert.equal(abortCount, 0);
});

test("manual orphan cleanup recovers a completing task whose object already exists", async () => {
  let abortCount = 0;
  const old = Date.now() - 25 * 3600 * 1000;
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault" };
  const manager = new UploadManager({
    headObject: async () => true,
    abortMultipart: async () => { abortCount++; },
    listMultipartUploads: async () => [],
  } as never, settings, async () => undefined);
  settings.pendingUploads.task = {
    tempId: "task",
    objectKey: "vault/a.png",
    uploadId: "upload-1",
    ext: "png",
    size: 4,
    parts: [{ partNumber: 1, etag: '"etag"' }],
    phase: "completing",
    sourcePath: "note.md",
    storageIdentity: {
      region: "cn-hangzhou",
      bucketName: "",
      endpoint: "oss-cn-hangzhou.aliyuncs.com",
      objectKeyPrefix: "vault",
    },
    createdAt: old,
    updatedAt: old,
  };

  assert.equal(await manager.cleanupOrphans(), 0);
  assert.equal(abortCount, 0);
  assert.equal(settings.pendingUploads.task.phase, "uploaded");
});

test("manual orphan cleanup resets uploaded parts but preserves the recoverable task", async () => {
  let abortCount = 0;
  const old = Date.now() - 25 * 3600 * 1000;
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault" };
  const manager = new UploadManager({
    abortMultipart: async () => { abortCount++; },
    listMultipartUploads: async () => [],
  } as never, settings, async () => undefined);
  settings.pendingUploads.task = {
    tempId: "task",
    objectKey: "vault/a.png",
    uploadId: "upload-1",
    ext: "png",
    size: 4,
    parts: [{ partNumber: 1, etag: '"etag"' }],
    phase: "uploading",
    sourcePath: "note.md",
    storageIdentity: {
      region: "cn-hangzhou",
      bucketName: "",
      endpoint: "oss-cn-hangzhou.aliyuncs.com",
      objectKeyPrefix: "vault",
    },
    createdAt: old,
    updatedAt: old,
  };

  assert.equal(await manager.cleanupOrphans(), 1);
  assert.equal(abortCount, 1);
  assert.equal(settings.pendingUploads.task.phase, "staged");
  assert.equal(settings.pendingUploads.task.uploadId, "");
  assert.deepEqual(settings.pendingUploads.task.parts, []);
});

test("does not adopt an identity-less legacy uploaded task unless HEAD confirms the current Bucket", async () => {
  let initiateCount = 0;
  let headCount = 0;
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault" };
  const manager = new UploadManager({
    headObject: async () => { headCount++; return false; },
    initiateMultipart: async () => { initiateCount++; return { uploadId: "new" }; },
  } as never, settings, async () => undefined);
  settings.pendingUploads.legacy = {
    tempId: "legacy",
    objectKey: "vault/old.png",
    uploadId: "old-upload",
    ext: "png",
    size: 4,
    parts: [],
    phase: "uploaded",
    sourcePath: "note.md",
    localPath: "image.png",
    createdAt: 1,
    updatedAt: 1,
  };

  await assert.rejects(
    manager.upload({
      blob: new Blob(["data"]),
      ext: "png",
      sourcePath: "note.md",
      localPath: "image.png",
      tempId: "legacy",
    }),
    LegacyStorageIdentityError,
  );

  assert.equal(headCount, 1);
  assert.equal(initiateCount, 0);
  assert.equal(settings.pendingUploads.legacy.storageIdentity, undefined);
});

test("never probes or adopts an identity-less legacy uploading task", async () => {
  let networkCount = 0;
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault" };
  const manager = new UploadManager({
    headObject: async () => { networkCount++; return true; },
    uploadPart: async () => { networkCount++; return { etag: '"etag"' }; },
  } as never, settings, async () => undefined);
  settings.pendingUploads.legacy = {
    tempId: "legacy",
    objectKey: "vault/old.png",
    uploadId: "old-upload",
    ext: "png",
    size: 4,
    parts: [],
    phase: "uploading",
    sourcePath: "note.md",
    localPath: "image.png",
    createdAt: 1,
    updatedAt: 1,
  };

  await assert.rejects(
    manager.upload({
      blob: new Blob(["data"]),
      ext: "png",
      sourcePath: "note.md",
      localPath: "image.png",
      tempId: "legacy",
    }),
    LegacyStorageIdentityError,
  );
  assert.equal(networkCount, 0);
});

test("automatic upload pauses before Initiate while manual retry still works", async () => {
  let initiateCount = 0;
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault", autoUpload: false };
  const client = {
    initiateMultipart: async () => ({ uploadId: `upload-${++initiateCount}` }),
    uploadPart: async () => ({ etag: '"etag"' }),
    completeMultipart: async ({ key }: { key: string }) => ({ key, etag: '"done"', requestId: "request-1" }),
  };
  const manager = new UploadManager(client as never, settings, async () => undefined);

  await assert.rejects(
    manager.upload({ blob: new Blob(["data"]), ext: "png", sourcePath: "note.md", automatic: true, sourceMtime: 100 }),
    UploadPausedError,
  );
  const paused = Object.values(settings.pendingUploads)[0];
  assert.equal(initiateCount, 0);
  assert.equal(paused.phase, "staged");

  const result = await manager.upload({
    blob: new Blob(["data"]),
    ext: "png",
    sourcePath: "note.md",
    tempId: paused.tempId,
    sourceMtime: 100,
  });
  assert.equal(initiateCount, 1);
  assert.equal(settings.pendingUploads[result.tempId].phase, "uploaded");
});

test("automatic upload stops before Complete and preserves uploaded parts", async () => {
  let completeCount = 0;
  let headCount = 0;
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault", autoUpload: true };
  const manager = new UploadManager({
    initiateMultipart: async () => ({ uploadId: "upload-1" }),
    uploadPart: async () => {
      settings.autoUpload = false;
      return { etag: '"etag"' };
    },
    completeMultipart: async () => { completeCount++; return { key: null, etag: null, requestId: null }; },
    headObject: async () => { headCount++; return true; },
  } as never, settings, async () => undefined);

  await assert.rejects(
    manager.upload({ blob: new Blob(["data"]), ext: "png", sourcePath: "note.md", automatic: true }),
    UploadPausedError,
  );

  const paused = Object.values(settings.pendingUploads)[0];
  assert.equal(completeCount, 0);
  assert.equal(headCount, 0);
  assert.equal(paused.phase, "completing");
  assert.equal(paused.uploadId, "upload-1");
  assert.equal(paused.parts.length, 1);
});

test("in-flight Complete may persist uploaded state while next generation waits for the save tail", async () => {
  const pluginId = `manager-complete-${crypto.randomUUID()}`;
  const lifecycle = await PluginLifecycle.activate(pluginId);
  const completeSent = deferred<void>();
  const completeResponse = deferred<{ key: string; etag: string; requestId: string }>();
  const releaseUploadedSave = deferred<void>();
  let uploadedSaveStarted = false;
  const settings = {
    ...DEFAULT_SETTINGS,
    bucketName: "bucket-one",
    accessKeyId: "ak",
    accessKeySecret: "sk",
    objectKeyPrefix: "vault",
    pendingUploads: {},
  };
  const pending = {
    tempId: "task",
    objectKey: "vault/a.png",
    uploadId: "upload-1",
    ext: "png",
    size: 4,
    parts: [{ partNumber: 1, etag: '"etag"' }],
    phase: "completing" as const,
    sourcePath: "note.md",
    sourceMtime: 100,
    storageIdentity: {
      region: "cn-hangzhou",
      bucketName: "bucket-one",
      endpoint: "oss-cn-hangzhou.aliyuncs.com",
      objectKeyPrefix: "vault",
    },
    createdAt: 1,
    updatedAt: 1,
  };
  settings.pendingUploads = { task: pending };
  const manager = new UploadManager({
    completeMultipart: async () => {
      completeSent.resolve();
      return completeResponse.promise;
    },
  } as never, settings, async () => lifecycle.enqueuePersistence(async () => {
    if (pending.phase === "uploaded") {
      uploadedSaveStarted = true;
      await releaseUploadedSave.promise;
    }
  }), lifecycle);

  const work = lifecycle.run(() => manager.upload({
    blob: new Blob(["data"]),
    ext: "png",
    sourcePath: "note.md",
    resume: pending,
    sourceMtime: 100,
  }));
  await completeSent.promise;
  lifecycle.quiesce();
  let nextActivated = false;
  const nextPromise = PluginLifecycle.activate(pluginId).then((next) => {
    nextActivated = true;
    return next;
  });
  completeResponse.resolve({ key: pending.objectKey, etag: '"done"', requestId: "request-1" });
  for (let attempt = 0; attempt < 20 && !uploadedSaveStarted; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(uploadedSaveStarted, true);
  assert.equal(nextActivated, false);
  // The manager root itself must still be waiting on the durable uploaded save.
  let workSettled = false;
  void work.then(() => { workSettled = true; });
  await Promise.resolve();
  assert.equal(workSettled, false);
  releaseUploadedSave.resolve();
  await work;
  await nextPromise;
  assert.equal(pending.phase, "uploaded");
  assert.equal(nextActivated, true);
});

test("quiesce before Complete send preserves completing state without request or retry delay", async () => {
  const lifecycle = await PluginLifecycle.activate(`manager-before-complete-${crypto.randomUUID()}`);
  const settings = {
    ...DEFAULT_SETTINGS,
    bucketName: "bucket-one",
    accessKeyId: "ak",
    accessKeySecret: "sk",
    objectKeyPrefix: "vault",
    pendingUploads: {},
  };
  const pending = {
    tempId: "task",
    objectKey: "vault/a.png",
    uploadId: "upload-1",
    ext: "png",
    size: 4,
    parts: [{ partNumber: 1, etag: '"etag"' }],
    phase: "completing" as const,
    sourcePath: "note.md",
    sourceMtime: 100,
    storageIdentity: {
      region: "cn-hangzhou",
      bucketName: "bucket-one",
      endpoint: "oss-cn-hangzhou.aliyuncs.com",
      objectKeyPrefix: "vault",
    },
    createdAt: 1,
    updatedAt: 1,
  };
  settings.pendingUploads = { task: pending };
  let sends = 0;
  const client = new OssClient(
    settings,
    (async () => {
      sends++;
      return { status: 200, text: "", headers: {}, arrayBuffer: new ArrayBuffer(0), json: {} };
    }) as never,
    () => new Date("2026-08-10T00:00:00Z"),
    () => lifecycle.assertActive("发送 OSS 请求"),
  );
  const manager = new UploadManager(
    client,
    settings,
    async () => lifecycle.enqueuePersistence(async () => undefined),
    lifecycle,
  );

  const startedAt = Date.now();
  const work = lifecycle.run(() => manager.upload({
    blob: new Blob(["data"]),
    ext: "png",
    sourcePath: "note.md",
    resume: pending,
    sourceMtime: 100,
  }));
  lifecycle.quiesce();
  await assert.rejects(work, (error: unknown) =>
    error instanceof UploadPausedError && error.reason instanceof LifecycleQuiescedError
  );
  assert.equal(sends, 0);
  assert.equal(pending.phase, "completing");
  assert.ok(Date.now() - startedAt < 500, "lifecycle pause must not enter retry backoff");
  await lifecycle.drain();
});

test("rejects a legacy leading-slash prefix before any OSS request", async () => {
  let networkCount = 0;
  const client = {
    initiateMultipart: async () => { networkCount++; return { uploadId: "upload-1" }; },
    uploadPart: async () => { networkCount++; return { etag: '"etag"' }; },
    completeMultipart: async () => { networkCount++; return { key: null, etag: null, requestId: null }; },
  };
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "/foo" };
  const manager = new UploadManager(client as never, settings, async () => undefined);

  await assert.rejects(
    manager.upload({ blob: new Blob(["data"]), ext: "png", sourcePath: "note.md" }),
    /不能以 \/ 开头/,
  );

  assert.equal(networkCount, 0);
  assert.equal(Object.keys(settings.pendingUploads).length, 0);
});

test("serializes concurrent upload() calls that resume the same pending task", async () => {
  let initiateCount = 0;
  const firstInitiateBlocked = deferred();
  const client = {
    initiateMultipart: async () => {
      initiateCount++;
      if (initiateCount === 1) await firstInitiateBlocked.promise;
      return { uploadId: `upload-${initiateCount}` };
    },
    uploadPart: async () => ({ etag: '"etag-1"' }),
    completeMultipart: async ({ key }: { key: string }) => ({ key, etag: '"done"', requestId: "r-1" }),
  };
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault" };
  const manager = new UploadManager(client as never, settings, async () => undefined);
  const shared = {
    blob: new Blob(["data"]),
    ext: "png",
    sourcePath: "note.md",
    localPath: "image.png",
    occurrenceId: "note.md#0",
  };

  const first = manager.upload(shared);
  // Let the first caller reach the blocked initiateMultipart before the second enters.
  await new Promise((r) => setTimeout(r, 0));
  const second = manager.upload(shared);
  firstInitiateBlocked.resolve();

  const [ra, rb] = await Promise.all([first, second]);
  assert.equal(initiateCount, 1, "initiateMultipart must run exactly once for the same pending task");
  assert.equal(ra.objectKey, rb.objectKey);
  assert.equal(ra.tempId, rb.tempId);
  const pending = settings.pendingUploads[ra.tempId];
  assert.equal(pending.parts.length, 1, "only one upload should have contributed parts");
});

test("rejects resume when the pending journal has no source mtime", async () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    bucketName: "bucket",
    objectKeyPrefix: "vault",
    pendingUploads: {},
  };
  const pending = {
    tempId: "task",
    objectKey: "vault/a.png",
    uploadId: "upload-1",
    ext: "png",
    size: 4,
    parts: [{ partNumber: 1, etag: '"etag-1"' }],
    phase: "uploading" as const,
    sourcePath: "note.md",
    localPath: "image.png",
    storageIdentity: {
      region: "cn-hangzhou",
      bucketName: "bucket",
      endpoint: "oss-cn-hangzhou.aliyuncs.com",
      objectKeyPrefix: "vault",
    },
    createdAt: 1,
    updatedAt: 1,
    // sourceMtime intentionally absent (legacy journal)
  };
  settings.pendingUploads = { task: pending };
  const manager = new UploadManager({} as never, settings, async () => undefined);

  await assert.rejects(
    manager.upload({
      blob: new Blob(["data"]),
      ext: "png",
      sourcePath: "note.md",
      resume: pending,
      sourceMtime: 100,
    }),
    UploadSourceChangedError,
  );
});

test("rejects resume when the incoming request omits source mtime", async () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    bucketName: "bucket",
    objectKeyPrefix: "vault",
    pendingUploads: {},
  };
  const pending = {
    tempId: "task",
    objectKey: "vault/a.png",
    uploadId: "upload-1",
    ext: "png",
    size: 4,
    parts: [{ partNumber: 1, etag: '"etag-1"' }],
    phase: "uploading" as const,
    sourcePath: "note.md",
    localPath: "image.png",
    sourceMtime: 100,
    storageIdentity: {
      region: "cn-hangzhou",
      bucketName: "bucket",
      endpoint: "oss-cn-hangzhou.aliyuncs.com",
      objectKeyPrefix: "vault",
    },
    createdAt: 1,
    updatedAt: 1,
  };
  settings.pendingUploads = { task: pending };
  const manager = new UploadManager({} as never, settings, async () => undefined);

  await assert.rejects(
    manager.upload({
      blob: new Blob(["data"]),
      ext: "png",
      sourcePath: "note.md",
      resume: pending,
      // sourceMtime intentionally omitted
    }),
    UploadSourceChangedError,
  );
});

test("bindLocalRecovery retries a transient persist failure so the journal stays aligned with the md reference", async () => {
  let persistCalls = 0;
  const settings = {
    ...DEFAULT_SETTINGS,
    bucketName: "bucket",
    objectKeyPrefix: "vault",
    pendingUploads: {},
  };
  const pending = {
    tempId: "task",
    objectKey: "vault/a.png",
    uploadId: "upload-1",
    ext: "png",
    size: 4,
    parts: [{ partNumber: 1, etag: '"etag-1"' }],
    phase: "uploading" as const,
    sourcePath: "note.md",
    storageIdentity: {
      region: "cn-hangzhou",
      bucketName: "bucket",
      endpoint: "oss-cn-hangzhou.aliyuncs.com",
      objectKeyPrefix: "vault",
    },
    sourceMtime: 100,
    createdAt: 1,
    updatedAt: 1,
  };
  settings.pendingUploads = { task: pending };
  const manager = new UploadManager({} as never, settings, async () => {
    persistCalls++;
    if (persistCalls === 1) throw new Error("disk full");
  });
  const locator = {
    kind: "attachment" as const,
    sourcePath: "note.md",
    original: "![a](image.png)",
    start: 0,
    end: 15,
    alt: "a",
    before: "",
    after: "",
  };

  await manager.bindLocalRecovery("task", "image.png", locator, 200);

  assert.equal(persistCalls, 2, "bindLocalRecovery must retry a transient persist failure");
  assert.equal(pending.localPath, "image.png");
  assert.equal(pending.sourceMtime, 200);
  assert.equal(pending.locator, locator);
});
