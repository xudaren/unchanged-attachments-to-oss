import { createElementLike } from "./create-element";

/**
 * 上传中占位渲染：`oss://uploading/{tempId}` 占位引用在上传期间统一显示
 * 一张带类型徽标、文件名与进度条的卡片，替代浏览器破图。图片、视频、
 * 音频、PDF 共用同一形态；上传完成后引用被替换，卡片随节点重建消失。
 */

const UPLOADING_KEY_PREFIX = "uploading/";
const UPLOADING_ALT_PREFIX = "上传中 ";

export interface UploadingProgressState {
  done: number;
  total: number;
}

type UploadingProgressListener = (state: UploadingProgressState) => void;

// 进度总线：上传侧按 tempId 发布分片进度，占位卡片订阅后实时更新。
const progressStates = new Map<string, UploadingProgressState>();
const progressListeners = new Map<string, Set<UploadingProgressListener>>();

export function publishUploadingProgress(tempId: string, done: number, total: number): void {
  const state = { done, total };
  for (const listener of progressListeners.get(tempId) ?? []) listener(state);
  if (done >= total) progressStates.delete(tempId);
  else progressStates.set(tempId, state);
}

export function currentUploadingProgress(tempId: string): UploadingProgressState | undefined {
  return progressStates.get(tempId);
}

export function subscribeUploadingProgress(
  tempId: string,
  listener: UploadingProgressListener,
): () => void {
  const set = progressListeners.get(tempId) ?? new Set();
  set.add(listener);
  progressListeners.set(tempId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) progressListeners.delete(tempId);
  };
}

/** 插件卸载时释放总线，避免跨热重载代际残留订阅。 */
export function clearUploadingProgressBus(): void {
  progressStates.clear();
  progressListeners.clear();
  commitHandlers.clear();
}

type UploadingCommitHandler = (committedSource: string) => void;

// 提交信号：引用成功落库后上传侧按 tempId 通知，渲染侧把陈旧占位原地
// 换成正式引用；仅靠节点移除被动清理会漏掉不实时重绘的阅读视图等表面。
const commitHandlers = new Map<string, Set<UploadingCommitHandler>>();

export function registerUploadingCommitHandler(
  tempId: string,
  handler: UploadingCommitHandler,
): () => void {
  const set = commitHandlers.get(tempId) ?? new Set();
  set.add(handler);
  commitHandlers.set(tempId, set);
  return () => {
    set.delete(handler);
    if (set.size === 0) commitHandlers.delete(tempId);
  };
}

export function commitUploadingPlaceholder(tempId: string, committedSource: string): void {
  for (const handler of Array.from(commitHandlers.get(tempId) ?? [])) handler(committedSource);
  commitHandlers.delete(tempId);
  progressStates.delete(tempId);
  progressListeners.delete(tempId);
  sweepLeftoverUploadingCards(tempId);
}

/**
 * 兼容兜底：即使会话句柄已丢失（热重载等），也按卡片上的 tempId 标记
 * 直接清扫页面残留。
 */
function sweepLeftoverUploadingCards(tempId: string): void {
  const page = typeof document !== "undefined" ? document : undefined;
  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(tempId)
    : tempId.replace(/["\\]/g, "\\$&");
  const cards = page?.querySelectorAll?.(`.oss-uploading-placeholder[data-oss-uploading-id="${escaped}"]`);
  if (!cards) return;
  for (const card of Array.from(cards)) card.remove();
}

export interface UploadingPlaceholderMount {
  element: HTMLElement;
  dispose: () => void;
}

export function isUploadingKey(key: string): boolean {
  return key.startsWith(UPLOADING_KEY_PREFIX);
}

/**
 * 用占位卡片原位替换 widget 内部的破媒体节点。
 * 禁止把卡片作为 embed 宿主的兄弟节点插入：CodeMirror 6 会周期性剔除
 * contenteditable 内非自身管理的内容，卡片会被清掉导致破图回潮或残留。
 */
export function mountUploadingPlaceholder(media: HTMLElement, key: string): UploadingPlaceholderMount {
  const tempId = key.slice(UPLOADING_KEY_PREFIX.length);
  const swapped = findBrokenMedia(media);
  const name = uploadingDisplayName(swapped);

  const card = createElementLike(media, "div");
  card.className = "oss-uploading-placeholder";
  card.setAttribute("role", "status");
  // tempId 标记支持提交后的全局兜底清扫。
  card.setAttribute("data-oss-uploading-id", tempId);

  const badge = createElementLike(media, "span");
  badge.className = "oss-uploading-badge";
  badge.textContent = badgeText(name);
  badge.setAttribute("aria-hidden", "true");
  const details = createElementLike(media, "span");
  details.className = "oss-uploading-details";
  const nameEl = createElementLike(media, "span");
  nameEl.className = "oss-uploading-name";
  nameEl.textContent = name;
  nameEl.title = name;
  const status = createElementLike(media, "span");
  status.className = "oss-uploading-status";
  status.textContent = "上传中…";
  const bar = createElementLike(media, "span");
  bar.className = "oss-uploading-bar";
  const fill = createElementLike(media, "span");
  fill.className = "oss-uploading-bar-fill";
  bar.append(fill);
  details.append(nameEl, status, bar);
  card.append(badge, details);

  const apply = (state?: UploadingProgressState): void => {
    if (state && state.total > 0) {
      const pct = Math.min(100, Math.round((state.done / state.total) * 100));
      card.classList.remove("oss-uploading-indeterminate");
      status.textContent = `正在上传 OSS… ${pct}%`;
      fill.style.width = `${pct}%`;
    } else {
      card.classList.add("oss-uploading-indeterminate");
      status.textContent = "上传中…";
    }
  };

  const unsubscribe = subscribeUploadingProgress(tempId, apply);
  apply(currentUploadingProgress(tempId));

  // 标记让 observer 把这次主动替换与“节点被删除”区分开，避免 dispose 回声。
  swapped.setAttribute("data-oss-uploading-swapped", "true");
  swapped.replaceWith(card);

  return {
    element: card,
    dispose: () => {
      unsubscribe();
      swapped.removeAttribute("data-oss-uploading-swapped");
      card.replaceWith(swapped);
    },
  };
}

/** 宿主自身是媒体标签就用自身；否则取其内部第一个 oss:// 破媒体节点。 */
function findBrokenMedia(media: HTMLElement): HTMLElement {
  const tag = media.tagName?.toUpperCase?.() ?? "";
  if (tag === "IMG" || tag === "VIDEO" || tag === "AUDIO" || tag === "EMBED") return media;
  const visit = (node: HTMLElement): HTMLElement | null => {
    for (const child of Array.from(node.children ?? []) as HTMLElement[]) {
      const childTag = child.tagName?.toUpperCase?.() ?? "";
      if (
        (childTag === "IMG" || childTag === "VIDEO" || childTag === "AUDIO" || childTag === "EMBED") &&
        (child.getAttribute?.("src") ?? "").startsWith("oss://")
      ) return child;
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(media) ?? media;
}

function uploadingDisplayName(media: HTMLElement): string {
  const alt = media.getAttribute("alt")?.trim() ?? "";
  if (alt.startsWith(UPLOADING_ALT_PREFIX)) {
    const name = alt.slice(UPLOADING_ALT_PREFIX.length).trim();
    if (name) return name;
  }
  return alt || "附件";
}

function badgeText(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";
  if (/^[a-z0-9]{1,4}$/i.test(ext)) return ext.toUpperCase();
  return "OSS";
}
