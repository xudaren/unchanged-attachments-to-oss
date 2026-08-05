# OSS Render Performance Design

## Goal

Keep OSS media rendering correct in Reading View, Live Preview, and Canvas while removing whole-document rescans and duplicate signing work.

## Architecture

- Reading View remains on Obsidian's Markdown post processor.
- Live Preview and Canvas share one plugin-level `MutationObserver`, registered after `workspace.onLayoutReady`, because Obsidian creates native `oss://` image nodes asynchronously in both surfaces.
- The observer consumes only each `MutationRecord` target and added nodes; it never rescans `document` after startup.
- Observer candidates must belong to `.markdown-source-view` or `.canvas-node`; Reading View and unrelated Obsidian UI are excluded.
- A shared `SignedUrlResolver` owns configuration-aware LRU lookup and in-flight Promise deduplication.
- The CM6 widget path and editor-local observer are removed; the post processor explicitly skips Live Preview/Canvas so each DOM node has one rendering owner.
- Web Crypto HMAC keys are imported once per active secret and reused until credentials change.

## Data flow

1. A renderer discovers an `oss://` media node and restores its original object key.
2. `SignedUrlResolver.resolve(key)` builds a cache identity from bucket, signed host, and key.
3. It returns a valid cached URL, joins an in-flight signing Promise, or creates one Web Crypto signature.
4. Before writing, the renderer verifies that the node still owns the same object key, then changes its URL or replaces an image placeholder with video/audio/embed.

## Error and lifecycle handling

- Signing failures are isolated per element, set a visible OSS-specific fallback message, and clear the in-progress marker so a later render can retry.
- Reading View waits with `Promise.allSettled`; one failed media node never rejects the full Markdown section.
- Missing Bucket/AK/SK fails before signing and preserves the retryable `oss://` source.
- Plugin unload disconnects the one observer; a deferred layout-ready callback checks the disposed flag before creating it.
- Credential, endpoint, CNAME, or expiry changes clear resolved and in-flight entries before the first persistence await. Older generation consumers re-resolve with current settings after either success or failure.

## Verification

- Unit-test configuration-aware cache keys and concurrent request deduplication.
- Unit-test mutation selection so unrelated mutations do not trigger document scans.
- Unit-test surface filtering so Reading View and unrelated UI never enter the fallback observer.
- Unit-test HMAC key reuse and per-element failure isolation.
- Unit-test stale success/failure generation redirects, unconfigured state, node reuse races, visible fallback state, and LRU updates.
- Retain Chinese normalized `oss:///%E8...` parsing tests.
- Run tests, TypeScript checking, production build, deploy, then manually verify one note and one Canvas file card.
