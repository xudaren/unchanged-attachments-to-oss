import { Menu, Modal, Notice, Plugin, TFile } from "obsidian";
import { removeFirstOssReference, scanOssReferences } from "../reference/codec";
import type { LeaseUrlResolver } from "./url-resolver";
import { isUrlResolverDisposed, resolveUrlLease } from "./url-resolver";
import { createElementInDocument } from "./create-element";

export type AttachmentKind = "img" | "video" | "audio" | "pdf";

export interface AttachmentContextMenuBinder {
  bind(element: HTMLElement, kind: AttachmentKind, url: string, key: string, sourcePath?: string): void;
  unbind?(element: HTMLElement): void;
  sourcePathFor?(element: HTMLElement, key: string): string | undefined;
  dispose?(): void;
}

export type ConfirmReferenceRemoval = (
  sourcePath: string,
  key: string,
  label: string,
  removeLocalReference: () => Promise<boolean>,
) => void;

interface ContextData {
  kind: AttachmentKind;
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
  private readonly listeners = new WeakMap<HTMLElement, (event: MouseEvent) => void>();
  private readonly previewBindings = new WeakMap<HTMLElement, { host: HTMLElement; button: HTMLButtonElement }>();
  private readonly ownedPreviewButtons = new WeakSet<HTMLButtonElement>();
  private readonly lifetime = new AbortController();
  private readonly openMenus = new Set<Menu>();
  private readonly previewModals = new Set<OssImagePreviewModal>();
  private active = true;

  constructor(
    private readonly plugin: Plugin,
    private readonly confirmReferenceRemoval?: ConfirmReferenceRemoval,
    private readonly explicitResolver?: LeaseUrlResolver,
  ) {}

  bind(element: HTMLElement, kind: AttachmentKind, _url: string, key: string, sourcePath?: string): void {
    if (!this.active) return;
    this.data.set(element, { kind, key, sourcePath });
    if (kind === "img") this.bindImagePreview(element);
    if (this.listeners.has(element)) return;
    element.dataset.ossContextMenuBound = "true";
    const listener = (event: MouseEvent) => {
      const current = this.data.get(element);
      if (!current) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.open(event, element, current);
    };
    this.listeners.set(element, listener);
    element.addEventListener("contextmenu", listener, { signal: this.lifetime.signal });
  }

  unbind(element: HTMLElement): void {
    this.data.delete(element);
    const listener = this.listeners.get(element);
    if (listener) element.removeEventListener("contextmenu", listener);
    this.listeners.delete(element);
    delete element.dataset.ossContextMenuBound;
    const preview = this.previewBindings.get(element);
    if (preview) {
      if (preview.button.isConnected || preview.button.parentElement) preview.button.remove();
      this.previewData.delete(preview.host);
      if (!preview.host.querySelector?.(".oss-image-zoom-button")) {
        preview.host.classList.remove("oss-image-preview-host");
      }
    }
    this.previewBindings.delete(element);
  }

  sourcePathFor(element: HTMLElement, key: string): string | undefined {
    if (!this.active) return undefined;
    const current = this.data.get(element);
    return current?.key === key ? current.sourcePath : undefined;
  }

  /** Irreversibly release this plugin instance, including detached DOM listeners and overlays. */
  dispose(): void {
    if (!this.active) return;
    this.active = false;
    this.lifetime.abort();
    for (const menu of [...this.openMenus]) menu.close();
    this.openMenus.clear();
    for (const modal of [...this.previewModals]) modal.close();
    this.previewModals.clear();
  }

  private bindImagePreview(image: HTMLElement): void {
    if (!this.active) return;
    const host = image.closest<HTMLElement>(".image-embed, .internal-embed") ?? image.parentElement;
    if (!host) return;
    const current = this.data.get(image);
    if (current) this.previewData.set(host, current);
    host.classList.add("oss-image-preview-host");
    const previous = this.previewBindings.get(image);
    if (previous?.host === host) {
      const current = this.data.get(image);
      if (current) this.previewData.set(host, current);
      return;
    }
    if (previous) this.unbindImagePreview(image, previous);

    const existing = host.querySelector<HTMLButtonElement>(":scope > .oss-image-zoom-button");
    if (existing && this.ownedPreviewButtons.has(existing)) {
      this.previewBindings.set(image, { host, button: existing });
      return;
    }
    // A hot-reloaded instance must not reuse the previous instance's button:
    // its AbortSignal has already invalidated that detached click listener.
    existing?.remove();

    const button = createElementInDocument(image.ownerDocument, "button");
    this.ownedPreviewButtons.add(button);
    button.type = "button";
    button.className = "oss-image-zoom-button clickable-icon";
    button.setAttribute("aria-label", "放大 OSS 图片");
    button.title = "放大图片";
    button.textContent = "⛶";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!this.active) return;
      const data = this.previewData.get(host);
      if (!data) return;
      let modal!: OssImagePreviewModal;
      modal = new OssImagePreviewModal(
        this.plugin,
        this.getResolver(),
        data.key,
        () => this.active,
        () => this.previewModals.delete(modal),
      );
      this.previewModals.add(modal);
      modal.open();
    }, { signal: this.lifetime.signal });
    host.appendChild(button);
    this.previewBindings.set(image, { host, button });
  }

  private unbindImagePreview(image: HTMLElement, binding: { host: HTMLElement; button: HTMLButtonElement }): void {
    binding.button.remove();
    this.previewData.delete(binding.host);
    binding.host.classList.remove("oss-image-preview-host");
    this.previewBindings.delete(image);
  }

  private open(event: MouseEvent, element: HTMLElement, data: ContextData): void {
    if (!this.active) return;
    const label = TYPE_LABEL[data.kind];
    const menu = new Menu();
    this.openMenus.add(menu);
    menu.onHide(() => this.openMenus.delete(menu));
    menu.addItem((item) => item
      .setTitle(`打开${label}`)
      .setIcon("external-link")
      .onClick(() => {
        if (this.active) void this.openSignedUrl(element, data);
      }));
    const sourcePath = this.resolveSourcePath(element, data.sourcePath);
    if (sourcePath) {
      menu.addSeparator();
      menu.addItem((item) => item
        .setTitle(`删除${label}…`)
        .setIcon("trash-2")
        .onClick(() => {
          if (this.active) void this.removeReference(sourcePath, data.key, label);
        }));
    }
    if (!this.active) {
      menu.close();
      return;
    }
    menu.showAtMouseEvent(event);
  }

  /** Resolve Live Preview ownership by DOM containment instead of guessing from the active view. */
  private resolveSourcePath(element: HTMLElement, boundSourcePath?: string): string | null {
    if (boundSourcePath) return boundSourcePath;
    const leaves = this.plugin.app.workspace.getLeavesOfType("markdown") as unknown as Array<{
      view?: { containerEl?: HTMLElement; file?: TFile | null };
    }>;
    const paths = new Set<string>();
    for (const leaf of leaves) {
      const view = leaf.view;
      const file = view?.file;
      if (file instanceof TFile && file.extension === "md" && view?.containerEl?.contains(element)) {
        paths.add(file.path);
      }
    }
    return paths.size === 1 ? [...paths][0] : null;
  }

  private getResolver(): LeaseUrlResolver {
    if (!this.active) throw new Error("OSS 附件菜单已停止");
    const resolver = this.explicitResolver ?? (this.plugin as Plugin & { urlResolver?: LeaseUrlResolver }).urlResolver;
    if (!resolver) throw new Error("OSS 签名服务尚未就绪");
    return resolver;
  }

  private isCurrent(element: HTMLElement, data: ContextData): boolean {
    return this.active && this.data.get(element)?.key === data.key;
  }

  private async openSignedUrl(element: HTMLElement, data: ContextData): Promise<void> {
    if (!this.active) return;
    const popup = element.ownerDocument.defaultView?.open("", "_blank", "noopener,noreferrer") ?? null;
    try {
      const lease = await resolveUrlLease(this.getResolver(), data.key);
      if (!this.isCurrent(element, data)) {
        popup?.close();
        return;
      }
      if (popup) popup.location.replace(lease.url);
      else window.open(lease.url, "_blank", "noopener,noreferrer");
    } catch {
      popup?.close();
      new Notice("无法生成临时访问链接，请检查 OSS 配置");
    }
  }

  private async removeReference(sourcePath: string, key: string, label: string): Promise<void> {
    if (!this.active) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile) || file.extension !== "md") {
      new Notice("无法确认附件所在 Markdown，未执行移除");
      return;
    }
    const current = await this.plugin.app.vault.cachedRead(file);
    if (!this.active) return;
    const matches = scanOssReferences(current).filter((reference) => reference.key === key);
    if (matches.length === 0) {
      new Notice(`未找到当前${label}引用，文档未修改`);
      return;
    }
    if (matches.length !== 1) {
      new Notice(`本文档有多个相同${label}引用，无法确认当前实例，未执行移除`);
      return;
    }
    if (!this.confirmReferenceRemoval) {
      new Notice("删除服务尚未就绪，本文档引用已保留");
      return;
    }
    this.confirmReferenceRemoval(sourcePath, key, label, async () => {
      if (!this.active) return false;
      let removed = false;
      await this.plugin.app.vault.process(file, (content) => {
        const currentMatches = scanOssReferences(content).filter((reference) => reference.key === key);
        const result = currentMatches.length === 1
          ? removeOssReference(content, key)
          : { content, removed: false };
        removed = result.removed;
        return result.content;
      });
      return removed;
    });
  }
}

class OssImagePreviewModal extends Modal {
  private closed = false;

  constructor(
    plugin: Plugin,
    private readonly resolver: LeaseUrlResolver,
    private readonly key: string,
    private readonly isOwnerActive: () => boolean,
    private readonly release: () => void,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    if (!this.isOwnerActive() || isUrlResolverDisposed(this.resolver)) {
      this.close();
      return;
    }
    this.modalEl.addClass("mod-oss-image-preview");
    this.contentEl.empty();
    const image = this.contentEl.createEl("img", { attr: { alt: this.key } });
    image.addClass("oss-image-preview-content");
    void resolveUrlLease(this.resolver, this.key).then(
      (lease) => {
        if (!this.closed && this.isOwnerActive() && !isUrlResolverDisposed(this.resolver) && image.isConnected) {
          image.src = lease.url;
        }
      },
      () => {
        if (!this.closed && this.isOwnerActive() && image.isConnected) {
          image.replaceWith(image.ownerDocument.createTextNode("图片预览链接生成失败"));
        }
      },
    );
  }

  onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.contentEl.empty();
    this.release();
  }
}

export function removeOssReference(content: string, key: string): { content: string; removed: boolean } {
  return removeFirstOssReference(content, key);
}
