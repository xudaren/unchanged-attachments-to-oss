import assert from "node:assert/strict";
import test from "node:test";
import { createPersistedSettingsSnapshot } from "../src/persistence";
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
