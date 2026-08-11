import esbuild from "esbuild";
import { rmSync } from "node:fs";

rmSync(".test-dist", { recursive: true, force: true });

await esbuild.build({
  entryPoints: [
    "tests/lifecycle.test.ts",
    "tests/config.test.ts",
    "tests/reference/codec.test.ts",
    "tests/oss/errors.test.ts",
    "tests/oss/client.test.ts",
    "tests/oss/signer.test.ts",
    "tests/render/styles.test.ts",
    "tests/render/live-preview.test.ts",
    "tests/render/media-loading.test.ts",
    "tests/render/oss-source.test.ts",
    "tests/render/url-resolver.test.ts",
    "tests/render/architecture.test.ts",
    "tests/render/dom-renderer.test.ts",
    "tests/render/post-processor.test.ts",
    "tests/render/pdf-link.test.ts",
    "tests/render/context-menu.test.ts",
    "tests/upload/links.test.ts",
    "tests/upload/interceptor.test.ts",
    "tests/upload/indicator.test.ts",
    "tests/upload/local-copies.test.ts",
    "tests/upload/manager.test.ts",
    "tests/upload/types.test.ts",
    "tests/delete/watcher.test.ts",
    "tests/audit/reconcile.test.ts",
  ],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  outdir: ".test-dist",
  alias: { obsidian: "./tests/stubs/obsidian.ts" },
  logLevel: "warning",
});
