/**
 * A hot-reload-safe lifecycle shared by every loaded copy of the plugin bundle.
 *
 * Obsidian does not await `Plugin.onunload()`. The next bundle must therefore
 * coordinate with the previous bundle through `globalThis`, wait for its root
 * tasks and persistence tail, and only then read data.json.
 */

interface SharedLifecycleOwner {
  readonly generation: number;
  quiesce(): void;
  drain(): Promise<void>;
}

interface SharedLifecycleCoordinator {
  generation: number;
  active: SharedLifecycleOwner | null;
  activationTail: Promise<void>;
  persistenceTail: Promise<void>;
}

export interface LifecycleGate {
  readonly isActive: boolean;
  assertActive(context?: string): void;
  run<T>(factory: () => Promise<T> | T): Promise<T>;
  track<T>(task: Promise<T>): Promise<T>;
  onQuiesce(listener: () => void): () => void;
}

export class LifecycleQuiescedError extends Error {
  constructor(context = "继续执行异步操作") {
    super(`插件已进入停止阶段，已阻止${context}`);
    this.name = "LifecycleQuiescedError";
  }
}

export class StaleLifecycleGenerationError extends LifecycleQuiescedError {
  constructor() {
    super("旧实例写入 data.json");
    this.name = "StaleLifecycleGenerationError";
  }
}

export class PluginLifecycle implements LifecycleGate, SharedLifecycleOwner {
  private readonly tasks = new Set<Promise<unknown>>();
  private quiescing = false;
  private drained = false;
  private drainPromise: Promise<void> | null = null;
  private readonly quiesceListeners = new Set<() => void>();

  private constructor(
    private readonly coordinator: SharedLifecycleCoordinator,
    readonly generation: number,
  ) {}

  /** Serialize activation across old and new bundle copies. */
  static activate(pluginId: string): Promise<PluginLifecycle> {
    const coordinator = getCoordinator(pluginId);
    let resolveActivation!: (value: PluginLifecycle) => void;
    let rejectActivation!: (reason?: unknown) => void;
    const result = new Promise<PluginLifecycle>((resolve, reject) => {
      resolveActivation = resolve;
      rejectActivation = reject;
    });
    const activation = coordinator.activationTail.then(async () => {
      const previous = coordinator.active;
      if (previous) {
        previous.quiesce();
        await previous.drain();
      }
      await waitForStablePersistenceTail(coordinator);
      const lifecycle = new PluginLifecycle(coordinator, ++coordinator.generation);
      coordinator.active = lifecycle;
      resolveActivation(lifecycle);
    }).catch(rejectActivation);
    coordinator.activationTail = activation.then(() => undefined, () => undefined);
    return result;
  }

  get isActive(): boolean {
    return !this.quiescing && !this.drained && this.isCurrentGeneration();
  }

  assertActive(context?: string): void {
    if (!this.isActive) throw new LifecycleQuiescedError(context);
  }

  /**
   * Invoke the factory synchronously so paste/drop handlers snapshot OS-backed
   * File handles before the event becomes invalid, then track its async tail.
   */
  run<T>(factory: () => Promise<T> | T): Promise<T> {
    try {
      this.assertActive();
      return this.track(Promise.resolve(factory()));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Track an already-authorized root task. Tasks already running may finish durability work. */
  track<T>(task: Promise<T>): Promise<T> {
    if (this.quiescing) {
      return Promise.reject(new LifecycleQuiescedError("接纳新的异步任务"));
    }
    if (this.drained || !this.isCurrentGeneration()) {
      return Promise.reject(new StaleLifecycleGenerationError());
    }
    const tracked = task.finally(() => {
      this.tasks.delete(tracked);
    });
    this.tasks.add(tracked);
    return tracked;
  }

  /** Stop admitting new work synchronously. */
  quiesce(): void {
    if (this.quiescing) return;
    this.quiescing = true;
    for (const listener of [...this.quiesceListeners]) {
      try {
        listener();
      } catch (error) {
        console.warn("[oss-lifecycle] quiesce listener failed", error);
      }
    }
    this.quiesceListeners.clear();
  }

  onQuiesce(listener: () => void): () => void {
    if (this.quiescing || this.drained || !this.isCurrentGeneration()) {
      listener();
      return () => undefined;
    }
    this.quiesceListeners.add(listener);
    return () => this.quiesceListeners.delete(listener);
  }

  /** Wait for root tasks and every persistence write they enqueued. Never rejects. */
  drain(): Promise<void> {
    this.quiesce();
    if (!this.drainPromise) this.drainPromise = this.waitForDrain();
    return this.drainPromise;
  }

  /**
   * Queue a whole-file data.json snapshot on the cross-bundle persistence lane.
   * A quiescing current generation may still persist safe in-flight outcomes;
   * a drained or superseded generation may never overwrite the new journal.
   */
  enqueuePersistence(write: () => Promise<void>): Promise<void> {
    this.assertCanPersist();
    const run = this.coordinator.persistenceTail.then(async () => {
      this.assertCanPersist();
      await write();
    });
    this.coordinator.persistenceTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async waitForDrain(): Promise<void> {
    for (;;) {
      const tasks = [...this.tasks];
      if (tasks.length > 0) await Promise.allSettled(tasks);
      const persistenceTail = this.coordinator.persistenceTail;
      await persistenceTail.catch(() => undefined);
      if (this.tasks.size === 0 && this.coordinator.persistenceTail === persistenceTail) {
        this.drained = true;
        return;
      }
    }
  }

  private assertCanPersist(): void {
    if (this.drained || !this.isCurrentGeneration()) {
      throw new StaleLifecycleGenerationError();
    }
  }

  private isCurrentGeneration(): boolean {
    return this.coordinator.active === this && this.coordinator.generation === this.generation;
  }
}

function getCoordinator(pluginId: string): SharedLifecycleCoordinator {
  const key = Symbol.for(`${pluginId}:shared-lifecycle`);
  const shared = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = shared[key] as SharedLifecycleCoordinator | undefined;
  if (existing) return existing;
  const coordinator: SharedLifecycleCoordinator = {
    generation: 0,
    active: null,
    activationTail: Promise.resolve(),
    persistenceTail: Promise.resolve(),
  };
  shared[key] = coordinator;
  return coordinator;
}

async function waitForStablePersistenceTail(coordinator: SharedLifecycleCoordinator): Promise<void> {
  for (;;) {
    const tail = coordinator.persistenceTail;
    await tail.catch(() => undefined);
    if (coordinator.persistenceTail === tail) return;
  }
}
