import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Reading View uses the shared signed URL resolver", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const postProcessor = readFileSync("src/render/post-processor.ts", "utf8");

  assert.match(main, /new SignedUrlResolver\(/);
  assert.match(postProcessor, /resolver\.resolve\(/);
  assert.match(postProcessor, /Promise\.allSettled\(/);
  assert.doesNotMatch(postProcessor, /Promise\.all\(/);
  assert.doesNotMatch(postProcessor, /signedGetUrl/);
  assert.match(postProcessor, /ossKeyFromImageSource/);
  assert.doesNotMatch(postProcessor, /extractOssKey/);
});

test("credential and expiry changes clear all signed URL resolver state", () => {
  const settings = readFileSync("src/settings.ts", "utf8");
  const clears = settings.match(/plugin\.urlResolver\.clear\(\)/g) ?? [];

  assert.equal(clears.length, 2);
  assert.doesNotMatch(settings, /plugin\.urlCache\.clear\(\)/);

  const commitStart = settings.indexOf("plugin.settings.region = region");
  const commitEnd = settings.indexOf("notice.setMessage", commitStart);
  const credentialCommit = settings.slice(commitStart, commitEnd);
  assert.ok(
    credentialCommit.indexOf("plugin.urlResolver.clear()") <
      credentialCommit.indexOf("await plugin.saveSettings()"),
    "credential cache must be cleared before the first persistence await",
  );

  const expiryStart = settings.indexOf("plugin.settings.signedUrlExpireSeconds = n");
  const expiryEnd = settings.indexOf("}", expiryStart);
  const expiryCommit = settings.slice(expiryStart, expiryEnd);
  assert.ok(
    expiryCommit.indexOf("plugin.urlResolver.clear()") <
      expiryCommit.indexOf("await plugin.saveSettings()"),
    "expiry cache must be cleared before the persistence await",
  );
});
