export function mediaDisplayName(source: Element): string {
  const alt = source.getAttribute("alt")?.trim();
  if (alt) return alt;
  if (source.tagName === "A") return source.textContent?.trim() ?? "";
  return "";
}

/** Add one visible Markdown-alt label without wrapping Obsidian's editable host. */
export function mountMediaLabel(media: HTMLElement, name: string, key: string, host?: Element): HTMLElement | null {
  if (!name) return null;
  const container = resolveMediaContainer(media, host);
  container?.classList?.add("oss-media-caption-host");
  container?.querySelectorAll?.(":scope > .oss-media-label").forEach((label) => {
    if ((label as HTMLElement).dataset.ossKey !== key) label.remove();
  });
  const existing = container?.querySelector?.<HTMLElement>(`:scope > .oss-media-label[data-oss-key="${cssEscape(key)}"]`);
  if (existing) {
    existing.textContent = name;
    existing.title = name;
    return existing;
  }
  const label = media.ownerDocument.createElement("div");
  label.className = "oss-media-label";
  label.dataset.ossKey = key;
  label.textContent = name;
  label.title = name;
  if (container) container.appendChild(label);
  else media.insertAdjacentElement("afterend", label);
  return label;
}

function resolveMediaContainer(media: HTMLElement, explicit?: Element): HTMLElement | null {
  if (explicit) return explicit as HTMLElement;
  const embed = media.closest<HTMLElement>(".image-embed, .internal-embed, .media-embed");
  if (embed) return embed;
  const parent = media.parentElement;
  if (parent?.classList.contains("oss-media-caption-host")) return parent;
  if (!parent) return null;
  const frame = media.ownerDocument.createElement("div");
  frame.className = "oss-media-caption-host";
  frame.dataset.ossMediaFrame = "true";
  media.replaceWith(frame);
  frame.appendChild(media);
  return frame;
}

function cssEscape(value: string): string {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}
