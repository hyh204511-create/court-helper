import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("manifest 保持最小权限并以 Options/Setup 取代 Popup", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "extension", "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.host_permissions.includes("https://zxfw.court.gov.cn/*"));
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1:8765/*"));
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1:3000/*"));
  assert.ok(manifest.permissions.includes("debugger"));
  assert.ok(manifest.permissions.includes("alarms"));
  assert.equal(manifest.host_permissions.includes("http://*/*"), false);
  assert.equal(manifest.host_permissions.includes("http://localhost/*"), false);
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
  assert.deepEqual(manifest.background, { service_worker: "service-worker.js", type: "module" });
  assert.deepEqual(manifest.action, { default_title: "法院立案/强执查询助手" });
  assert.deepEqual(manifest.options_ui, { page: "options/setup.html", open_in_tab: true });
  assert.ok(manifest.content_scripts.some((entry) => entry.matches.includes("https://zxfw.court.gov.cn/*")));
  assert.equal(existsSync(join(ROOT, "extension", "popup")), false);
  assert.equal(existsSync(join(ROOT, "extension", "dist", "popup.bundle.js")), false);

  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.doesNotMatch(packageJson.scripts.build, /popup/i);

  const serviceWorker = readFileSync(join(ROOT, "extension", "service-worker.js"), "utf8");
  assert.match(serviceWorker, /chrome\.action\.onClicked\.addListener/);
  assert.match(serviceWorker, /routeExtensionAction/);
});
