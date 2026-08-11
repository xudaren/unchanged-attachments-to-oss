import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialPromptMode,
  decryptCredentials,
  encryptCredentials,
  isEncryptedCredentials,
  reencryptCredentials,
} from "../src/credentials";

const credentials = {
  accessKeyId: "LTAI-example",
  accessKeySecret: "secret-value",
};

test("encrypts credentials without persisting plaintext and decrypts with the password", async () => {
  const { encrypted, key } = await encryptCredentials(credentials, "correct horse battery staple", 100_000);
  assert.equal(isEncryptedCredentials(encrypted), true);
  assert.equal(JSON.stringify(encrypted).includes(credentials.accessKeyId), false);
  assert.equal(JSON.stringify(encrypted).includes(credentials.accessKeySecret), false);
  assert.equal(key.extractable, false);
  assert.deepEqual((await decryptCredentials(encrypted, "correct horse battery staple")).credentials, credentials);
});

test("rejects a wrong password and authenticated-ciphertext tampering", async () => {
  const { encrypted } = await encryptCredentials(credentials, "correct horse battery staple", 100_000);
  await assert.rejects(
    decryptCredentials(encrypted, "incorrect password"),
    /主密码错误或凭证密文已损坏/,
  );
  const tampered = {
    ...encrypted,
    ciphertext: `${encrypted.ciphertext.slice(0, -2)}AA`,
  };
  await assert.rejects(
    decryptCredentials(tampered, "correct horse battery staple"),
    /主密码错误或凭证密文已损坏|密文格式/,
  );
});

test("re-encrypts changed credentials with the retained non-exportable key", async () => {
  const created = await encryptCredentials(credentials, "correct horse battery staple", 100_000);
  const changed = { ...credentials, accessKeySecret: "rotated-secret" };
  const encrypted = await reencryptCredentials(changed, created.key, created.encrypted);
  assert.notEqual(encrypted.iv, created.encrypted.iv);
  assert.deepEqual((await decryptCredentials(encrypted, "correct horse battery staple")).credentials, changed);
});

test("requires a meaningful master password", async () => {
  await assert.rejects(encryptCredentials(credentials, "short", 100_000), /至少需要 10 个字符/);
});

test("prompts for legacy migration or encrypted unlock at startup", () => {
  assert.equal(credentialPromptMode({
    hasEncryptedCredentials: false,
    hasRuntimeCredentials: true,
    isUnlocked: false,
  }), "migrate");
  assert.equal(credentialPromptMode({
    hasEncryptedCredentials: true,
    hasRuntimeCredentials: false,
    isUnlocked: false,
  }), "unlock");
  assert.equal(credentialPromptMode({
    hasEncryptedCredentials: true,
    hasRuntimeCredentials: true,
    isUnlocked: true,
  }), null);
});
