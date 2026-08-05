import assert from "node:assert/strict";
import test from "node:test";
import { HmacKeyCache } from "../../src/oss/hmac-key-cache";

test("imports one HMAC key for repeated signatures with the active secret", async () => {
  let imports = 0;
  const cache = new HmacKeyCache(async () => {
    imports += 1;
    return {} as CryptoKey;
  });

  const [first, second] = await Promise.all([
    cache.get("same-secret"),
    cache.get("same-secret"),
  ]);
  const third = await cache.get("same-secret");

  assert.equal(imports, 1);
  assert.equal(first, second);
  assert.equal(second, third);
});

test("imports a new HMAC key after the secret changes or the cache is cleared", async () => {
  let imports = 0;
  const cache = new HmacKeyCache(async () => {
    imports += 1;
    return { sequence: imports } as unknown as CryptoKey;
  });

  const first = await cache.get("first-secret");
  const second = await cache.get("second-secret");
  cache.clear();
  const third = await cache.get("second-secret");

  assert.notEqual(first, second);
  assert.notEqual(second, third);
  assert.equal(imports, 3);
});

test("does not retain a rejected key import", async () => {
  let imports = 0;
  const cache = new HmacKeyCache(async () => {
    imports += 1;
    if (imports === 1) throw new Error("temporary import failure");
    return {} as CryptoKey;
  });

  await assert.rejects(cache.get("secret"), /temporary import failure/);
  await cache.get("secret");

  assert.equal(imports, 2);
});
