import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Reading View uses the shared signed URL resolver", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const postProcessor = readFileSync("src/render/post-processor.ts", "utf8");

  assert.match(main, /new SignedUrlResolver\(/);
  assert.match(postProcessor, /hydrateOssSubtree\(el, resolver/);
  const domRenderer = readFileSync("src/render/dom-renderer.ts", "utf8");
  assert.match(domRenderer, /resolveUrlLease\(resolver, key\)/);
  assert.match(domRenderer, /Promise\.allSettled\(/);
  assert.doesNotMatch(postProcessor, /Promise\.all\(/);
  assert.doesNotMatch(postProcessor, /signedGetUrl/);
  assert.match(domRenderer, /ossKeyFromImageSource/);
  assert.doesNotMatch(postProcessor, /extractOssKey/);
});

test("credential and expiry changes clear all signed URL resolver state", () => {
  const resolver = readFileSync("src/render/url-resolver.ts", "utf8");
  assert.match(resolver, /this\.generation \+= 1/);
  assert.match(resolver, /this\.pending\.clear\(\)/);
  assert.match(resolver, /this\.cache\.clear\(\)/);
});

test("render signing and runtime OSS requests validate current connection fields", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const validations = main.match(
    /normalizeOssConfig\(\{\s*\.\.\.(?:this\.)?settings,\s*objectKeyPrefix: "obsidian",?\s*\}\)/g,
  );

  assert.equal(validations?.length, 2);
});
