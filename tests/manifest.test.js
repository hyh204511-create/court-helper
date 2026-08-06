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

  const courtContent = readFileSync(join(ROOT, "extension", "content", "court-content.js"), "utf8");
  assert.doesNotMatch(courtContent, /扩展图标打开面板/);
});

test("Phase 11 相关规格与启动提示不再保留 Popup 业务入口", () => {
  const reportSpec = readFileSync(join(ROOT, "docs", "specs", "report-export-module.md"), "utf8");
  const panelSpec = readFileSync(join(ROOT, "docs", "specs", "panel-module.md"), "utf8");
  const importSpec = readFileSync(join(ROOT, "docs", "specs", "import-batches-module.md"), "utf8");
  const appSpec = readFileSync(join(ROOT, "docs", "specs", "app-module.md"), "utf8");
  const startScript = readFileSync(join(ROOT, "scripts", "start-services.bat"), "utf8");

  assert.doesNotMatch(reportSpec, /popup\s*\/\s*浮动面板|popup\s*与面板|popup「开始查询」/i);
  assert.doesNotMatch(panelSpec, /popup\s*保留|与\s*popup\s*同功能|panel\s*\/\s*popup/i);
  assert.doesNotMatch(importSpec, /不移除\s*popup/i);
  assert.doesNotMatch(appSpec, /不做账号自动切换\/自动登录（登录全人工）/);
  assert.doesNotMatch(startScript, /extension popup/i);
});
