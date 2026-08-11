import assert from "node:assert/strict";
import test from "node:test";
import {
  LifecycleQuiescedError,
  PluginLifecycle,
  StaleLifecycleGenerationError,
} from "../src/lifecycle";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("new generation waits for deferred root task and persistence tail", async () => {
  const id = `lifecycle-drain-${crypto.randomUUID()}`;
  const first = await PluginLifecycle.activate(id);
  const task = deferred<void>();
  const persisted = deferred<void>();
  first.track(task.promise);
  const oldSave = first.enqueuePersistence(async () => persisted.promise);

  let activated = false;
  const secondPromise = PluginLifecycle.activate(id).then((value) => {
    activated = true;
    return value;
  });
  for (let attempt = 0; attempt < 10 && first.isActive; attempt++) await Promise.resolve();
  assert.equal(first.isActive, false);
  assert.equal(activated, false);

  task.resolve();
  await Promise.resolve();
  assert.equal(activated, false);
  persisted.resolve();
  await oldSave;
  const second = await secondPromise;
  assert.equal(second.generation, first.generation + 1);
  assert.equal(second.isActive, true);
});

test("quiescing generation can save safe outcome but drained generation cannot save late", async () => {
  const id = `lifecycle-save-${crypto.randomUUID()}`;
  const first = await PluginLifecycle.activate(id);
  const values: string[] = [];
  first.quiesce();
  await first.enqueuePersistence(async () => { values.push("safe-tail"); });
  await first.drain();
  const second = await PluginLifecycle.activate(id);

  assert.throws(
    () => first.enqueuePersistence(async () => { values.push("stale"); }),
    StaleLifecycleGenerationError,
  );
  await second.enqueuePersistence(async () => { values.push("current"); });
  assert.deepEqual(values, ["safe-tail", "current"]);
});

test("run invokes capture synchronously and rejects new work after quiesce", async () => {
  const lifecycle = await PluginLifecycle.activate(`lifecycle-run-${crypto.randomUUID()}`);
  let captured = false;
  const release = deferred<void>();
  const work = lifecycle.run(async () => {
    captured = true;
    await release.promise;
  });
  assert.equal(captured, true);
  lifecycle.quiesce();
  assert.throws(() => lifecycle.assertActive("网络请求"), LifecycleQuiescedError);
  await assert.rejects(lifecycle.run(async () => undefined), LifecycleQuiescedError);
  await assert.rejects(lifecycle.track(Promise.resolve()), LifecycleQuiescedError);
  release.resolve();
  await work;
  await lifecycle.drain();
});
