import { Notice, Plugin } from "obsidian";

/**
 * autoUpload 状态图标：常驻状态栏，展示当前自动上传开关状态。
 * 点击可在设置页外快速切换。
 */
export class AutoUploadIndicator {
  private readonly el: HTMLElement;

  constructor(
    plugin: Plugin,
    private readonly getState: () => boolean,
    private readonly toggle: () => Promise<void>,
  ) {
    this.el = plugin.addStatusBarItem();
    this.el.addClass("oss-autoupload-indicator");
    this.el.style.cursor = "pointer";
    this.el.setAttr("aria-label", "点击切换 OSS 自动上传开关");
    this.el.onclick = async () => {
      await this.toggle();
      this.render();
    };
    this.render();
  }

  /** 由外部（如设置页 toggle 变更）调用以刷新显示 */
  render(): void {
    const on = this.getState();
    this.el.textContent = on ? "🟢 OSS" : "⚪ OSS 暂停";
    this.el.setAttr("title", on ? "OSS 自动上传已开启" : "OSS 自动上传已暂停");
  }
}

/** 拦截路径失败后回写本地的重试项 */
export interface RetryEntry {
  tempId?: string;
  mdPath: string;
  localPath: string;
  ext: string;
  occurrenceId?: string;
}

export interface RetryBatchResult {
  succeeded: RetryEntry[];
  failed: RetryEntry[];
}

/**
 * 上传失败重试图标：拦截路径上传失败并回写本地后，累计"待重试"计数，
 * 点击可触发重试逻辑（外部注入）。列表空时隐藏。
 */
export class RetryIndicator {
  private readonly el: HTMLElement;
  private readonly entries: RetryEntry[] = [];

  constructor(
    plugin: Plugin,
    private readonly onRetry: (entries: RetryEntry[]) => Promise<void | RetryBatchResult>,
    initialEntries: RetryEntry[] = [],
  ) {
    this.entries.push(...initialEntries);
    this.el = plugin.addStatusBarItem();
    this.el.addClass("oss-retry-indicator");
    this.el.style.cursor = "pointer";
    this.el.style.display = "none";
    this.el.onclick = () => void this.triggerRetry();
    this.render();
  }

  /** 登记一条新的失败回写记录 */
  push(entry: RetryEntry): void {
    const key = retryKey(entry);
    if (!this.entries.some((candidate) => retryKey(candidate) === key)) this.entries.push(entry);
    this.render();
  }

  /** 手工清空（例如用户放弃） */
  clear(): void {
    this.entries.length = 0;
    this.render();
  }

  private async triggerRetry(): Promise<void> {
    if (this.entries.length === 0) return;
    const snapshot = this.entries.splice(0, this.entries.length);
    this.render();
    try {
      const result = await this.onRetry(snapshot);
      if (result) this.entries.unshift(...result.failed);
      this.dedupe();
      this.render();
    } catch (err) {
      // 失败项回退到队列
      this.entries.unshift(...snapshot);
      this.render();
      new Notice(`重试失败：${(err as Error).message}`);
    }
  }

  private dedupe(): void {
    const seen = new Set<string>();
    const unique = this.entries.filter((entry) => {
      const key = retryKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    this.entries.splice(0, this.entries.length, ...unique);
  }

  private render(): void {
    if (this.entries.length === 0) {
      this.el.style.display = "none";
      this.el.textContent = "";
      return;
    }
    this.el.style.display = "";
    this.el.textContent = `⚠ 待重试 ${this.entries.length} · 点击`;
    this.el.setAttr("title", "点击重试上传失败并回写本地的附件");
  }
}

function retryKey(entry: RetryEntry): string {
  return entry.tempId ?? `${entry.localPath}\0${entry.mdPath}\0${entry.occurrenceId ?? ""}`;
}
