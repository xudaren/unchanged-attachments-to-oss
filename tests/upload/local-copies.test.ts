import assert from "node:assert/strict";
import test from "node:test";
import { TFile, TFolder } from "obsidian";
import {
  isCopyClaimed,
  scanLocalInsuranceCopies,
} from "../../src/upload/local-copies";
import type { PendingUpload } from "../../src/types";

function stagedFile(path: string, size: number, mtime: number): TFile {
  const file = new TFile(path);
  Object.assign(file, { stat: { size, mtime } });
  return file;
}

function pending(overrides: Partial<PendingUpload> = {}): PendingUpload {
  return {
    tempId: "task-1",
    objectKey: "vault/object.png",
    uploadId: "upload-1",
    ext: "png",
    size: 20,
    parts: [],
    phase: "uploading",
    sourcePath: "note.md",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

test("summarizes local insurance copies with plain-language task states", () => {
  const claimedPath = ".oss-plugin-staging/11111111-1111-4111-8111-111111111111.png.stage";
  const unclaimedPath = ".oss-plugin-staging/22222222-2222-4222-8222-222222222222.pdf.stage";
  const folder = new TFolder(".oss-plugin-staging", [
    stagedFile(claimedPath, 20, 100),
    stagedFile(unclaimedPath, 30, 200),
  ]);
  const uploads = {
    task: pending({ stagingPath: claimedPath, displayName: "截图.png" }),
  };
  const vault = {
    getAbstractFileByPath: (path: string) => path === folder.path ? folder : null,
  };

  const report = scanLocalInsuranceCopies(vault as never, uploads);
  assert.equal(report.totalSize, 50);
  assert.equal(report.taskCount, 1);
  assert.equal(report.unclaimedCount, 1);
  assert.equal(report.copies.find((copy) => copy.path === claimedPath)?.name, "截图.png");
  assert.equal(
    report.copies.find((copy) => copy.path === claimedPath)?.taskStatus,
    "上传未完成，可继续重试",
  );
  assert.equal(report.copies.find((copy) => copy.path === unclaimedPath)?.name, "待恢复附件.pdf");
});

test("treats both stagingPath and an internal localPath as protected task copies", () => {
  const stagingPath = ".oss-plugin-staging/staged.png.stage";
  const localPath = ".oss-plugin-staging/local.png.stage";
  const uploads = {
    first: pending({ stagingPath }),
    second: pending({ tempId: "task-2", stagingPath: undefined, localPath }),
  };

  assert.equal(isCopyClaimed(stagingPath, uploads), true);
  assert.equal(isCopyClaimed(localPath, uploads), true);
  assert.equal(isCopyClaimed(".oss-plugin-staging/unclaimed.png.stage", uploads), false);
});
