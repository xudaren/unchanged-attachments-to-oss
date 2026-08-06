import assert from "node:assert/strict";
import test from "node:test";
import { OssError } from "../../src/oss/errors";
import { UploadManager, UploadPausedError } from "../../src/upload/manager";
import { DEFAULT_SETTINGS } from "../../src/types";

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
    completeMultipart: async () => undefined,
  };
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault" };
  const manager = new UploadManager(client as never, settings, async () => undefined);

  const first = await manager.upload({
    blob: new Blob(["data"]), ext: "png", sourcePath: "note.md", localPath: "image.png",
  });
  assert.equal(settings.pendingUploads[first.tempId]?.phase, "uploaded");

  const resumed = await manager.upload({
    blob: new Blob(["data"]), ext: "png", sourcePath: "note.md", localPath: "image.png",
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
    completeMultipart: async () => undefined,
  };
  const settings = { ...DEFAULT_SETTINGS, pendingUploads: {}, objectKeyPrefix: "vault" };
  const manager = new UploadManager(client as never, settings, async () => undefined);
  const shared = { blob: new Blob(["data"]), ext: "png", sourcePath: "note.md", localPath: "image.png" };

  const first = await manager.upload({ ...shared, occurrenceId: "note.md#0" });
  const second = await manager.upload({ ...shared, occurrenceId: "note.md#1" });

  assert.notEqual(first.objectKey, second.objectKey);
  assert.equal(initiateCount, 2);
});
