import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = process.env.OSS_PLUGIN_TEST_DIR ??
  "/Users/xukai/xukai_workspace/许凯测试oss插件/.obsidian/plugins/unchanged-attachments-to-oss";
const artifacts = ["main.js", "manifest.json", "styles.css"];

await mkdir(targetDir, { recursive: true });
await Promise.all(artifacts.map((name) =>
  copyFile(path.join(projectRoot, name), path.join(targetDir, name)),
));

console.log(`Deployed ${artifacts.join(", ")} to ${targetDir}`);
