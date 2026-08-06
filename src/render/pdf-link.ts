export interface PdfRenderer {
  mount(from: Element, url: string, key: string, displayName?: string): HTMLElement;
}

export function buildPdfLink(doc: Document, url: string, key: string, displayName?: string): HTMLElement {
  const attachment = doc.createElement("div");
  attachment.className = "oss-pdf-attachment";
  attachment.dataset.ossKey = key;

  const badge = doc.createElement("span");
  badge.className = "oss-pdf-badge";
  badge.textContent = "PDF";

  const details = doc.createElement("span");
  details.className = "oss-pdf-details";

  const name = doc.createElement("span");
  name.className = "oss-pdf-name";
  name.textContent = normalizeDisplayName(displayName) || decodeFileName(key);
  name.title = name.textContent;

  const meta = doc.createElement("span");
  meta.className = "oss-pdf-meta";
  meta.textContent = "PDF 文档";
  details.append(name, meta);

  const open = doc.createElement("a");
  open.className = "oss-pdf-open";
  open.href = url;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.title = `打开 ${name.textContent}`;
  open.textContent = "打开 ↗";

  attachment.append(badge, details, open);
  return attachment;
}

export const defaultPdfRenderer: PdfRenderer = {
  mount(from, url, key, displayName) {
    return buildPdfLink(from.ownerDocument, url, key, displayName ?? displayNameFromElement(from));
  },
};

export function displayNameFromElement(element: Element): string {
  return normalizeDisplayName(element.getAttribute("alt") ?? element.textContent ?? "");
}

function normalizeDisplayName(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

function decodeFileName(key: string): string {
  const encoded = key.slice(key.lastIndexOf("/") + 1) || key;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}
