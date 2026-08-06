import assert from "node:assert/strict";
import test from "node:test";
import { hydrateOssSubtree, selectMutationRoots } from "../../src/render/dom-renderer";

function node(
  nodeType: number,
  tagName?: string,
  options: { inSurface?: boolean; nestedSurfaces?: Node[] } = {},
): Node {
  return {
    nodeType,
    tagName,
    closest: () => options.inSurface === false ? null : ({} as Element),
    matches: () => false,
    querySelectorAll: () => options.nestedSurfaces ?? [],
  } as unknown as Node;
}

function record(type: MutationRecordType, target: Node, addedNodes: Node[] = []): MutationRecord {
  return { type, target, addedNodes } as unknown as MutationRecord;
}

test("selects only the changed media element for src and href mutations", () => {
  const image = node(1, "IMG");
  const anchor = node(1, "A");
  const unrelated = node(1, "DIV");

  assert.deepEqual(
    selectMutationRoots([
      record("attributes", image),
      record("attributes", anchor),
      record("attributes", unrelated),
    ]),
    [image, anchor],
  );
});

test("selects only added element subtrees from child-list mutations", () => {
  const subtree = node(1, "DIV");
  const fragment = node(11);
  const text = node(3);

  assert.deepEqual(
    selectMutationRoots([record("childList", node(1, "SECTION"), [subtree, text, fragment])]),
    [subtree, fragment],
  );
});

test("deduplicates mutation roots within one observer batch", () => {
  const image = node(1, "IMG");
  assert.deepEqual(
    selectMutationRoots([record("attributes", image), record("attributes", image)]),
    [image],
  );
});

test("ignores mutations outside Live Preview and Canvas surfaces", () => {
  const image = node(1, "IMG", { inSurface: false });
  const unrelatedTarget = node(1, "DIV", { inSurface: false });
  const unrelatedChild = node(1, "DIV", { inSurface: false });

  assert.deepEqual(
    selectMutationRoots([
      record("attributes", image),
      record("childList", unrelatedTarget, [unrelatedChild]),
    ]),
    [],
  );
});

test("selects a newly added Canvas surface without hydrating its outer UI container", () => {
  const canvas = node(1, "DIV");
  const outer = node(1, "DIV", { inSurface: false, nestedSurfaces: [canvas] });
  const unrelatedTarget = node(1, "DIV", { inSurface: false });

  assert.deepEqual(
    selectMutationRoots([record("childList", unrelatedTarget, [outer])]),
    [canvas],
  );
});

function mediaElement(tagName: string, source: string) {
  const attributes = new Map<string, string>([[tagName === "A" ? "href" : "src", source]]);
  let errorMarker: { className?: string; textContent?: string | null; remove(): void } | null = null;
  const element = {
    nodeType: 1,
    tagName,
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    closest: () => ({} as Element),
    ownerDocument: {
      createElement: () => ({
        dataset: {} as Record<string, string>,
        remove: () => { errorMarker = null; },
      }),
    },
    insertAdjacentElement: (_position: string, marker: typeof errorMarker) => {
      errorMarker = marker;
      return marker;
    },
    querySelectorAll: () => [],
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    replaceWith(replacement: unknown) { (this as { replacement?: unknown }).replacement = replacement; },
    get src() { return attributes.get("src") ?? ""; },
    set src(value: string) { attributes.set("src", value); },
    get href() { return attributes.get("href") ?? ""; },
    set href(value: string) { attributes.set("href", value); },
    get errorText() { return errorMarker?.textContent ?? ""; },
  };
  return element;
}

test("hydrates only the supplied OSS image subtree", async () => {
  const image = mediaElement("IMG", "oss://vault/a.jpg");
  const keys: string[] = [];

  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async (key: string) => {
      keys.push(key);
      return "https://signed.example/vault/a.jpg";
    },
  });

  assert.deepEqual(keys, ["vault/a.jpg"]);
  assert.equal(image.src, "https://signed.example/vault/a.jpg");
});

test("replaces an Obsidian image placeholder with the actual media type", async () => {
  const image = mediaElement("IMG", "oss://vault/a.mp4") as ReturnType<typeof mediaElement> & {
    ownerDocument?: { createElement(tag: string): unknown };
    replacement?: { tagName: string; src: string };
  };
  image.ownerDocument = {
    createElement: (tag: string) => mediaElement(tag.toUpperCase(), ""),
  };

  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => "https://signed.example/vault/a.mp4",
  });

  assert.equal(image.replacement?.tagName, "VIDEO");
  assert.equal(image.replacement?.src, "https://signed.example/vault/a.mp4");
});

test("replaces a PDF placeholder with the shared browser link", async () => {
  const image = mediaElement("IMG", "oss://vault/a.pdf") as ReturnType<typeof mediaElement> & {
    replacement?: unknown;
  };
  const pdfHost = { className: "oss-pdf-viewer" };
  const mounts: string[] = [];

  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => "https://signed.example/vault/a.pdf",
  }, {
    mount: (_from, url) => {
      mounts.push(url);
      return pdfHost as unknown as HTMLElement;
    },
  });

  assert.deepEqual(mounts, ["https://signed.example/vault/a.pdf"]);
  assert.equal(image.replacement, pdfHost);
});

test("replaces an existing PDF embed with the shared browser link", async () => {
  const embed = mediaElement("EMBED", "oss://vault/legacy.pdf") as ReturnType<typeof mediaElement> & {
    replacement?: unknown;
  };
  const host = { className: "oss-pdf-viewer" };

  await hydrateOssSubtree(embed as unknown as ParentNode, {
    resolve: async () => "https://signed.example/vault/legacy.pdf",
  }, {
    mount: () => host as unknown as HTMLElement,
  });

  assert.equal(embed.replacement, host);
});

test("does not let an older signature overwrite a reused media node", async () => {
  const image = mediaElement("IMG", "oss://vault/first.jpg");
  const completions = new Map<string, (url: string) => void>();
  const resolver = {
    resolve: (key: string) => new Promise<string>((resolve) => completions.set(key, resolve)),
  };

  const firstHydration = hydrateOssSubtree(image as unknown as ParentNode, resolver);
  image.src = "oss://vault/second.jpg";
  const secondHydration = hydrateOssSubtree(image as unknown as ParentNode, resolver);

  completions.get("vault/second.jpg")?.("https://signed.example/vault/second.jpg");
  await secondHydration;
  completions.get("vault/first.jpg")?.("https://signed.example/vault/first.jpg");
  await firstHydration;

  assert.equal(image.src, "https://signed.example/vault/second.jpg");
});

test("does not attach an old signing error after a node switches to a non-OSS source", async () => {
  const image = mediaElement("IMG", "oss://vault/old.jpg");
  let rejectSigning!: (error: Error) => void;
  const hydration = hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: () => new Promise<string>((_resolve, reject) => { rejectSigning = reject; }),
  });

  image.src = "app://local/image.jpg";
  rejectSigning(new Error("old signing failed"));
  await hydration;

  assert.equal(image.errorText, "");
});

test("clears a visible OSS error after the node switches to a local source", async () => {
  const image = mediaElement("IMG", "oss://vault/failed.jpg");
  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => { throw new Error("signing failed"); },
  });
  assert.equal(image.errorText, "OSS 媒体签名失败: vault/failed.jpg");

  image.src = "app://local/image.jpg";
  await hydrateOssSubtree(image as unknown as ParentNode, {
    resolve: async () => { throw new Error("must not sign local media"); },
  });

  assert.equal(image.errorText, "");
});
