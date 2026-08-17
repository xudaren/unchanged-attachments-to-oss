/**
 * Create an unattached element in the same document as a reference node.
 *
 * Uses Obsidian's patched `Node.createEl` helper when available — this is
 * the preferred path in production code and satisfies the
 * `obsidianmd/prefer-create-el` lint rule. When the receiver has not been
 * patched (for example in unit-test mocks that use a plain
 * `ownerDocument.createElement`), we fall back to the native DOM API on the
 * host's document. The returned element's `ownerDocument` always matches
 * `host.ownerDocument`, so cross-document append remains safe.
 */
export function createElementLike<K extends keyof HTMLElementTagNameMap>(
  host: Node,
  tag: K,
  options?: DomElementInfo | string,
): HTMLElementTagNameMap[K] {
  const patched = (host as { createEl?: (tag: K, options?: DomElementInfo | string) => HTMLElementTagNameMap[K] }).createEl;
  if (typeof patched === "function") {
    const element = patched.call(host, tag, options);
    element.remove();
    return element;
  }
  const doc = (host as unknown as { ownerDocument?: Document }).ownerDocument
    ?? (host as unknown as Document);
  return doc.createElement(tag) as HTMLElementTagNameMap[K];
}
