import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("manifest 只增加精确 loopback host permission 并保留法院 MV3 配置", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "extension", "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.host_permissions.includes("https://zxfw.court.gov.cn/*"));
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1:8765/*"));
  assert.equal(manifest.host_permissions.includes("http://*/*"), false);
  assert.equal(manifest.host_permissions.includes("http://localhost/*"), false);
  assert.deepEqual(manifest.background, { service_worker: "service-worker.js", type: "module" });
  assert.ok(manifest.content_scripts.some((entry) => entry.matches.includes("https://zxfw.court.gov.cn/*")));
});
