import { ossKeyFromImageSource } from "./oss-source";

interface RenderState {
  key: string;
  attribute: "src" | "href";
  appliedUrl?: string;
  sourceMayBeEmpty: boolean;
  cleanups: Map<string, () => void>;
}

const states = new WeakMap<HTMLElement, RenderState>();

export function beginRenderState(
  element: HTMLElement,
  key: string,
  attribute: "src" | "href",
): RenderState {
  const current = states.get(element);
  if (current?.key === key && current.attribute === attribute) return current;
  cleanupRenderState(element);
  const state: RenderState = {
    key,
    attribute,
    sourceMayBeEmpty: false,
    cleanups: new Map(),
  };
  states.set(element, state);
  element.dataset.ossRenderKey = key;
  return state;
}

export function setRenderCleanup(element: HTMLElement, name: string, cleanup: () => void): void {
  const state = states.get(element);
  if (!state) return;
  state.cleanups.get(name)?.();
  state.cleanups.set(name, cleanup);
}

export function markAppliedUrl(element: HTMLElement, url: string, sourceMayBeEmpty = false): void {
  const state = states.get(element);
  if (!state) return;
  state.appliedUrl = url;
  state.sourceMayBeEmpty = sourceMayBeEmpty;
}

export function isCurrentRender(element: HTMLElement, key: string): boolean {
  const state = states.get(element);
  if (!state || state.key !== key) return false;
  const source = element.getAttribute(state.attribute);
  if (source && ossKeyFromImageSource(source) === key) return true;
  if (source && source === state.appliedUrl) return true;
  return !source && state.sourceMayBeEmpty;
}

/** True when a src/href mutation was produced by this renderer, not Markdown editing. */
export function ownsCurrentSource(element: HTMLElement): boolean {
  const state = states.get(element);
  if (!state) return false;
  const source = element.getAttribute(state.attribute);
  return Boolean(source && source === state.appliedUrl) || (!source && state.sourceMayBeEmpty);
}

export function cleanupRenderState(element: HTMLElement): void {
  const state = states.get(element);
  if (!state) return;
  states.delete(element);
  for (const cleanup of state.cleanups.values()) cleanup();
  delete element.dataset.ossRenderKey;
  delete element.dataset.ossSigningKey;
}

export function renderStateKey(element: HTMLElement): string | null {
  return states.get(element)?.key ?? null;
}
