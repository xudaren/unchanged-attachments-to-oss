import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["tests/oss/errors.test.ts", "tests/oss/client.test.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  outdir: ".test-dist",
  alias: { obsidian: "./tests/stubs/obsidian.ts" },
  logLevel: "warning",
});
