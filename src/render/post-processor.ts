import { MarkdownPostProcessorContext } from "obsidian";
import { PluginSettings } from "../types";
import { RENDER_SURFACE_SELECTOR } from "./dom-renderer";
import { clearOssRenderError, showOssRenderError } from "./error-state";
import { ossKeyFromImageSource } from "./oss-source";
import { SignedUrlResolver } from "./url-resolver";
import { defaultPdfRenderer, PdfRenderer } from "./pdf-link";

/**
 * Reading View 后处理：遍历 <img>/<video>/<audio>/<a>，
 * 将 `oss://{key}` 替换为动态签名 URL；不同媒体渲染为对应元素。
 */
export function createOssPostProcessor(
  settings: PluginSettings,
  resolver: SignedUrlResolver,
  pdfRenderer: PdfRenderer = defaultPdfRenderer,
) {
  return async function processor(el: HTMLElement, _ctx: MarkdownPostProcessorContext) {
    // Live Preview 与 Canvas 由增量 Observer 独占，避免同一节点被两条管线重复处理。
    if (el.closest(RENDER_SURFACE_SELECTOR)) return;

    // Obsidian 会把 ![](oss://xxx) 渲染成 <img src="oss://xxx"> 或视为普通链接
    // 我们统一按 src / href 属性扫一遍
    const nodes = collectOssNodes(el);
    const results = await Promise.allSettled(
      nodes.map((node) => hydrateNode(node, settings, resolver, pdfRenderer)),
    );
    results.forEach((result, index) => {
      if (result.status !== "rejected") return;
      const node = nodes[index];
      if (
        currentOssKey(node) !== node.key ||
        (node.el as HTMLElement).closest?.(RENDER_SURFACE_SELECTOR)
      ) return;
      showOssRenderError(
        node.el,
        node.key,
        `OSS 媒体签名失败: ${node.key}`,
      );
    });
  };
}

interface OssNode {
  el: Element;
  key: string;
  /** 原始元素类型：img / a / video / audio / source */
  kind: "img" | "video" | "audio" | "a" | "embed" | "unknown";
}

function collectOssNodes(root: HTMLElement): OssNode[] {
  const out: OssNode[] = [];
  root.querySelectorAll("img").forEach((el) => {
    const key = ossKeyFromImageSource(el.getAttribute("src") ?? "");
    if (key) out.push({ el, key, kind: "img" });
  });
  root.querySelectorAll("video, audio").forEach((el) => {
    const src = el.getAttribute("src");
    const key = src ? ossKeyFromImageSource(src) : null;
    if (key) out.push({ el, key, kind: el.tagName.toLowerCase() === "video" ? "video" : "audio" });
  });
  root.querySelectorAll("a").forEach((el) => {
    const key = ossKeyFromImageSource(el.getAttribute("href") ?? "");
    if (key) out.push({ el, key, kind: "a" });
  });
  root.querySelectorAll("embed").forEach((el) => {
    const key = ossKeyFromImageSource(el.getAttribute("src") ?? "");
    if (key) out.push({ el, key, kind: "embed" });
  });
  return out;
}

async function hydrateNode(
  node: OssNode,
  settings: PluginSettings,
  resolver: SignedUrlResolver,
  pdfRenderer: PdfRenderer,
): Promise<void> {
  if (node.key.startsWith("uploading/")) return;
  if (!settings.bucketName || !settings.accessKeyId || !settings.accessKeySecret) {
    showOssRenderError(node.el, node.key, `OSS 未配置: ${node.key}`);
    return;
  }
  const html = node.el as HTMLElement;
  if (html.dataset.ossSigningKey === node.key) return;

  html.dataset.ossSigningKey = node.key;
  try {
    const url = await resolver.resolve(node.key);
    if (html.dataset.ossSigningKey !== node.key || currentOssKey(node) !== node.key) return;
    clearOssRenderError(node.el);
    const ext = keyExt(node.key);

    // 若原元素类型与实际媒体不匹配（如 mp4 被渲染成 <img>），替换为合适元素
    const desired = mediaKindOfExt(ext);
    if (desired === "embed" || (desired && desired !== node.kind && (node.kind === "img" || node.kind === "a"))) {
      const replaced = buildMediaElement(desired, url, node.el, node.key, pdfRenderer);
      node.el.replaceWith(replaced);
    } else if (node.kind === "img") {
      (node.el as HTMLImageElement).src = url;
    } else if (node.kind === "video" || node.kind === "audio") {
      (node.el as HTMLMediaElement).src = url;
    } else if (node.kind === "a") {
      (node.el as HTMLAnchorElement).href = url;
      (node.el as HTMLAnchorElement).target = "_blank";
    } else if (node.kind === "embed") {
      (node.el as HTMLEmbedElement).src = url;
    }
  } catch (error) {
    if (html.dataset.ossSigningKey !== node.key || currentOssKey(node) !== node.key) return;
    throw error;
  } finally {
    if (html.dataset.ossSigningKey === node.key) delete html.dataset.ossSigningKey;
  }
}

function currentOssKey(node: OssNode): string | null {
  const attribute = node.kind === "a" ? "href" : "src";
  return ossKeyFromImageSource(node.el.getAttribute(attribute) ?? "");
}

function keyExt(key: string): string {
  const idx = key.lastIndexOf(".");
  return idx >= 0 ? key.slice(idx + 1).toLowerCase() : "";
}

type MediaKind = "img" | "video" | "audio" | "embed";

function mediaKindOfExt(ext: string): MediaKind | null {
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "img";
  if (["mp4", "mov", "webm", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg", "flac"].includes(ext)) return "audio";
  if (ext === "pdf") return "embed";
  return null;
}

function buildMediaElement(
  kind: MediaKind,
  url: string,
  from: Element,
  key: string,
  pdfRenderer: PdfRenderer,
): HTMLElement {
  if (kind === "img") {
    const img = document.createElement("img");
    img.src = url;
    img.alt = from.getAttribute("alt") ?? "";
    return img;
  }
  if (kind === "video") {
    const v = document.createElement("video");
    v.src = url;
    v.controls = true;
    v.style.maxWidth = "100%";
    return v;
  }
  if (kind === "audio") {
    const a = document.createElement("audio");
    a.src = url;
    a.controls = true;
    return a;
  }
  // pdf
  return pdfRenderer.mount(from, url, key);
}
