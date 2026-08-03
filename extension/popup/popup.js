// popup 逻辑占位（Phase 6 实现：导入/查询/批量/导出）
// 经 esbuild 打包为 ../dist/popup.bundle.js
import { VERSION } from "../shared/message-router.js";

const $ = (sel) => document.querySelector(sel);

function bindActions() {
  $("#btn-import")?.addEventListener("click", () => console.debug("[court-helper] 导入模板（Phase 6）"));
  $("#btn-export")?.addEventListener("click", () => console.debug("[court-helper] 导出报表（Phase 6）"));
  $("#btn-query")?.addEventListener("click", () => console.debug("[court-helper] 开始查询（Phase 6）"));
  $("#btn-search")?.addEventListener("click", () => console.debug("[court-helper] 软件查询（Phase 6）"));
  $("#btn-pause")?.addEventListener("click", () => console.debug("[court-helper] 暂停/继续（Phase 6）"));
}

document.addEventListener("DOMContentLoaded", () => {
  const versionEl = $("#app-version");
  if (versionEl) versionEl.textContent = `v${VERSION}`;
  bindActions();
});
