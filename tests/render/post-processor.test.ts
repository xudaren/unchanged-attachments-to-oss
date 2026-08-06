import assert from "node:assert/strict";
import test from "node:test";
import { createOssPostProcessor } from "../../src/render/post-processor";
import type { SignedUrlResolver } from "../../src/render/url-resolver";
import type { PluginSettings } from "../../src/types";

function image(source: string) {
  const attributes = new Map<string, string>([["src", source]]);
  let errorMarker: { className?: string; textContent?: string | null; remove(): void } | null = null;
  const element = {
    tagName: "IMG",
    dataset: {} as Record<string, string>,
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
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    replaceWith: () => undefined,
    get src() { return attributes.get("src") ?? ""; },
    set src(value: string) { attributes.set("src", value); },
    get alt() { return attributes.get("alt") ?? ""; },
    get title() { return attributes.get("title") ?? ""; },
    get errorClass() { return errorMarker?.className ?? ""; },
    get errorText() { return errorMarker?.textContent ?? ""; },
  };
  return element;
}

test("Reading View hydrates successful nodes when a sibling signature fails", async () => {
  const good = image("oss://vault/good.jpg");
  const bad = image("oss://vault/bad.jpg");
  const root = {
    closest: () => null,
    querySelectorAll: (selector: string) => selector === "img" ? [good, bad] : [],
  } as unknown as HTMLElement;
  const settings = {
    bucketName: "bucket",
    accessKeyId: "ak",
    accessKeySecret: "sk",
  } as PluginSettings;
  const resolver = {
    resolve: async (key: string) => {
      if (key.endsWith("bad.jpg")) throw new Error("signing failed");
      return `https://signed.example/${key}`;
    },
  } as unknown as SignedUrlResolver;

  await createOssPostProcessor(settings, resolver)(root, {} as never);

  assert.equal(good.src, "https://signed.example/vault/good.jpg");
  assert.equal(bad.errorClass, "oss-render-error");
  assert.equal(bad.errorText, "OSS 媒体签名失败: vault/bad.jpg");
});

test("Reading View processor leaves Canvas nodes to the incremental observer", async () => {
  const canvasImage = image("oss://vault/canvas.jpg");
  const root = {
    closest: () => ({} as Element),
    querySelectorAll: (selector: string) => selector === "img" ? [canvasImage] : [],
  } as unknown as HTMLElement;
  let resolutions = 0;
  const resolver = {
    resolve: async () => {
      resolutions += 1;
      return "https://signed.example/vault/canvas.jpg";
    },
  } as unknown as SignedUrlResolver;

  await createOssPostProcessor({
    bucketName: "bucket",
    accessKeyId: "ak",
    accessKeySecret: "sk",
  } as PluginSettings, resolver)(root, {} as never);

  assert.equal(resolutions, 0);
  assert.equal(canvasImage.src, "oss://vault/canvas.jpg");
});

test("Reading View does not attach an old batch error to a reused node", async () => {
  const reused = image("oss://vault/old.jpg");
  const slow = image("oss://vault/slow.jpg");
  let releaseSlow!: (url: string) => void;
  const root = {
    closest: () => null,
    querySelectorAll: (selector: string) => selector === "img" ? [reused, slow] : [],
  } as unknown as HTMLElement;
  const resolver = {
    resolve: (key: string) => {
      if (key.endsWith("old.jpg")) return Promise.reject(new Error("old signing failed"));
      return new Promise<string>((resolve) => { releaseSlow = resolve; });
    },
  } as unknown as SignedUrlResolver;

  const processing = createOssPostProcessor({
    bucketName: "bucket",
    accessKeyId: "ak",
    accessKeySecret: "sk",
  } as PluginSettings, resolver)(root, {} as never);
  await Promise.resolve();
  reused.src = "oss://vault/reused.jpg";
  releaseSlow("https://signed.example/vault/slow.jpg");
  await processing;

  assert.equal(reused.errorText, "");
});

test("Reading View replaces a PDF placeholder with the shared browser link", async () => {
  const pdf = image("oss://vault/a.pdf") as ReturnType<typeof image> & { replacement?: unknown };
  pdf.setAttribute("alt", "百鸟数据-声纹检测报告.pdf");
  pdf.replaceWith = (replacement: unknown) => { pdf.replacement = replacement; };
  const root = {
    closest: () => null,
    querySelectorAll: (selector: string) => selector === "img" ? [pdf] : [],
  } as unknown as HTMLElement;
  const host = { className: "oss-pdf-viewer" };
  let displayName: string | undefined;

  await createOssPostProcessor({
    bucketName: "bucket",
    accessKeyId: "ak",
    accessKeySecret: "sk",
  } as PluginSettings, {
    resolve: async () => "https://signed.example/vault/a.pdf",
  } as unknown as SignedUrlResolver, {
    mount: (_from, _url, _key, name) => {
      displayName = name;
      return host as unknown as HTMLElement;
    },
  })(root, {} as never);

  assert.equal(pdf.replacement, host);
  assert.equal(displayName, "百鸟数据-声纹检测报告.pdf");
});
