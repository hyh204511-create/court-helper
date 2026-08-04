// popup 逻辑（Phase 6 实现：导入/查询/批量/导出）
// 经 esbuild 打包为 ../dist/popup.bundle.js
import { VERSION } from "../shared/message-router.js";
import { createLoginController } from "./login-controller.js";
import { canStartBatch, createStartBatchSender, isListRoute } from "./query-gate.js";
import * as db from "../data/db.js";
import { importXlsx } from "../data/import-xlsx.js";
import { buildExportWorkbook } from "../data/xlsx-io.js";

const $ = (sel) => document.querySelector(sel);
const STORES = [
  { name: db.STORE_CASES, label: "立案" },
  { name: db.STORE_ENFORCEMENT, label: "强执" },
];
let loginController = null;
let pageStatus = { state: "unknown", route: "" };
let queryInFlight = null;
let startBatchSender = null;

function updateQueryAvailability() {
  const button = $("#btn-query");
  if (!button) return;
  button.disabled = !canStartBatch({
    state: pageStatus.state,
    route: pageStatus.route,
    loginInProgress: loginController?.isAutoLoginInProgress?.() ?? false,
  });
}

async function refreshPageStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("NO_TAB");
    const response = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
    pageStatus = {
      state: response?.state ?? "unknown",
      route: response?.route ?? "",
    };
  } catch {
    pageStatus = { state: "unknown", route: "" };
  }
  updateQueryAvailability();
  return pageStatus;
}

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
export async function handleQuery() {
  if (queryInFlight) return queryInFlight;
  queryInFlight = (async () => {
    let tab;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      $("#progress-text").textContent = "未找到当前法院标签页";
      return { ok: false, error: "FORM_NOT_READY" };
    }
    if (!tab?.id) {
      $("#progress-text").textContent = "未找到当前法院标签页";
      return { ok: false, error: "FORM_NOT_READY" };
    }
    if (loginController?.isAutoLoginInProgress?.()) {
      $("#progress-text").textContent = "登录进行中，请稍候";
      updateQueryAvailability();
      return { ok: false, error: "FORM_NOT_READY" };
    }

    let status;
    try {
      status = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
    } catch {
      $("#progress-text").textContent = "未检测到采集器（请刷新法院平台页面后重试）";
      pageStatus = { state: "unknown", route: "" };
      updateQueryAvailability();
      return { ok: false, error: "FORM_NOT_READY" };
    }
    pageStatus = { state: status?.state ?? "unknown", route: status?.route ?? "" };
    if (!canStartBatch({
      state: pageStatus.state,
      route: pageStatus.route,
      loginInProgress: loginController?.isAutoLoginInProgress?.() ?? false,
    })) {
      $("#progress-text").textContent = isListRoute(pageStatus.route)
        ? "请先完成登录后再抓取"
        : "请打开法院立案列表页后再抓取";
      updateQueryAvailability();
      return { ok: false, error: "FORM_NOT_READY" };
    }

    startBatchSender ??= createStartBatchSender({ chromeApi: chrome });
    try {
      const response = await startBatchSender(tab.id);
      $("#progress-text").textContent = response?.ok
        ? "批量查询已启动，请在法院平台页面查看进度"
        : "启动失败，请人工检查页面状态";
      return response;
    } catch {
      $("#progress-text").textContent = "未检测到采集器（请刷新法院平台页面后重试）";
      return { ok: false, error: "FORM_NOT_READY" };
    }
  })();
  const current = queryInFlight;
  current.then(
    () => { if (queryInFlight === current) queryInFlight = null; },
    () => { if (queryInFlight === current) queryInFlight = null; },
  );
  return current;
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
  loginController = createLoginController({
    document,
    chromeApi: chrome,
    onLoginResult: () => { refreshPageStatus(); },
  });
  loginController.init().then(refreshPageStatus).catch(refreshPageStatus);

  const applyState = (state = {}) => {
    loginController?.setLoginState({
      state: state.state,
      maskedAccount: state.maskedAccount,
    });
    if (state.state) pageStatus.state = state.state;
    updateQueryAvailability();
  };
  const readState = chrome.storage?.local?.get;
  if (typeof readState === "function") Promise.resolve(readState(["state", "maskedAccount"])).then(applyState).catch(() => {});
  chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== "local") return;
    applyState({
      state: changes.state?.newValue,
      maskedAccount: changes.maskedAccount?.newValue,
    });
  });
  updateQueryAvailability();
}

document.addEventListener("DOMContentLoaded", () => {
  const versionEl = $("#app-version");
  if (versionEl) versionEl.textContent = `v${VERSION}`;
  bindActions();
  bindLoginControls();
  renderResults().catch((e) => console.error("[court-helper] render failed", e));
});
