import { createElementInDocument } from "./create-element";

const errorMarkers = new WeakMap<Element, HTMLElement>();

/** Show one reusable, visible error marker without destroying the retryable OSS source. */
export function showOssRenderError(element: Element, key: string, message: string): void {
  element.setAttribute("data-oss-render-error", "true");
  let marker = errorMarkers.get(element);
  if (!marker) {
    marker = createElementInDocument(element.ownerDocument, "span");
    marker.className = "oss-render-error";
    errorMarkers.set(element, marker);
  }
  marker.dataset.ossKey = key;
  marker.textContent = message;
  element.insertAdjacentElement("afterend", marker);
}

/** Remove a previous error marker after the same media node recovers. */
export function clearOssRenderError(element: Element): void {
  const marker = errorMarkers.get(element);
  if (marker) marker.remove();
  errorMarkers.delete(element);
  element.removeAttribute("data-oss-render-error");
}
