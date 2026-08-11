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

/** Reading View and Canvas own their official fragments; only Live Preview uses the observer. */
export function createOssPostProcessor(
  _settings: PluginSettings,
  resolver: SignedUrlResolver,
  pdfRenderer: PdfRenderer = defaultPdfRenderer,
  contextMenu?: AttachmentContextMenuBinder,
  lifetime?: RenderSessionLifetime,
) {
  return async function processor(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    if ((lifetime && !lifetime.isActive) || el.closest(RENDER_SURFACE_SELECTOR)) return;
    // Canvas file nodes do not identify one editable Markdown occurrence, so
    // render their media but never expose the destructive "remove reference" action.
    const sourcePath = el.closest(".canvas-node") ? undefined : ctx.sourcePath;
    const scopedMenu = contextMenu ? withSourcePath(contextMenu, sourcePath) : undefined;
    await hydrateOssSubtree(el, resolver, pdfRenderer, scopedMenu, lifetime);
  };
}

function withSourcePath(
  contextMenu: AttachmentContextMenuBinder,
  sourcePath: string | undefined,
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
