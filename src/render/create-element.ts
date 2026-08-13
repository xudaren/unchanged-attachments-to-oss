/** Create an unattached element with Obsidian's DOM helper in the source document. */
export function createElementInDocument<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  options?: DomElementInfo | string,
): HTMLElementTagNameMap[K] {
  const fragment = doc.createDocumentFragment?.();
  if (fragment?.createEl) return fragment.createEl(tag, options);

  // Minimal document doubles used by unit tests do not include Obsidian's DOM helpers.
  const factory: <T extends keyof HTMLElementTagNameMap>(tagName: T) => HTMLElementTagNameMap[T] =
    Reflect.get(doc, "createElement").bind(doc);
  return factory(tag);
}
