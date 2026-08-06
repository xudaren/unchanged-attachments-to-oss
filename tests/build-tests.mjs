import esbuild from "esbuild";
import { rmSync } from "node:fs";

rmSync(".test-dist", { recursive: true, force: true });

await esbuild.build({
  entryPoints: [
    "tests/oss/errors.test.ts",
    "tests/oss/client.test.ts",
    "tests/oss/signer.test.ts",
    "tests/render/styles.test.ts",
    "tests/render/live-preview.test.ts",
    "tests/render/oss-source.test.ts",
    "tests/render/url-resolver.test.ts",
    "tests/render/architecture.test.ts",
    "tests/render/dom-renderer.test.ts",
    "tests/render/post-processor.test.ts",
    "tests/render/pdf-link.test.ts",
  ],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  outdir: ".test-dist",
  alias: { obsidian: "./tests/stubs/obsidian.ts" },
  logLevel: "warning",
});
