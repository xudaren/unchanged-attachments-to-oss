import assert from "node:assert/strict";
import test from "node:test";
import { TFile } from "obsidian";
import {
  extractReferenceKeys,
  isProtectedByAge,
  reconcileObjects,
  scanVaultReferences,
  selectFinalDeletionCandidates,
} from "../../src/audit/reconcile";
import type { PendingUpload } from "../../src/types";
import { setOssReferenceHost } from "../../src/reference/codec";

test("extracts unique decoded object keys from repeated references", () => {
  const keys = extractReferenceKeys([
    "![](oss://vault/a.pdf)",
    "![again](oss://vault/a.pdf)",
    "![](oss:///vault/%E6%8A%A5%E5%91%8A.pdf)",
  ].join("\n"));

  assert.deepEqual([...keys], ["vault/a.pdf", "vault/报告.pdf"]);
});

test("ignores uploading placeholders and Markdown examples inside code", () => {
  const content = [
    "![](oss:///uploading/task-id)",
    "```md",
    "![](oss:///vault/fake.png)",
    "```",
    "![](oss:///vault/real.png)",
  ].join("\n");

  assert.deepEqual([...extractReferenceKeys(content)], ["vault/real.png"]);
});

test("extracts keys from both legacy oss:// and public URL references", () => {
  setOssReferenceHost("bucket-a.oss-cn-hangzhou.aliyuncs.com");
  const content = [
    "![](oss://vault/legacy.png)",
    "![](https://bucket-a.oss-cn-hangzhou.aliyuncs.com/vault/public.png)",
    "![](https://bucket-a.oss-cn-hangzhou.aliyuncs.com/vault/public.png)",
    "![](https://other.example.com/vault/foreign.png)",
  ].join("\n");

  assert.deepEqual([...extractReferenceKeys(content)], ["vault/legacy.png", "vault/public.png"]);
});

test("filters extracted references to selected object keys", () => {
  const keys = extractReferenceKeys(
    "![](oss://vault/a.pdf) ![](oss://vault/b.pdf)",
    new Set(["vault/b.pdf"]),
  );
  assert.deepEqual([...keys], ["vault/b.pdf"]);
});

test("scans reference files with bounded concurrency and reports read failures", async () => {
  const files = [
    new TFile("a.md"),
    new TFile("b.canvas"),
    new TFile("c.base"),
    new TFile("broken.md"),
    new TFile("ignored.png"),
  ];
  let active = 0;
  let peak = 0;
  const progress: number[] = [];
  const vault = {
    getFiles: () => files,
    read: async (file: TFile) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      if (file.path === "broken.md") throw new Error("unreadable");
      return `![](oss://vault/${file.extension}.pdf)`;
    },
  };

  const result = await scanVaultReferences(vault as never, {
    concurrency: 2,
    onProgress: ({ scanned }) => progress.push(scanned),
  });

  assert.ok(peak <= 2);
  assert.deepEqual([...result.referenced.keys()].sort(), ["vault/base.pdf", "vault/canvas.pdf", "vault/md.pdf"]);
  assert.deepEqual(result.failedPaths, ["broken.md"]);
  assert.equal(progress.at(-1), 4, "unsupported files are excluded from scan totals");
});

test("scanVaultReferences reads disk directly so a stale MetadataCache cannot hide a live reference", async () => {
  const files = [new TFile("note.md")];
  const vault = {
    getFiles: () => files,
    // cachedRead returns a stale snapshot with no reference.
    cachedRead: async () => "# no reference here",
    // read returns the fresh content with the live oss:// reference.
    read: async () => "![](oss://vault/live.pdf)",
  };

  const result = await scanVaultReferences(vault as never);

  assert.deepEqual([...result.referenced.keys()], ["vault/live.pdf"]);
  assert.deepEqual(result.referenced.get("vault/live.pdf"), ["note.md"]);
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

test("final deletion recheck skips restored references, pending and recently replaced objects", () => {
  const now = Date.parse("2026-08-10T12:00:00Z");
  const pending: PendingUpload = {
    tempId: "task", objectKey: "vault/pending.pdf", uploadId: "upload", ext: "pdf", size: 1,
    parts: [], sourcePath: "note.md", createdAt: 1, updatedAt: 1,
  };
  const result = selectFinalDeletionCandidates(
    ["vault/old.pdf", "vault/restored.pdf", "vault/pending.pdf", "vault/replaced.pdf", "vault/missing.pdf"],
    new Map([["vault/restored.pdf", ["note.md"]]]),
    { task: pending },
    [
      { key: "vault/old.pdf", size: 1, lastModified: "2026-08-01T00:00:00Z" },
      { key: "vault/restored.pdf", size: 1, lastModified: "2026-08-01T00:00:00Z" },
      { key: "vault/pending.pdf", size: 1, lastModified: "2026-08-01T00:00:00Z" },
      { key: "vault/replaced.pdf", size: 1, lastModified: "2026-08-10T11:59:00Z" },
    ],
    now,
  );
  assert.deepEqual(result.deletable, ["vault/old.pdf"]);
  assert.deepEqual(result.skipped, [
    "vault/restored.pdf", "vault/pending.pdf", "vault/replaced.pdf", "vault/missing.pdf",
  ]);
});
