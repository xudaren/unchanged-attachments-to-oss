import assert from "node:assert/strict";
import test from "node:test";
import { RetryIndicator } from "../../src/upload/indicator";

test("requeues only failed entries after a partially successful retry", async () => {
  const element = {
    style: {} as Record<string, string>,
    textContent: "",
    onclick: null as null | (() => void),
    addClass: () => undefined,
    setAttr: () => undefined,
  };
  const plugin = { addStatusBarItem: () => element };
  const first = { tempId: "one", mdPath: "a.md", localPath: "a.png", ext: "png" };
  const second = { tempId: "two", mdPath: "a.md", localPath: "b.png", ext: "png" };
  const indicator = new RetryIndicator(
    plugin as never,
    async () => ({ succeeded: [first], failed: [second] }),
    [first, second],
  );

  element.onclick?.();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(element.textContent, "⚠ 待重试 1 · 点击");
  indicator.push(second);
  assert.equal(element.textContent, "⚠ 待重试 1 · 点击", "same task must be deduplicated by tempId");
});
