import assert from "node:assert/strict";
import test from "node:test";
import { TFile } from "obsidian";
import {
  findResolvedAttachmentOccurrences,
  replaceOneResolvedAttachmentReference,
  replaceResolvedAttachmentReferences,
  scanMigrationOccurrences,
} from "../../src/upload/links";

test("folder migration includes attachments referenced by notes in the selected folder", async () => {
  const target = new TFile("shared-assets/image.png", "image.png");
  const selectedNote = new TFile("projects/alpha/note.md", "note.md");
  const otherNote = new TFile("projects/beta/note.md", "note.md");
  const contents = new Map([
    [selectedNote.path, "![[shared-assets/image.png]]"],
    [otherNote.path, "![[shared-assets/image.png]]"],
  ]);
  const vault = {
    getMarkdownFiles: () => [selectedNote, otherNote],
    cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
  };
  const progress: number[] = [];
  const result = await scanMigrationOccurrences(
    vault as never,
    { getFirstLinkpathDest: () => target } as never,
    "projects/alpha",
    (item) => progress.push(item.scanned),
  );

  assert.equal(result.length, 1);
  assert.deepEqual(
    result[0].occurrences.map((item) => item.sourcePath),
    [selectedNote.path, otherNote.path],
    "all references must migrate before deleting the shared local attachment",
  );
  assert.deepEqual(progress, [0, 1, 2]);
});

test("plans and replaces duplicate embeds as independent occurrences", async () => {
  const target = new TFile("assets/image.png", "image.png");
  const note = new TFile("notes/a.md", "a.md");
  const contents = new Map([[note.path, "![[assets/image.png]] and ![[assets/image.png]]"]]);
  const vault = {
    getMarkdownFiles: () => [note],
    getAbstractFileByPath: (path: string) => path === note.path ? note : null,
    cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
    modify: async (file: TFile, value: string) => { contents.set(file.path, value); },
  };
  const metadataCache = { getFirstLinkpathDest: () => target };

  const occurrences = await findResolvedAttachmentOccurrences(vault as never, metadataCache as never, target as never);
  assert.deepEqual(occurrences.map((item) => item.occurrenceId), ["notes/a.md#0", "notes/a.md#1"]);

  assert.equal(await replaceOneResolvedAttachmentReference(
    vault as never, metadataCache as never, target as never, note.path, "vault/one.png",
  ), true);
  assert.equal(await replaceOneResolvedAttachmentReference(
    vault as never, metadataCache as never, target as never, note.path, "vault/two.png",
  ), true);
  assert.equal(contents.get(note.path), "![image.png](oss://vault/one.png) and ![image.png](oss://vault/two.png)");
});

test("replaces only the same-basename attachment resolved by Obsidian", async () => {
  const target = new TFile("assets/a/image.png", "image.png");
  const other = new TFile("assets/b/image.png", "image.png");
  const noteA = new TFile("notes/a.md", "a.md");
  const noteB = new TFile("notes/b.md", "b.md");
  const contents = new Map([
    [noteA.path, "![[assets/a/image.png]]"],
    [noteB.path, "![[assets/b/image.png]]"],
  ]);
  const vault = {
    getMarkdownFiles: () => [noteA, noteB],
    cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
    modify: async (file: TFile, value: string) => { contents.set(file.path, value); },
  };
  const metadataCache = {
    getFirstLinkpathDest: (linkpath: string) => linkpath.includes("assets/a/") ? target : other,
  };

  const result = await replaceResolvedAttachmentReferences(
    vault as never,
    metadataCache as never,
    target as never,
    "vault/new.png",
  );

  assert.deepEqual(result.modifiedPaths, [noteA.path]);
  assert.match(contents.get(noteA.path) ?? "", /oss:\/\/vault\/new\.png/);
  assert.equal(contents.get(noteB.path), "![[assets/b/image.png]]");
});

test("replaces markdown embeds whose destination contains balanced parentheses", async () => {
  const target = new TFile("assets/report (1).pdf", "report (1).pdf");
  const note = new TFile("notes/a.md", "a.md");
  const contents = new Map([[note.path, '![报告](<../assets/report (1).pdf> "打开报告")']]);
  const vault = {
    getMarkdownFiles: () => [note],
    cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
    modify: async (file: TFile, value: string) => { contents.set(file.path, value); },
  };
  const metadataCache = { getFirstLinkpathDest: () => target };

  const result = await replaceResolvedAttachmentReferences(
    vault as never, metadataCache as never, target as never, "vault/new.pdf",
  );
  assert.deepEqual(result.modifiedPaths, [note.path]);
  assert.equal(contents.get(note.path), "![report (1).pdf](oss://vault/new.pdf)");
});

test("rolls back already committed documents when a later write fails", async () => {
  const target = new TFile("assets/image.png", "image.png");
  const noteA = new TFile("notes/a.md", "a.md");
  const noteB = new TFile("notes/b.md", "b.md");
  const original = "![[assets/image.png]]";
  const contents = new Map([[noteA.path, original], [noteB.path, original]]);
  const vault = {
    getMarkdownFiles: () => [noteA, noteB],
    cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
    modify: async (file: TFile, value: string) => {
      if (file.path === noteB.path) throw new Error("disk full");
      contents.set(file.path, value);
    },
  };
  const metadataCache = { getFirstLinkpathDest: () => target };

  await assert.rejects(
    replaceResolvedAttachmentReferences(vault as never, metadataCache as never, target as never, "vault/new.png"),
    /disk full/,
  );
  assert.equal(contents.get(noteA.path), original);
});
