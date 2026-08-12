/** Create an unattached element with Obsidian's DOM helper in the source document. */
export function createElementInDocument<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  options?: DomElementInfo | string,
): HTMLElementTagNameMap[K] {
  const fragment = doc.createDocumentFragment?.();
  if (fragment?.createEl) return fragment.createEl(tag, options);

  // Minimal document doubles used by unit tests do not implement fragments.
  const factory = Reflect.get(doc, "createElement") as (tagName: K) => HTMLElementTagNameMap[K];
  return factory.call(doc, tag);
}
