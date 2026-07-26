import { MarkdownPostProcessorContext } from "obsidian";
import { OssClient } from "../oss/client";
import { signedGetUrl } from "../oss/signer";
import { PluginSettings, extractOssKey, mimeOf } from "../types";
import { SignedUrlCache } from "./url-cache";

/**
 * Reading View 后处理：遍历 <img>/<video>/<audio>/<a>，
 * 将 `oss://{key}` 替换为动态签名 URL；不同媒体渲染为对应元素。
 */
export function createOssPostProcessor(
  settings: PluginSettings,
  client: OssClient,
  cache: SignedUrlCache,
) {
  return async function processor(el: HTMLElement, _ctx: MarkdownPostProcessorContext) {
    // Obsidian 会把 ![](oss://xxx) 渲染成 <img src="oss://xxx"> 或视为普通链接
    // 我们统一按 src / href 属性扫一遍
    const nodes = collectOssNodes(el);
    for (const node of nodes) {
      await hydrateNode(node, settings, client, cache);
    }
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
    const key = extractOssKey(el.getAttribute("src") ?? "");
    if (key) out.push({ el, key, kind: "img" });
  });
  root.querySelectorAll("video, audio").forEach((el) => {
    const src = el.getAttribute("src");
    const key = src ? extractOssKey(src) : null;
    if (key) out.push({ el, key, kind: el.tagName.toLowerCase() === "video" ? "video" : "audio" });
  });
  root.querySelectorAll("a").forEach((el) => {
    const key = extractOssKey(el.getAttribute("href") ?? "");
    if (key) out.push({ el, key, kind: "a" });
  });
  root.querySelectorAll("embed").forEach((el) => {
    const key = extractOssKey(el.getAttribute("src") ?? "");
    if (key) out.push({ el, key, kind: "embed" });
  });
  return out;
}

async function hydrateNode(
  node: OssNode,
  settings: PluginSettings,
  client: OssClient,
  cache: SignedUrlCache,
): Promise<void> {
  if (!settings.bucketName || !settings.accessKeyId || !settings.accessKeySecret) {
    node.el.setAttribute("alt", "[OSS 未配置]");
    return;
  }
  const url = await resolveUrl(node.key, settings, client, cache);
  const ext = keyExt(node.key);

  // 若原元素类型与实际媒体不匹配（如 mp4 被渲染成 <img>），替换为合适元素
  const desired = mediaKindOfExt(ext);
  if (desired && desired !== node.kind && (node.kind === "img" || node.kind === "a")) {
    const replaced = buildMediaElement(desired, url, mimeOf(ext), node.el);
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
}

async function resolveUrl(
  key: string,
  settings: PluginSettings,
  client: OssClient,
  cache: SignedUrlCache,
): Promise<string> {
  const hit = cache.get(key);
  if (hit) return hit;
  const { url, expireAt } = await signedGetUrl({
    bucket: settings.bucketName,
    key,
    host: client.signedUrlHost,
    accessKeyId: settings.accessKeyId,
    accessKeySecret: settings.accessKeySecret,
    expireSeconds: settings.signedUrlExpireSeconds,
  });
  cache.set(key, url, expireAt);
  return url;
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

function buildMediaElement(kind: MediaKind, url: string, mime: string, from: Element): HTMLElement {
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
  const e = document.createElement("embed");
  e.setAttribute("src", url);
  e.setAttribute("type", mime);
  e.style.width = "100%";
  e.style.height = "600px";
  return e;
}
