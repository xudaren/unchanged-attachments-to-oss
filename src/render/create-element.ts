/**
 * Create an unattached element in the same document as a reference node.
 *
 * Delegates to Obsidian's patched `Node.createEl` helper on the host, then
 * immediately detaches the result so the caller gets a free-standing
 * element whose `ownerDocument` matches the host's. This is the only path
 * the `obsidianmd/prefer-create-el` lint rule accepts, so every Node that
 * flows through this function (including unit-test mocks) must expose the
 * patched `createEl` helper.
 */
export function createElementLike<K extends keyof HTMLElementTagNameMap>(
  host: Node,
  tag: K,
  options?: DomElementInfo | string,
): HTMLElementTagNameMap[K] {
  const element = host.createEl(tag, options);
  element.remove?.();
  return element;
}
