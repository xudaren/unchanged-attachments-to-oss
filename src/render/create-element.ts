/** Create an unattached element with Obsidian's DOM helper in the source document. */
export function createElementInDocument<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  options?: DomElementInfo | string,
): HTMLElementTagNameMap[K] {
  return doc.createDocumentFragment().createEl(tag, options);
}
