import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { EditorSelection, Range } from "@codemirror/state";
import { OssClient } from "../oss/client";
import { signedGetUrl } from "../oss/signer";
import { PluginSettings, mimeOf } from "../types";
import { SignedUrlCache } from "./url-cache";

/** oss:// 链接正则：匹配 markdown image link ![alt](oss://key) */
const OSS_LINK_RE = /!\[([^\]]*)\]\(oss:\/\/([^)\s]+)\)/g;

/**
 * Live Preview 装饰器：在编辑态内联渲染 oss:// 图片/视频/音频/PDF。
 * 用户光标处于该范围时退回原文，离开时渲染为 Widget。
 */
export function createOssLivePreviewPlugin(
  settings: PluginSettings,
  client: OssClient,
  cache: SignedUrlCache,
) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;

      constructor(private readonly view: EditorView) {
        this.decorations = this.build();
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = this.build();
        }
      }

      private build(): DecorationSet {
        const widgets: Range<Decoration>[] = [];
        const doc = this.view.state.doc;
        const selection = this.view.state.selection;

        for (const { from, to } of this.view.visibleRanges) {
          const text = doc.sliceString(from, to);
          let m: RegExpExecArray | null;
          OSS_LINK_RE.lastIndex = 0;
          while ((m = OSS_LINK_RE.exec(text)) !== null) {
            const matchFrom = from + m.index;
            const matchTo = matchFrom + m[0].length;

            // 光标在范围内时不装饰，让用户编辑原文
            if (isCursorInRange(selection, matchFrom, matchTo)) continue;

            const alt = m[1];
            const key = m[2];
            // 跳过上传中的占位符
            if (key.startsWith("uploading/")) continue;

            const deco = Decoration.replace({
              widget: new OssMediaWidget(key, alt, settings, client, cache),
            });
            widgets.push(deco.range(matchFrom, matchTo));
          }
        }

        return Decoration.set(widgets, true);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

function isCursorInRange(sel: EditorSelection, from: number, to: number): boolean {
  for (const range of sel.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

class OssMediaWidget extends WidgetType {
  private signedUrl: string | null = null;
  private resolving = false;

  constructor(
    private readonly key: string,
    private readonly alt: string,
    private readonly settings: PluginSettings,
    private readonly client: OssClient,
    private readonly cache: SignedUrlCache,
  ) {
    super();
  }

  eq(other: OssMediaWidget): boolean {
    return this.key === other.key;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "oss-live-preview-widget";

    const cached = this.cache.get(this.key);
    if (cached) {
      this.signedUrl = cached;
      this.renderMedia(wrapper);
    } else {
      wrapper.textContent = `⏳ ${this.alt || this.key}`;
      wrapper.style.opacity = "0.6";
      this.resolveAndRender(wrapper, view);
    }
    return wrapper;
  }

  private async resolveAndRender(wrapper: HTMLElement, view: EditorView): Promise<void> {
    if (this.resolving) return;
    this.resolving = true;
    try {
      const { url, expireAt } = await signedGetUrl({
        bucket: this.settings.bucketName,
        key: this.key,
        host: this.client.signedUrlHost,
        accessKeyId: this.settings.accessKeyId,
        accessKeySecret: this.settings.accessKeySecret,
        expireSeconds: this.settings.signedUrlExpireSeconds,
      });
      this.cache.set(this.key, url, expireAt);
      this.signedUrl = url;
      // 签名完成后刷新 widget
      wrapper.textContent = "";
      wrapper.style.opacity = "";
      this.renderMedia(wrapper);
    } catch (err) {
      wrapper.textContent = `❌ 签名失败: ${this.key}`;
      wrapper.style.color = "var(--text-error)";
    }
  }

  private renderMedia(wrapper: HTMLElement): void {
    if (!this.signedUrl) return;
    const ext = keyExt(this.key);
    const kind = mediaKind(ext);
    switch (kind) {
      case "img": {
        const img = document.createElement("img");
        img.src = this.signedUrl;
        img.alt = this.alt;
        img.style.maxWidth = "100%";
        img.style.display = "block";
        wrapper.appendChild(img);
        break;
      }
      case "video": {
        const v = document.createElement("video");
        v.src = this.signedUrl;
        v.controls = true;
        v.style.maxWidth = "100%";
        wrapper.appendChild(v);
        break;
      }
      case "audio": {
        const a = document.createElement("audio");
        a.src = this.signedUrl;
        a.controls = true;
        wrapper.appendChild(a);
        break;
      }
      case "embed": {
        const e = document.createElement("embed");
        e.src = this.signedUrl;
        e.type = mimeOf(ext);
        e.style.width = "100%";
        e.style.height = "400px";
        wrapper.appendChild(e);
        break;
      }
      default: {
        const link = document.createElement("a");
        link.href = this.signedUrl;
        link.textContent = this.alt || this.key;
        link.target = "_blank";
        wrapper.appendChild(link);
      }
    }
  }
}

function keyExt(key: string): string {
  const idx = key.lastIndexOf(".");
  return idx >= 0 ? key.slice(idx + 1).toLowerCase() : "";
}

type MediaKind = "img" | "video" | "audio" | "embed" | "link";

function mediaKind(ext: string): MediaKind {
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "img";
  if (["mp4", "mov", "webm", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg", "flac"].includes(ext)) return "audio";
  if (ext === "pdf") return "embed";
  return "link";
}
