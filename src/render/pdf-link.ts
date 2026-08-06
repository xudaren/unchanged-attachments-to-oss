export interface PdfRenderer {
  mount(from: Element, url: string, key: string): HTMLElement;
}

export function buildPdfLink(doc: Document, url: string, key: string): HTMLElement {
  const attachment = doc.createElement("div");
  attachment.className = "oss-pdf-attachment";
  attachment.dataset.ossKey = key;

  const name = doc.createElement("span");
  name.className = "oss-pdf-name";
  name.textContent = decodeFileName(key);

  const open = doc.createElement("a");
  open.className = "oss-pdf-open";
  open.href = url;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.textContent = "浏览器打开";

  attachment.append(name, open);
  return attachment;
}

export const defaultPdfRenderer: PdfRenderer = {
  mount(from, url, key) {
    return buildPdfLink(from.ownerDocument, url, key);
  },
};

function decodeFileName(key: string): string {
  const encoded = key.slice(key.lastIndexOf("/") + 1) || key;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}
