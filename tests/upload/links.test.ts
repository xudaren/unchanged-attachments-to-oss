import assert from "node:assert/strict";
import test from "node:test";
import { TFile, TFolder } from "obsidian";
import {
  findResolvedAttachmentOccurrences,
  resolvedSourcePathsForAttachment,
  replaceOneResolvedAttachmentReference,
  ResolvedAttachmentBacklinkCache,
  scanMigrationOccurrences,
  waitForStableAttachmentOccurrences,
} from "../../src/upload/links";

test("fallback occurrence discovery reads only MetadataCache candidates", async () => {
  const target = new TFile("assets/image.png", "image.png");
  const candidate = new TFile("notes/candidate.md", "candidate.md");
  const unrelated = new TFile("notes/unrelated.md", "unrelated.md");
  const reads: string[] = [];
  const vault = {
    getAbstractFileByPath: (path: string) => path === candidate.path ? candidate : unrelated,
    cachedRead: async (file: TFile) => {
      reads.push(file.path);
      return file.path === candidate.path ? "![[assets/image.png]]" : "unrelated";
    },
  };
  const metadataCache = {
    resolvedLinks: { [candidate.path]: { [target.path]: 1 } },
    getFirstLinkpathDest: () => target,
  };

  assert.deepEqual(
    resolvedSourcePathsForAttachment(metadataCache as never, target.path),
    [candidate.path],
  );
  const occurrences = await findResolvedAttachmentOccurrences(
    vault as never,
    metadataCache as never,
    target as never,
  );

  assert.deepEqual(reads, [candidate.path]);
  assert.deepEqual(occurrences.map((item) => item.sourcePath), [candidate.path]);
});

test("runtime backlink cache rebuilds only after invalidation", () => {
  const metadataCache = { resolvedLinks: { "a.md": { "assets/a.png": 1 } } };
  const cache = new ResolvedAttachmentBacklinkCache(metadataCache as never);

  assert.deepEqual(cache.get("assets/a.png"), ["a.md"]);
  metadataCache.resolvedLinks = { "b.md": { "assets/a.png": 1 } };
  assert.deepEqual(cache.get("assets/a.png"), ["a.md"]);
  cache.invalidate();
  assert.deepEqual(cache.get("assets/a.png"), ["b.md"]);
});

test("uses MetadataCache embed positions so code examples are never migrated", async () => {
  const target = new TFile("assets/image.png", "image.png");
  const note = new TFile("notes/a.md", "a.md");
  const fake = "![[assets/image.png]]";
  const real = "![语义名称](../assets/image.png)";
  const content = `\`\`\`md\n${fake}\n\`\`\`\n${real}`;
  const start = content.indexOf(real);
  const vault = {
    getAbstractFileByPath: () => note,
    cachedRead: async () => content,
  };
  const metadataCache = {
    resolvedLinks: { [note.path]: { [target.path]: 1 } },
    getFileCache: () => ({
      embeds: [{
        link: "../assets/image.png",
        original: real,
        displayText: "语义名称",
        position: {
          start: { offset: start, line: 4, col: 0 },
          end: { offset: start + real.length, line: 4, col: real.length },
        },
      }],
    }),
    getFirstLinkpathDest: () => target,
  };

  const occurrences = await findResolvedAttachmentOccurrences(
    vault as never,
    metadataCache as never,
    target as never,
  );

  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].alt, "语义名称");
  assert.equal(occurrences[0].locator.original, real);
});

test("fallback parsing ignores frontmatter, comments, fenced code and inline code", async () => {
  const target = new TFile("assets/image.png", "image.png");
  const note = new TFile("notes/a.md", "a.md");
  const real = "![真实附件](../assets/image.png)";
  const content = [
    "---",
    "example: '![[assets/image.png]]'",
    "---",
    "<!-- ![[assets/image.png]] -->",
    "```md",
    "![[assets/image.png]]",
    "```",
    "`![[assets/image.png]]`",
    real,
  ].join("\n");
  const vault = {
    getAbstractFileByPath: () => note,
    cachedRead: async () => content,
  };
  const metadataCache = {
    resolvedLinks: { [note.path]: { [target.path]: 1 } },
    getFirstLinkpathDest: () => target,
  };

  const occurrences = await findResolvedAttachmentOccurrences(
    vault as never,
    metadataCache as never,
    target as never,
  );

  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].locator.original, real);
});

test("falls back to the current Markdown snapshot when cached embed positions are stale", async () => {
  const target = new TFile("assets/image.png", "image.png");
  const note = new TFile("notes/a.md", "a.md");
  const token = "![[assets/image.png]]";
  const content = `prefix ${token}`;
  const vault = {
    getAbstractFileByPath: () => note,
    cachedRead: async () => content,
  };
  const metadataCache = {
    resolvedLinks: { [note.path]: { [target.path]: 1 } },
    getFileCache: () => ({
      embeds: [{
        link: "assets/image.png",
        original: token,
        position: { start: { offset: 0 }, end: { offset: token.length } },
      }],
    }),
    getFirstLinkpathDest: () => target,
  };

  const occurrences = await findResolvedAttachmentOccurrences(
    vault as never,
    metadataCache as never,
    target as never,
  );

  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].locator.start, "prefix ".length);
});

test("folder migration includes attachments referenced by notes in the selected folder", async () => {
  const target = new TFile("shared-assets/image.png", "image.png");
  const selectedNote = new TFile("projects/alpha/note.md", "note.md");
  const otherNote = new TFile("projects/beta/note.md", "note.md");
  const unrelatedNote = new TFile("notes/unrelated.md", "unrelated.md");
  const contents = new Map([
    [selectedNote.path, "![[shared-assets/image.png]]"],
    [otherNote.path, "![[shared-assets/image.png]]"],
    [unrelatedNote.path, "no attachments"],
  ]);
  const files = new Map([target, selectedNote, otherNote, unrelatedNote].map((file) => [file.path, file]));
  const reads: string[] = [];
  const vault = {
    getFiles: () => [...files.values()],
    getAbstractFileByPath: (path: string) => files.get(path) ?? null,
    cachedRead: async (file: TFile) => {
      reads.push(file.path);
      return contents.get(file.path) ?? "";
    },
  };
  const metadataCache = {
    resolvedLinks: {
      [selectedNote.path]: { [target.path]: 1 },
      [otherNote.path]: { [target.path]: 1 },
      [unrelatedNote.path]: {},
    },
    getFirstLinkpathDest: () => target,
  };
  const progress: number[] = [];
  const result = await scanMigrationOccurrences(
    vault as never,
    metadataCache as never,
    "projects/alpha",
    (item) => progress.push(item.scanned),
  );

  assert.equal(result.length, 1);
  assert.deepEqual(reads, [selectedNote.path, otherNote.path], "unrelated Markdown must not be read");
  assert.deepEqual(
    result[0].occurrences.map((item) => item.sourcePath),
    [selectedNote.path, otherNote.path],
    "all references must migrate before deleting the shared local attachment",
  );
  assert.deepEqual(progress, [0, 1, 2]);
});

test("folder migration finds physical attachments without enumerating the whole Vault", async () => {
  const target = new TFile("projects/alpha/assets/image.png", "image.png");
  const folder = new TFolder("projects/alpha", [target]);
  const outsideNote = new TFile("notes/outside.md", "outside.md");
  const files = new Map([folder, target, outsideNote].map((file) => [file.path, file]));
  const reads: string[] = [];
  const vault = {
    getFiles: () => { throw new Error("must not enumerate all Vault files"); },
    getAbstractFileByPath: (path: string) => files.get(path) ?? null,
    cachedRead: async (file: TFile) => {
      reads.push(file.path);
      return "![[projects/alpha/assets/image.png]]";
    },
  };
  const metadataCache = {
    resolvedLinks: { [outsideNote.path]: { [target.path]: 1 } },
    getFirstLinkpathDest: () => target,
  };

  const result = await scanMigrationOccurrences(
    vault as never,
    metadataCache as never,
    folder.path,
  );

  assert.deepEqual(reads, [outsideNote.path]);
  assert.deepEqual(result[0].occurrences.map((item) => item.sourcePath), [outsideNote.path]);
});

test("plans and replaces duplicate embeds as independent occurrences", async () => {
  const target = new TFile("assets/image.png", "image.png");
  const note = new TFile("notes/a.md", "a.md");
  const contents = new Map([[note.path, "![[assets/image.png]] and ![[assets/image.png]]"]]);
  const vault = {
    getAbstractFileByPath: (path: string) => path === note.path ? note : null,
    cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
    modify: async (file: TFile, value: string) => { contents.set(file.path, value); },
    process: async (file: TFile, fn: (value: string) => string) => {
      const next = fn(contents.get(file.path) ?? "");
      contents.set(file.path, next);
      return next;
    },
  };
  const metadataCache = {
    resolvedLinks: { [note.path]: { [target.path]: 2 } },
    getFirstLinkpathDest: () => target,
  };

  const occurrences = await findResolvedAttachmentOccurrences(vault as never, metadataCache as never, target as never);
  assert.deepEqual(occurrences.map((item) => item.occurrenceId), ["notes/a.md:0:21", "notes/a.md:26:47"]);

  assert.equal(await replaceOneResolvedAttachmentReference(
    vault as never, metadataCache as never, target as never, note.path, "vault/one.png",
  ), true);
  assert.equal(await replaceOneResolvedAttachmentReference(
    vault as never, metadataCache as never, target as never, note.path, "vault/two.png",
  ), true);
  assert.equal(contents.get(note.path), "![image.png](oss:///vault/one.png) and ![image.png](oss:///vault/two.png)");
});

test("commits the planned duplicate occurrence after surrounding text shifts", async () => {
  const target = new TFile("assets/image.png", "image.png");
  const note = new TFile("notes/a.md", "a.md");
  const original = "![[assets/image.png]] and ![[assets/image.png]]";
  const contents = new Map([[note.path, original]]);
  const vault = {
    getAbstractFileByPath: () => note,
    cachedRead: async () => contents.get(note.path) ?? "",
    process: async (_file: TFile, fn: (value: string) => string) => {
      const next = fn(contents.get(note.path) ?? "");
      contents.set(note.path, next);
      return next;
    },
  };
  const metadataCache = {
    resolvedLinks: { [note.path]: { [target.path]: 2 } },
    getFirstLinkpathDest: () => target,
  };
  const occurrences = await findResolvedAttachmentOccurrences(
    vault as never, metadataCache as never, target as never,
  );
  contents.set(note.path, `prefix ${original}`);

  assert.equal(await replaceOneResolvedAttachmentReference(
    vault as never,
    metadataCache as never,
    target as never,
    note.path,
    "vault/second.png",
    occurrences[1],
  ), true);
  assert.equal(
    contents.get(note.path),
    "prefix ![[assets/image.png]] and ![image.png](oss:///vault/second.png)",
  );
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
    getAbstractFileByPath: (path: string) => path === noteA.path ? noteA : path === noteB.path ? noteB : null,
    cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
    modify: async (file: TFile, value: string) => { contents.set(file.path, value); },
    process: async (file: TFile, fn: (value: string) => string) => {
      const next = fn(contents.get(file.path) ?? "");
      contents.set(file.path, next);
      return next;
    },
  };
  const metadataCache = {
    getFirstLinkpathDest: (linkpath: string) => linkpath.includes("assets/a/") ? target : other,
  };

  const result = await replaceOneResolvedAttachmentReference(
    vault as never,
    metadataCache as never,
    target as never,
    noteA.path,
    "vault/new.png",
  );

  assert.equal(result, true);
  assert.match(contents.get(noteA.path) ?? "", /oss:\/\/\/vault\/new\.png/);
  assert.equal(contents.get(noteB.path), "![[assets/b/image.png]]");
});

test("replaces markdown embeds whose destination contains balanced parentheses", async () => {
  const target = new TFile("assets/report (1).pdf", "report (1).pdf");
  const note = new TFile("notes/a.md", "a.md");
  const contents = new Map([[note.path, '![报告](<../assets/report (1).pdf> "打开报告")']]);
  const vault = {
    getAbstractFileByPath: () => note,
    cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
    modify: async (file: TFile, value: string) => { contents.set(file.path, value); },
    process: async (file: TFile, fn: (value: string) => string) => {
      const next = fn(contents.get(file.path) ?? "");
      contents.set(file.path, next);
      return next;
    },
  };
  const metadataCache = { getFirstLinkpathDest: () => target };

  const result = await replaceOneResolvedAttachmentReference(
    vault as never, metadataCache as never, target as never, note.path, "vault/new.pdf",
  );
  assert.equal(result, true);
  assert.equal(contents.get(note.path), "![报告](oss:///vault/new.pdf)");
});

test("distinguishes parentheses in a destination from a parenthesized Markdown title", async () => {
  const target = new TFile("assets/a(b).png", "a(b).png");
  const note = new TFile("notes/a.md", "a.md");
  const contents = new Map([[note.path, "![图](../assets/a(b).png (预览标题))"]]);
  let resolvedLinkpath = "";
  const vault = {
    getAbstractFileByPath: () => note,
    cachedRead: async () => contents.get(note.path) ?? "",
  };
  const metadataCache = {
    resolvedLinks: { [note.path]: { [target.path]: 1 } },
    getFirstLinkpathDest: (linkpath: string) => {
      resolvedLinkpath = linkpath;
      return target;
    },
  };

  const occurrences = await findResolvedAttachmentOccurrences(
    vault as never,
    metadataCache as never,
    target as never,
  );

  assert.equal(occurrences.length, 1);
  assert.equal(resolvedLinkpath, "../assets/a(b).png");
});

test("stable final scan catches a candidate that MetadataCache resolves after 300ms", async () => {
  const target = new TFile("assets/image.png", "image.png");
  const note = new TFile("notes/late.md", "late.md");
  const metadataCache = {
    resolvedLinks: {} as Record<string, Record<string, number>>,
    getFirstLinkpathDest: () => target,
  };
  const vault = {
    getAbstractFileByPath: (path: string) => path === note.path ? note : null,
    cachedRead: async () => "![[assets/image.png]]",
  };
  let generation = 0;
  const timer = setTimeout(() => {
    metadataCache.resolvedLinks = { [note.path]: { [target.path]: 1 } };
    generation++;
  }, 450);

  try {
    const result = await waitForStableAttachmentOccurrences(
      vault as never,
      metadataCache as never,
      target,
      { baseline: 0, current: () => generation },
      2200,
      50,
      200,
    );

    assert.equal(result.confirmed, true);
    assert.equal(result.occurrences.length, 1);
    assert.equal(result.occurrences[0].sourcePath, note.path);
  } finally {
    clearTimeout(timer);
  }
});

test("stable final scan treats a MetadataCache timeout as unsafe, not as zero references", async () => {
  const target = new TFile("assets/image.png", "image.png");
  const metadataCache = { resolvedLinks: {}, getFirstLinkpathDest: () => target };
  const vault = { getAbstractFileByPath: () => null, cachedRead: async () => "" };

  const result = await waitForStableAttachmentOccurrences(
    vault as never,
    metadataCache as never,
    target,
    { baseline: 0, current: () => 0 },
    180,
    30,
    60,
  );

  assert.equal(result.confirmed, false);
  assert.deepEqual(result.occurrences, []);
});
