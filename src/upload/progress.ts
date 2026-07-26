import { Plugin } from "obsidian";

/**
 * 上传进度状态栏：
 * - 上传时显示 ↑ 文件名 (n/total) XX%
 * - 空闲时隐藏
 */
export class UploadProgressBar {
  private readonly el: HTMLElement;
  private total = 0;
  private current = 0;
  private fileName = "";

  constructor(plugin: Plugin) {
    this.el = plugin.addStatusBarItem();
    this.el.style.display = "none";
  }

  begin(fileName: string, totalParts: number): void {
    this.fileName = fileName;
    this.total = totalParts;
    this.current = 0;
    this.render();
    this.el.style.display = "";
  }

  advance(partsDone?: number): void {
    if (partsDone !== undefined) {
      this.current = partsDone;
    } else {
      this.current++;
    }
    this.render();
  }

  finish(): void {
    this.el.style.display = "none";
    this.el.textContent = "";
  }

  private render(): void {
    const pct = this.total > 0 ? Math.round((this.current / this.total) * 100) : 0;
    this.el.textContent = `↑ ${this.fileName} (${this.current}/${this.total}) ${pct}%`;
  }
}
