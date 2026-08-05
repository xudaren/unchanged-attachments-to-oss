# OSS Render Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove whole-document render scans and duplicate signing while preserving OSS media rendering in notes and Canvas.

**Architecture:** A shared resolver deduplicates signed URL generation and keys cached entries by OSS configuration. A single plugin-level observer processes only changed or added DOM nodes; Reading View keeps its official Markdown post processor.

**Tech Stack:** TypeScript, Obsidian API, MutationObserver, Web Crypto, Node test runner, esbuild.

---

### Task 1: Shared signed URL resolver

**Files:**
- Create: `src/render/url-resolver.ts`
- Create: `tests/render/url-resolver.test.ts`
- Modify: `tests/build-tests.mjs`

- [x] Write tests proving cache identity includes bucket/host/key and concurrent resolves invoke signing once.
- [x] Run `npm.cmd test` and confirm the new tests fail because the resolver does not exist.
- [x] Implement `SignedUrlResolver` with LRU lookup, in-flight Promise storage, and `clear()`.
- [x] Run `npm.cmd test` and confirm the resolver tests pass.

### Task 2: Incremental DOM mutation routing

**Files:**
- Create: `src/render/dom-renderer.ts`
- Create: `tests/render/dom-renderer.test.ts`
- Modify: `src/main.ts`
- Modify: `src/render/post-processor.ts`
- Modify: `tests/build-tests.mjs`

- [x] Write tests proving attribute mutations process only their image target and child-list mutations process only added subtrees.
- [x] Run `npm.cmd test` and confirm the tests fail before implementation.
- [x] Implement mutation routing plus image/video/audio/PDF hydration using the shared resolver.
- [x] Replace the whole-document observer callback and connect Reading View to the resolver.
- [x] Remove CM6 widget and editor-local observer registration.
- [x] Run `npm.cmd test` and confirm all tests pass.

### Task 3: Cache lifecycle and verification

**Files:**
- Modify: `src/settings.ts`
- Modify: `src/main.ts`
- Modify: `tests/render/live-preview.test.ts`

- [x] Clear the resolver after credential or signed-expiry configuration changes.
- [x] Run `npm.cmd test`, `npm.cmd run typecheck`, and `npm.cmd run build`.
- [x] Deploy `main.js` and `styles.css` to the test Vault and verify their hashes match.
- [x] Reload Obsidian and verify both the note and Canvas card render without broken images.

### Task 4: Rendering responsibility and startup hardening

**Files:**
- Modify: `src/main.ts`
- Modify: `src/render/dom-renderer.ts`
- Modify: `src/render/post-processor.ts`
- Modify: `tests/render/architecture.test.ts`
- Modify: `tests/render/dom-renderer.test.ts`

- [x] Write failing tests for `onLayoutReady`, fallback-surface filtering, and per-node error isolation.
- [x] Register the observer after layout ready and filter candidates to Live Preview/Canvas surfaces.
- [x] Change Reading View batching to `Promise.allSettled` and keep failures local to each node.
- [x] Run the render test suite and confirm all tests pass.

### Task 5: Web Crypto import reuse

**Files:**
- Modify: `src/oss/signer.ts`
- Create: `tests/oss/signer.test.ts`
- Modify: `tests/build-tests.mjs`

- [x] Write a failing test proving repeated signatures with one secret import one HMAC key.
- [x] Add a bounded imported-key cache that switches with the active secret and clears on unload.
- [x] Run tests, typecheck, build, deploy, and verify note/Canvas rendering.

### Task 6: Configuration and lifecycle race hardening

**Files:**
- Modify: `src/render/url-resolver.ts`
- Create: `src/render/error-state.ts`
- Modify: `src/render/dom-renderer.ts`
- Modify: `src/render/post-processor.ts`
- Modify: `src/settings.ts`
- Modify: `src/main.ts`

- [x] Redirect stale-generation success and failure consumers to current settings.
- [x] Reject incomplete AK/SK configuration before signing and keep a visible, retryable error state.
- [x] Guard async node writes and batch errors by current object key; isolate Canvas to one rendering owner.
- [x] Invalidate signing state before persistence awaits and guard unload-before-layout-ready.
- [x] Run full verification and deploy matching production artifacts.
