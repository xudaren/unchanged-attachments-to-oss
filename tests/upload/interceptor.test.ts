import assert from "node:assert/strict";
import test from "node:test";
import { captureAttachment, formatInputReadError } from "../../src/upload/interceptor";

test("captures an input File into a stable Blob before asynchronous upload", async () => {
  let reads = 0;
  const source = {
    name: "clipboard.png",
    type: "image/png",
    arrayBuffer: async () => {
      reads += 1;
      return new TextEncoder().encode("stable bytes").buffer;
    },
  } as File;

  const captured = await captureAttachment(source);
  assert.equal(reads, 1);
  assert.equal(captured.name, "clipboard.png");
  assert.equal(captured.type, "image/png");
  assert.equal(await captured.blob.text(), "stable bytes");
});

test("turns an unreadable cloud placeholder error into an actionable notice", () => {
  const message = formatInputReadError(new DOMException(
    "The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.",
    "NotReadableError",
  ));
  assert.match(message, /云盘/);
  assert.match(message, /iCloud/);
  assert.match(message, /OneDrive/);
  assert.match(message, /下载到本地/);
  assert.doesNotMatch(message, /permission problems/);
});
