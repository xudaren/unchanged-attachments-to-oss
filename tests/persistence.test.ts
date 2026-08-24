import assert from "node:assert/strict";
import test from "node:test";
import { createPersistedSettingsSnapshot, persistOrRetry } from "../src/persistence";
import { DEFAULT_SETTINGS } from "../src/types";

test("persistence strips runtime plaintext credentials once encrypted storage is active", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    accessKeyId: "plaintext-id",
    accessKeySecret: "plaintext-secret",
    encryptedCredentials: {
      version: 1 as const,
      kdf: "PBKDF2-SHA256" as const,
      iterations: 600_000,
      salt: "c2FsdHNhbHRzYWx0c2FsdA==",
      iv: "aXYxMjM0NTY3ODkw",
      ciphertext: "Y2lwaGVydGV4dC13aXRoLXRhZw==",
    },
  };
  const snapshot = createPersistedSettingsSnapshot(settings, false);
  assert.equal("accessKeyId" in snapshot, false);
  assert.equal("accessKeySecret" in snapshot, false);
  assert.equal(snapshot.encryptedCredentials?.ciphertext, settings.encryptedCredentials.ciphertext);
  assert.equal(settings.accessKeySecret, "plaintext-secret");
});

test("persistence preserves a legacy plaintext file until encrypted migration succeeds", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    accessKeyId: "legacy-id",
    accessKeySecret: "legacy-secret",
  };
  const snapshot = createPersistedSettingsSnapshot(settings, true);
  assert.equal(snapshot.accessKeyId, "legacy-id");
  assert.equal(snapshot.accessKeySecret, "legacy-secret");
});

test("public read toggle defaults off and persists as a non-sensitive setting", () => {
  assert.equal(DEFAULT_SETTINGS.publicRead, false);
  const snapshot = createPersistedSettingsSnapshot({ ...DEFAULT_SETTINGS, publicRead: true }, false);
  assert.equal(snapshot.publicRead, true);
});

test("retired access domains persist so references survive a restart", () => {
  assert.deepEqual(DEFAULT_SETTINGS.retiredAccessDomains, []);
  const snapshot = createPersistedSettingsSnapshot(
    { ...DEFAULT_SETTINGS, retiredAccessDomains: ["old-cdn.example.com"] },
    false,
  );
  assert.deepEqual(snapshot.retiredAccessDomains, ["old-cdn.example.com"]);
});

test("persistOrRetry returns on the first successful save", async () => {
  let calls = 0;
  await persistOrRetry(async () => { calls++; });
  assert.equal(calls, 1);
});

test("persistOrRetry recovers from a single transient save failure", async () => {
  let calls = 0;
  await persistOrRetry(async () => {
    calls++;
    if (calls === 1) throw new Error("disk full");
  });
  assert.equal(calls, 2);
});

test("persistOrRetry surfaces the latest error after exhausting retries", async () => {
  let calls = 0;
  await assert.rejects(
    persistOrRetry(async () => {
      calls++;
      throw new Error(`fail-${calls}`);
    }),
    /fail-2/,
  );
  assert.equal(calls, 2);
});
