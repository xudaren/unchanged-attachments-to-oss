import assert from "node:assert/strict";
import test from "node:test";
import { extractReferenceKeys, isProtectedByAge, reconcileObjects } from "../../src/audit/reconcile";
import type { PendingUpload } from "../../src/types";

test("extracts unique decoded object keys from repeated references", () => {
  const keys = extractReferenceKeys([
    "![](oss://vault/a.pdf)",
    "![again](oss://vault/a.pdf)",
    "![](oss:///vault/%E6%8A%A5%E5%91%8A.pdf)",
  ].join("\n"));

  assert.deepEqual([...keys], ["vault/a.pdf", "vault/报告.pdf"]);
});

test("reconciles orphaned, missing, pending and internal objects by key", () => {
  const referenced = new Map<string, string[]>([
    ["vault/healthy.pdf", ["note.md"]],
    ["vault/missing.pdf", ["other.md"]],
  ]);
  const pending: PendingUpload = {
    tempId: "temp", objectKey: "vault/pending.mp4", uploadId: "upload", ext: "mp4", size: 1,
    parts: [], phase: "uploaded", sourcePath: "note.md", createdAt: 1, updatedAt: 1,
  };
  const objects = [
    { key: "vault/healthy.pdf", lastModified: "2026-01-01T00:00:00Z", size: 1 },
    { key: "vault/orphan.pdf", lastModified: "2026-01-01T00:00:00Z", size: 2 },
    { key: "vault/pending.mp4", lastModified: "2026-01-01T00:00:00Z", size: 3 },
    { key: "vault/.oss-plugin-probe/probe", lastModified: "2026-01-01T00:00:00Z", size: 0 },
  ];

  const report = reconcileObjects(referenced, objects, { temp: pending });

  assert.deepEqual(report.healthy.map((object) => object.key), ["vault/healthy.pdf", "vault/pending.mp4"]);
  assert.deepEqual(report.orphaned.map((object) => object.key), ["vault/orphan.pdf"]);
  assert.deepEqual(report.missing, ["vault/missing.pdf"]);
});

test("protects objects newer than 24 hours and unknown timestamps", () => {
  const now = Date.parse("2026-08-07T12:00:00Z");
  assert.equal(isProtectedByAge({ key: "a", size: 1, lastModified: "2026-08-07T00:00:01Z" }, now), true);
  assert.equal(isProtectedByAge({ key: "b", size: 1, lastModified: "2026-08-06T11:59:59Z" }, now), false);
  assert.equal(isProtectedByAge({ key: "c", size: 1, lastModified: "bad" }, now), true);
});
