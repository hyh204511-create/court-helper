// popup 逻辑（Phase 6 实现：导入/查询/批量/导出）
// 经 esbuild 打包为 ../dist/popup.bundle.js
import { VERSION } from "../shared/message-router.js";
import { createLoginController } from "./login-controller.js";
import * as db from "../data/db.js";
import { importXlsx } from "../data/import-xlsx.js";
import { buildExportWorkbook } from "../data/xlsx-io.js";

const $ = (sel) => document.querySelector(sel);
const STORES = [
  { name: db.STORE_CASES, label: "立案" },
  { name: db.STORE_ENFORCEMENT, label: "强执" },
];
let loginController = null;

/** 渲染查询结果表 */
async function renderResults() {
  const keyword = $("#search-input")?.value.trim() ?? "";
  const status = $("#status-filter")?.value ?? "";
  const tbody = $("#results-body");
  const rows = [];
  for (const { name, label } of STORES) {
    for (const r of await db.query(name, { keyword, status })) {
      rows.push({ ...r, typeLabel: label });
    }
  }
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">暂无数据 — 请先导入模板</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((r) => {
      const hasImg = !!(r.successImage || r.rejectImage);
      const unknown = r.status === "UNKNOWN" || r.needsHuman;
      return `<tr class="${unknown ? "row-unknown" : ""}">
        <td title="${escapeHtml(r.account ?? "")}">${escapeHtml(shorten(r.account, 12))}</td>
        <td>${escapeHtml(shorten(r.plaintiff ?? "", 14))}</td>
        <td>${r.typeLabel}</td>
        <td>${escapeHtml(r.status ?? "")}${unknown ? " ⚠" : ""}</td>
        <td>${escapeHtml(r.filedDate ?? "")}</td>
        <td>${escapeHtml(shorten(r.caseNumber ?? "", 18))}</td>
        <td>${hasImg ? "✓" : ""}</td>
        <td>${escapeHtml(r.queryTime ?? "")}</td>
      </tr>`;
    })
    .join("");
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shorten = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 导入模板文件 → 解析 → 入库 */
async function handleImport(file) {
  const buffer = await file.arrayBuffer();
  const result = await importXlsx(buffer);
  const li = await db.applyImport(db.STORE_CASES, result.liRows);
  const qz = await db.applyImport(db.STORE_ENFORCEMENT, result.qzRows);
  alert(`导入完成：立案 新增${li.imported}/更新${li.updated}，强执 新增${qz.imported}/更新${qz.updated}${result.skipped ? `，跳过 ${result.skipped} 行（${result.reasons.slice(0, 3).join("；")}）` : ""}`);
  await renderResults();
}

/** 导出报表：立案块 + 强执块（同模板格式，含图片） */
async function handleExport() {
  const cases = await db.query(db.STORE_CASES, {});
  const enforcementCases = await db.query(db.STORE_ENFORCEMENT, {});
  const wb = await buildExportWorkbook({ cases, enforcementCases });
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `立案与强执查询表-${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** 开始批量查询：通知当前标签的 content script 执行 */
async function handleQuery() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    alert("未找到当前标签页");
    return;
  }
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "START_BATCH" });
    $("#progress-text").textContent = resp?.ok ? "批量查询已启动，请在法院平台页面查看进度" : "启动失败";
  } catch {
    $("#progress-text").textContent = "未检测到采集器（请刷新法院平台页面后重试）";
  }
}

function bindActions() {
  $("#btn-import")?.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".xlsx";
    input.onchange = () => input.files?.[0] && handleImport(input.files[0]);
    input.click();
  });
  $("#btn-export")?.addEventListener("click", handleExport);
  $("#btn-query")?.addEventListener("click", handleQuery);
  $("#btn-search")?.addEventListener("click", renderResults);
  $("#search-input")?.addEventListener("keydown", (e) => e.key === "Enter" && renderResults());
  $("#status-filter")?.addEventListener("change", renderResults);
}

function bindLoginControls() {
  loginController = createLoginController({ document, chromeApi: chrome });
  loginController.init();

  const applyState = (state = {}) => {
    loginController?.setLoginState({
      state: state.state,
      maskedAccount: state.maskedAccount,
    });
  };
  chrome.storage?.local?.get?.(["state", "maskedAccount"]).then(applyState).catch(() => {});
  chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== "local") return;
    applyState({
      state: changes.state?.newValue,
      maskedAccount: changes.maskedAccount?.newValue,
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const versionEl = $("#app-version");
  if (versionEl) versionEl.textContent = `v${VERSION}`;
  bindActions();
  bindLoginControls();
  renderResults().catch((e) => console.error("[court-helper] render failed", e));
});
