import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("扩展构建经 Node API 解析绝对入口，避免 Windows CLI 路径歧义", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts.build, "node ./scripts/build-extension.mjs");
  const script = await readFile(new URL("../scripts/build-extension.mjs", import.meta.url), "utf8");
  assert.match(script, /entryPoints:\s*\[resolve\(root, "extension", "content", "court-content\.js"\)\]/);
  assert.match(script, /outfile:\s*resolve\(root, "extension", "dist", "court-content\.bundle\.js"\)/);
});
