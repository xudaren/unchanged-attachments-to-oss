import { MarkdownPostProcessorContext } from "obsidian";
import { PluginSettings } from "../types";
import {
  hydrateOssSubtree,
  RENDER_SURFACE_SELECTOR,
} from "./dom-renderer";
import { SignedUrlResolver } from "./url-resolver";
import { defaultPdfRenderer, PdfRenderer } from "./pdf-link";
import type { AttachmentContextMenuBinder } from "./context-menu";
import type { RenderSessionLifetime } from "./lifetime";

/** Reading View owns only its current rendered fragment; Live Preview/Canvas use the observer. */
export function createOssPostProcessor(
  _settings: PluginSettings,
  resolver: SignedUrlResolver,
  pdfRenderer: PdfRenderer = defaultPdfRenderer,
  contextMenu?: AttachmentContextMenuBinder,
  lifetime?: RenderSessionLifetime,
) {
  return async function processor(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    if ((lifetime && !lifetime.isActive) || el.closest(RENDER_SURFACE_SELECTOR)) return;
    const scopedMenu = contextMenu ? withSourcePath(contextMenu, ctx.sourcePath) : undefined;
    await hydrateOssSubtree(el, resolver, pdfRenderer, scopedMenu, lifetime);
  };
}

function withSourcePath(
  contextMenu: AttachmentContextMenuBinder,
  sourcePath: string,
): AttachmentContextMenuBinder {
  return {
    bind(element, kind, url, key) {
      contextMenu.bind(element, kind, url, key, sourcePath);
    },
    unbind(element) {
      contextMenu.unbind?.(element);
    },
    sourcePathFor() {
      return sourcePath;
    },
  };
}
