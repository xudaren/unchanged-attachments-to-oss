import { Menu, Modal, Notice, Plugin, MarkdownView, TFile } from "obsidian";
import { OSS_URL_REGEX } from "../types";

export type AttachmentKind = "img" | "video" | "audio" | "pdf";

export interface AttachmentContextMenuBinder {
  bind(element: HTMLElement, kind: AttachmentKind, url: string, key: string, sourcePath?: string): void;
}

export type ConfirmReferenceRemoval = (
  sourcePath: string,
  key: string,
  label: string,
  removeLocalReference: () => Promise<boolean>,
) => void;

interface ContextData {
  kind: AttachmentKind;
  url: string;
  key: string;
  sourcePath?: string;
}

const TYPE_LABEL: Record<AttachmentKind, string> = {
  img: "图片",
  video: "视频",
  audio: "音频",
  pdf: "PDF",
};

/** OSS 附件专用右键菜单，避免非图片附件继承 Obsidian 的图片菜单。 */
export class OssAttachmentContextMenu implements AttachmentContextMenuBinder {
  private readonly data = new WeakMap<HTMLElement, ContextData>();
  private readonly previewData = new WeakMap<HTMLElement, ContextData>();

  constructor(
    private readonly plugin: Plugin,
    private readonly confirmReferenceRemoval?: ConfirmReferenceRemoval,
  ) {}

  bind(element: HTMLElement, kind: AttachmentKind, url: string, key: string, sourcePath?: string): void {
    this.data.set(element, { kind, url, key, sourcePath });
    if (kind === "img") this.bindImagePreview(element);
    if (element.dataset.ossContextMenuBound === "true") return;
    element.dataset.ossContextMenuBound = "true";
    element.addEventListener("contextmenu", (event) => {
      const current = this.data.get(element);
      if (!current) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.open(event, current);
    });
  }

  private bindImagePreview(image: HTMLElement): void {
    const host = image.closest<HTMLElement>(".image-embed, .internal-embed") ?? image.parentElement;
    if (!host) return;
    const current = this.data.get(image);
    if (current) this.previewData.set(host, current);
    host.classList.add("oss-image-preview-host");
    if (host.querySelector(":scope > .oss-image-zoom-button")) return;

    const button = image.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "oss-image-zoom-button clickable-icon";
    button.setAttribute("aria-label", "放大 OSS 图片");
    button.title = "放大图片";
    button.textContent = "⛶";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const data = this.previewData.get(host);
      if (data) new OssImagePreviewModal(this.plugin, data.url, data.key).open();
    });
    host.appendChild(button);
  }

  private open(event: MouseEvent, data: ContextData): void {
    const label = TYPE_LABEL[data.kind];
    const menu = new Menu();
    menu.addItem((item) => item
      .setTitle(`打开${label}`)
      .setIcon("external-link")
      .onClick(() => window.open(data.url, "_blank", "noopener,noreferrer")));
    menu.addItem((item) => item
      .setTitle(`复制${label}访问链接（会过期）`)
      .setIcon("link")
      .onClick(() => void copyText(data.url, "已复制临时访问链接（签名过期后失效）")));
    menu.addItem((item) => item
      .setTitle("复制 OSS Markdown 引用")
      .setIcon("copy")
      .onClick(() => void copyText(`![](oss://${data.key})`, "已复制 OSS Markdown 引用")));

    const sourcePath = this.resolveSourcePath(data.sourcePath);
    if (sourcePath) {
      menu.addSeparator();
      menu.addItem((item) => item
        .setTitle(`移除${label}引用`)
        .setIcon("trash-2")
        .onClick(() => void this.removeReference(sourcePath, data.key, label)));
    }
    menu.showAtMouseEvent(event);
  }

  private resolveSourcePath(explicit?: string): string | null {
    if (explicit) return explicit;
    return this.plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? null;
  }

  private async removeReference(sourcePath: string, key: string, label: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile) || file.extension !== "md") {
      new Notice("无法确认附件所在 Markdown，未执行移除");
      return;
    }
    const current = await this.plugin.app.vault.cachedRead(file);
    if (!removeOssReference(current, key).removed) {
      new Notice(`未找到当前${label}引用，文档未修改`);
      return;
    }
    if (!this.confirmReferenceRemoval) {
      new Notice("删除服务尚未就绪，本文档引用已保留");
      return;
    }
    this.confirmReferenceRemoval(sourcePath, key, label, async () => {
      let removed = false;
      await this.plugin.app.vault.process(file, (content) => {
        const result = removeOssReference(content, key);
        removed = result.removed;
        return result.content;
      });
      return removed;
    });
  }
}

class OssImagePreviewModal extends Modal {
  constructor(plugin: Plugin, private readonly url: string, private readonly key: string) {
    super(plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass("mod-oss-image-preview");
    this.contentEl.empty();
    const image = this.contentEl.createEl("img", {
      attr: { src: this.url, alt: this.key },
    });
    image.addClass("oss-image-preview-content");
  }
}

export function removeOssReference(content: string, key: string): { content: string; removed: boolean } {
  const re = new RegExp(OSS_URL_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (normalizeKey(match[1]) !== key) continue;
    return {
      content: content.slice(0, match.index) + content.slice(match.index + match[0].length),
      removed: true,
    };
  }
  return { content, removed: false };
}

function normalizeKey(value: string): string {
  try {
    return decodeURIComponent(value.replace(/^\/+/, ""));
  } catch {
    return value.replace(/^\/+/, "");
  }
}

async function copyText(value: string, successMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    new Notice(successMessage);
  } catch {
    new Notice("复制失败，请检查系统剪贴板权限");
  }
}
