/**
 * Owns every render session created by one plugin instance, including Reading
 * View fragments that have not yet been attached to the workspace DOM.
 */
export class RenderSessionLifetime {
  private readonly disposers = new Map<HTMLElement, () => void>();
  private active = true;

  get isActive(): boolean {
    return this.active;
  }

  track(element: HTMLElement, dispose: () => void): boolean {
    if (!this.active) {
      dispose();
      return false;
    }
    this.disposers.set(element, dispose);
    return true;
  }

  release(element: HTMLElement): void {
    this.disposers.delete(element);
  }

  snapshot(): HTMLElement[] {
    return this.active ? Array.from(this.disposers.keys()) : [];
  }

  /** Permanently release attached and detached sessions owned by this instance. */
  dispose(): void {
    if (!this.active) return;
    this.active = false;
    const disposers = Array.from(this.disposers.values());
    this.disposers.clear();
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        console.warn("[oss-render] 释放渲染会话失败", error);
      }
    }
  }
}
