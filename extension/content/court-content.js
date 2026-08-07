// court-content.js — 平台页内容脚本（列表页批量执行 + 详情页自动取证）
// 经 esbuild 打包为 ../dist/court-content.bundle.js（manifest 引用）
// 依据 docs/specs/query-module.md 与 app-module.md：
// - 登录由后台统一命令驱动；批量执行前校验已登录 + 当前账号与案件账号一致（不一致 → 待人工切换）；
// - 驳回案件：列表行直读审核意见（驳回原因），审核时间/截图由「案件空间」新标签的
//   详情页实例自动采集（storage.session 传递待办，详情页回写 db）；
// - 截图用 html2canvas captureElement（content script 内可用，无需扩展权限）。
import { SELECTORS } from "./selectors.js";
import {
  assertSelectors,
  collectListRows,
  extractBusinessFields,
  collectDetail,
} from "./case-collectors.js";
import {
  createLoginStateMessage,
  detectLoginState,
  detectLoginStateWhenStable,
  getCurrentAccount,
  isCourtListRoute,
  isLoginRoute,
} from "./login-detector.js";
import { doAutoLogin } from "./login-auto.js";
import { captureElement } from "./screen-capturer.js";
import { runBatch, RETRY_COUNT, jitterMs } from "../data/batch-runner.js";
import { recognizeStatus } from "./status-recognizer.js";
import { createCourtPanel } from "./court-panel.js";
import { importXlsx } from "../data/import-xlsx.js";
import { buildExportWorkbook } from "../data/xlsx-io.js";
import { exportUploadMessage, exportWorkbookToServer } from "../data/export-uploader.js";
import * as db from "../data/db.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isDetailPage = () => location.hash.includes("wsla/detail");
const isListPage = () => isCourtListRoute(location.hash);

// —— 网页浮动面板（panel-module 规格） ——
let _panel = null;
let _batchRunning = false;
let _batchPaused = false;
let _exportInFlight = null;
const _resumeWaiters = [];
let _lastLoginReport = null;
const AUTO_LOGIN_ERROR_CODES = new Set([
  "SERVICE_UNAVAILABLE",
  "FORM_NOT_READY",
  "OCR_FAILED",
  "LOGIN_TIMEOUT",
  "NEEDS_HUMAN",
]);
const EXECUTION_TAB_REQUIRED_MESSAGE = "请先在页面顶部切换到执行 tab";

function isEnforcementCaseType(caseType = "") {
  return String(caseType).includes("执行");
}

function queryErrorMessage(error) {
  const code = typeof error === "string" ? error : error?.code ?? error?.message;
  if (code === "EXECUTION_TAB_REQUIRED") return EXECUTION_TAB_REQUIRED_MESSAGE;
  return `开始查询失败：${code || "请人工检查页面状态"}`;
}

function sanitizeAutoLoginResponse(response) {
  if (response?.ok === true) return { ok: true };
  const error = AUTO_LOGIN_ERROR_CODES.has(response?.error) ? response.error : "FORM_NOT_READY";
  return { ok: false, error };
}

/** 暂停/继续在节流间隙生效（不在页面动作中途打断） */
function pauseBatch() {
  _batchPaused = true;
}
function resumeBatch() {
  _batchPaused = false;
  const waiters = _resumeWaiters.splice(0);
  for (const w of waiters) w();
}
function delayWithPause() {
  return new Promise((resolve) => {
    const step = () => {
      if (_batchPaused) {
        _resumeWaiters.push(step);
      } else {
        setTimeout(resolve, jitterMs());
      }
    };
    step();
  });
}

export function getBatchState() {
  return { running: _batchRunning, paused: _batchPaused };
}

/** 上报脱敏登录态；原始账号只在当前页面内用于生成 maskedAccount。 */
export function reportLoginState(state, account = null, { now = Date.now, sendMessage } = {}) {
  const message = createLoginStateMessage({ state, account, updatedAt: now() });
  const fingerprint = `${message.state}|${message.maskedAccount}`;
  if (_lastLoginReport === fingerprint) return message;
  _lastLoginReport = fingerprint;
  const sender = sendMessage ?? globalThis.chrome?.runtime?.sendMessage;
  if (typeof sender === "function") {
    try {
      sender(message);
    } catch {
      // runtime 断开时不影响页面上的登录状态与批量暂停。
    }
  }
  return message;
}

/** 应用登录态到面板、runtime 上报，并在会话失效时暂停批量。 */
export function handleLoginState(state, account = null, options = {}) {
  const message = reportLoginState(state, account, options);
  _panel?.setLogin({ state: message.state, account });
  if (message.state === "session-expired") {
    pauseBatch();
    if (_batchRunning) showToast("会话已失效，批量查询已暂停，请重新登录后手动继续", 6000);
  }
  return message;
}

/** 按账号聚合待处理分组（进度区展示，账号脱敏在面板内做） */
function sendSyncMessage(message) {
  const sender = globalThis.chrome?.runtime?.sendMessage;
  if (typeof sender !== "function") return Promise.resolve(undefined);
  try {
    return Promise.resolve(sender(message)).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

function requestSyncStatus() {
  sendSyncMessage({ type: "SYNC_STATUS_REQUEST" }).then((response) => {
    if (response?.type === "SYNC_STATUS") _panel?.setSyncStatus(response.payload);
  });
}

function groupByAccount(records) {
  const map = new Map();
  for (const r of records) {
    const account = r.account || "未分组";
    map.set(account, (map.get(account) || 0) + 1);
  }
  return [...map.entries()].map(([account, count]) => ({ account, count }));
}

/** 刷新面板登录状态（SPA 异步渲染防误报：等待用户区出现再判定） */
async function refreshPanelLogin() {
  const state = await detectLoginStateWhenStable({
    hash: location.hash,
    root: document,
    wait: () => sleep(300),
    timeoutMs: 5000,
  });
  const account = getCurrentAccount(document);
  handleLoginState(state, account);
  return state;
}

/** 监听用户区 DOM 变化，兜底刷新面板登录状态 */
export function observePanelLogin({ root = document, view = window, refresh = refreshPanelLogin } = {}) {
  let lastAccount = null;
  let timer = null;
  let observer = null;
  let stopped = false;

  const start = () => {
    if (stopped) return;
    lastAccount = getCurrentAccount(root);
    // 观察 documentElement（document_start 即存在），快照比较天然过滤 body 时序
    observer = new view.MutationObserver(() => {
      const account = getCurrentAccount(root);
      if (account === lastAccount) return;
      lastAccount = account;
      view.clearTimeout(timer);
      timer = view.setTimeout(() => {
        timer = null;
        refresh();
      }, 300);
    });
    observer.observe(root.documentElement, { childList: true, subtree: true });
  };

  const disconnect = () => {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    observer = null;
    view.clearTimeout(timer);
    timer = null;
    view.removeEventListener("pagehide", disconnect);
  };

  start();
  view.addEventListener("pagehide", disconnect);
  return disconnect;
}

/** 全页面 SPA 登录态观察：路由或用户区变化时刷新，不自动恢复批量队列。 */
export function observeLoginState({ root = document, view = window, refresh = refreshPanelLogin } = {}) {
  let timer = null;
  let observer = null;
  let stopped = false;
  let lastFingerprint = null;

  const fingerprint = () => {
    let hash = "";
    try {
      hash = view.location?.hash ?? globalThis.location?.hash ?? "";
    } catch {
      // 页面销毁后，jsdom/浏览器窗口的 location getter 可能不可用。
    }
    let account = "";
    try {
      account = getCurrentAccount(root) ?? "";
    } catch {
      // 页面销毁时 DOM 读取同样可能失败。
    }
    return `${hash}|${account}`;
  };
  const schedule = () => {
    if (stopped) return;
    const next = fingerprint();
    if (next === lastFingerprint) return;
    lastFingerprint = next;
    let hash = "";
    try {
      hash = view.location?.hash ?? globalThis.location?.hash ?? "";
    } catch {
      return;
    }
    let hasUserArea = false;
    try {
      hasUserArea = !!getCurrentAccount(root);
    } catch {
      return;
    }
    if (!isLoginRoute(hash) && !hash.includes("pages") && !hasUserArea) return;
    view.clearTimeout(timer);
    timer = view.setTimeout(() => {
      timer = null;
      Promise.resolve(refresh()).catch(() => {});
    }, 300);
  };
  const start = () => {
    if (stopped) return;
    if (!root?.documentElement || typeof view.MutationObserver !== "function") return;
    lastFingerprint = fingerprint();
    let hash = "";
    try {
      hash = view.location?.hash ?? globalThis.location?.hash ?? "";
    } catch {
      // 页面销毁时跳过初始读取。
    }
    if (isLoginRoute(hash) || hash.includes("pages") || getCurrentAccount(root)) {
      Promise.resolve(refresh()).catch(() => {});
    }
    observer = new view.MutationObserver(schedule);
    observer.observe(root.documentElement, { childList: true, subtree: true });
    view.addEventListener("hashchange", schedule);
  };
  const disconnect = () => {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    observer = null;
    view.clearTimeout(timer);
    timer = null;
    view.removeEventListener("hashchange", schedule);
    view.removeEventListener("pagehide", disconnect);
  };

  start();
  view.addEventListener("pagehide", disconnect);
  return disconnect;
}

/** 历史面板导入执行器：文件 → 解析 → 入库；统一命令迁移后仅保留底层兼容能力。 */
async function handlePanelImport(file) {
  const buffer = await file.arrayBuffer();
  const result = await importXlsx(buffer);
  const li = await db.applyImport(db.STORE_CASES, result.liRows);
  const qz = await db.applyImport(db.STORE_ENFORCEMENT, result.qzRows);
  showToast(
    `导入完成：立案 新增${li.imported}/更新${li.updated}，强执 新增${qz.imported}/更新${qz.updated}` +
      (result.skipped ? `，跳过 ${result.skipped} 行（${(result.reasons || []).slice(0, 3).join("；")}）` : ""),
    6000,
  );
}

/** 面板导出：IndexedDB → 模板格式 xlsx → 下载 */
function handlePanelExport() {
  if (_exportInFlight) return _exportInFlight;
  const current = (async () => {
    const cases = await db.query(db.STORE_CASES, {});
    const enforcementCases = await db.query(db.STORE_ENFORCEMENT, {});
    const wb = await buildExportWorkbook({ cases, enforcementCases });
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const fileName = `立案与强执查询表-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const a = document.createElement("a");
    const objectUrl = URL.createObjectURL(blob);
    a.href = objectUrl;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(objectUrl);
    const result = await exportWorkbookToServer({ blob, fileName, chromeApi: chrome });
    showToast(exportUploadMessage(result), 6000);
    return result;
  })();
  _exportInFlight = current;
  current.then(
    () => { if (_exportInFlight === current) _exportInFlight = null; },
    () => { if (_exportInFlight === current) _exportInFlight = null; },
  );
  return current;
}

/** 挂载浮动面板（仅列表/详情页；其他页面不打扰） */
function initPanel() {
  if (!isDetailPage() && !isListPage()) return;
  _panel = createCourtPanel({
    document,
    handlers: {
      onSyncRetry: () => {
        sendSyncMessage({ type: "SYNC_RETRY" });
      },
      onImport: () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".xlsx";
        input.onchange = () => input.files?.[0] && handlePanelImport(input.files[0]).catch((e) => showToast(`导入失败：${e.message}`, 6000));
        input.click();
      },
      onQuery: async (kind = "li") => {
        if (_batchRunning) return; // 运行中忽略重复点击（防并发）
        try {
          await startBatch(kind === "qz" ? "qz" : "li");
        } catch (e) {
          showToast(queryErrorMessage(e), 6000);
        }
      },
      onExport: () => handlePanelExport().catch((e) => showToast(`导出失败：${e.message}`, 6000)),
      onPause: () => {
        if (!_batchRunning) return;
        pauseBatch();
        showToast("批量查询已暂停", 3000);
      },
      onResume: () => {
        if (!_batchRunning) return;
        resumeBatch();
        showToast("批量查询已继续", 3000);
      },
    },
  });
  _panel.setReady(true);
  requestSyncStatus();
  refreshPanelLogin();
  observePanelLogin();
  // 平台是 SPA：hash 变化时刷新登录状态
  window.addEventListener("hashchange", refreshPanelLogin);
}

// —— 页面内状态型浮动面板进度提示 ——
let _toastTimer = null;
function showToast(text, ms = 4000) {
  let el = document.getElementById("court-helper-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "court-helper-toast";
    el.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:2147483647;background:#1f2937;color:#fff;" +
      "padding:10px 16px;border-radius:8px;font:13px/1.5 sans-serif;max-width:360px;box-shadow:0 4px 12px rgba(0,0,0,.3)";
    document.documentElement.appendChild(el);
  }
  el.textContent = text;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.remove(), ms);
}

/** 等待条件成立 */
async function waitFor(fn, timeoutMs = 10000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fn()) return true;
    } catch { /* 继续等待 */ }
    await sleep(intervalMs);
  }
  return false;
}

/** 当前页面判定：列表页且已登录 */
function ensureListReady() {
  if (!isListPage()) throw new Error("PAGE_NOT_LIST");
  const state = detectLoginState({ hash: location.hash, root: document });
  if (state === "login" || state === "session-expired") {
    handleLoginState("session-expired");
    throw new Error("SESSION_EXPIRED");
  }
  return state === "logged-in";
}

/** 审核结果区元素（截图目标） */
function findAuditSection() {
  const items = document.querySelectorAll(SELECTORS.detail.formItem);
  const first = items[0];
  if (!first) return null;
  let el = first;
  for (let i = 0; i < 6 && el.parentElement; i++) el = el.parentElement;
  return el;
}

// —— 详情页角色：读取待办并采集驳回凭证（审核时间/原因/截图） ——
async function runDetailCapture() {
  const { pendingDetail } = await chrome.storage.session.get("pendingDetail");
  if (!pendingDetail?.uid) return false;
  const { uid, kind } = pendingDetail;
  const store = kind === "qz" ? db.STORE_ENFORCEMENT : db.STORE_CASES;
  const ok = await waitFor(
    () => document.querySelectorAll(SELECTORS.detail.formItem).length >= 2,
    15000,
  );
  if (!ok) {
    showToast("详情页加载超时，驳回凭证未采集，请人工处理");
    return false;
  }
  const detail = collectDetail(document);
  const rec = await db.getByUid(store, uid);
  if (!rec || !detail.auditRecords.length) return false;
  const latest = detail.auditRecords[0];
  let image = null;
  const section = findAuditSection();
  if (section) {
    try {
      image = await captureElement(section);
    } catch (e) {
      console.warn("[court-helper] captureElement failed", e);
    }
  }
  await db.upsert(store, {
    ...rec,
    status: rec.status === "UNKNOWN"
      ? recognizeStatus({ statusText: latest.status, caseType: rec.caseType ?? "", pageKind: "wsla" })
      : rec.status,
    rejectTime: (latest.time || "").slice(0, 10) || rec.rejectTime,
    rejectReason: detail.opinion ?? rec.rejectReason,
    rejectImage: image ?? rec.rejectImage,
  });
  await chrome.storage.session.set({ pendingDetail: null });
  showToast(`已采集驳回凭证（${uid.slice(0, 8)}…）：${latest.time || "时间未知"}`);
  return true;
}

/** 触发详情采集：登记待办 → 点击「案件空间」打开新标签 */
async function triggerDetailCapture({ uid, kind, target }) {
  await chrome.storage.session.set({ pendingDetail: { uid, kind, at: Date.now() } });
  const btn = target.querySelector(SELECTORS.list.spaceBtn);
  if (btn) {
    btn.click();
    return;
  }
  // 无空间按钮（异常）→ 保留待办，由人工打开详情页触发
  showToast("未找到「案件空间」按钮，请手动打开详情页以采集驳回凭证");
}

/** 列表页角色：查询单个案件（pageOps.queryCase 浏览器实现） */
async function queryCase({ uid, kind }) {
  const store = kind === "qz" ? db.STORE_ENFORCEMENT : db.STORE_CASES;
  const rec = await db.getByUid(store, uid);
  if (!rec) throw new Error("CASE_NOT_FOUND");
  ensureListReady();
  const currentAccount = getCurrentAccount(document);
  if (rec.account && currentAccount && rec.account !== currentAccount) {
    throw new Error("ACCOUNT_MISMATCH");
  }
  const pageKind = location.hash.includes("pagesWsla") ? "wsla" : "mycase";
  const rows = collectListRows(document);
  if (!rows.length) throw new Error("LIST_EMPTY");
  const target = rows.find((r) => rec.plaintiff && r.caseName.includes(rec.plaintiff));
  if (!target) throw new Error("CASE_NOT_FOUND_IN_LIST");

  const biz = extractBusinessFields(target.fields);
  const raw = {
    statusText: target.statusText,
    caseType: target.caseType,
    pageKind,
    caseNumber: biz.caseNumber,
    filedDate: biz.filedDate,
  };
  const status = recognizeStatus({ statusText: raw.statusText, caseType: raw.caseType, pageKind });
  if (status === "已驳回") {
    raw.rejectReason = biz.auditOpinion ?? null;
    await triggerDetailCapture({ uid, kind, target });
    const ok = await waitFor(async () => {
      const updated = await db.getByUid(store, uid);
      return !!(updated?.rejectTime && updated.rejectImage);
    }, 30000, 1000);
    const updated = await db.getByUid(store, uid);
    if (ok && updated) {
      raw.rejectTime = updated.rejectTime;
      raw.rejectImage = updated.rejectImage;
    } else {
      throw new Error("DETAIL_TIMEOUT");
    }
  } else if (status === "立案成功" || status === "强执成功") {
    raw.image = await captureRow(target);
  }
  return raw;
}

/** 截图（成功类状态在列表页截行） */
async function captureRow(target) {
  try {
    return await captureElement(target);
  } catch (e) {
    console.warn("[court-helper] 行截图失败", e);
    return null;
  }
}

/** 批量执行入口（START_BATCH 消息） */
async function startBatch(kind) {
  if (!ensureListReady()) throw new Error("NOT_READY");
  if (kind === "qz") {
    const rows = collectListRows(document);
    if (!rows.some((row) => isEnforcementCaseType(row.caseType))) {
      throw new Error("EXECUTION_TAB_REQUIRED");
    }
  }
  const store = kind === "qz" ? db.STORE_ENFORCEMENT : db.STORE_CASES;
  const all = await db.query(store, {});
  if (!all.length) throw new Error("NO_CASES");
  const total = Math.min(all.length, 50);
  showToast(`开始批量查询 ${total} 条（${kind === "qz" ? "强执" : "立案"}），请勿切换页面`, 8000);
  _batchRunning = true;
  _batchPaused = false;
  _panel?.setProgress({ done: 0, total, groups: groupByAccount(all) });

  let done = 0;
  const stats = await runBatch({
    cases: all.map((r) => ({ uid: r.uid, kind, account: r.account, plaintiff: r.plaintiff })),
    pageOps: {
      queryCase,
      async capture() {
        // 成功类截图：列表行截图已在 queryCase 内捕获；此处兜底返回 null（由 onUpdate 处理）
        return null;
      },
    },
    timing: { delay: delayWithPause },
    onUpdate: async (record) => {
      const storeName = record.kind === "qz" ? db.STORE_ENFORCEMENT : db.STORE_CASES;
      const existing = await db.getByUid(storeName, record.uid);
      await db.upsert(storeName, {
        ...existing,
        ...record,
        successImage: record.image ?? existing?.successImage ?? null,
        needsHuman: record.needsHuman || !record.image && ["立案成功", "强执成功"].includes(record.status),
      });
      done += 1;
      _panel?.setProgress({ done, total, groups: groupByAccount(all) });
      showToast(`进度 ${done}/${total}：${record.status}`, 2500);
    },
  });
  _batchRunning = false;
  return { ok: true, stats };
}

async function executeBrowserCommand(message) {
  if (message.commandType === "LOGIN") {
    if (!isLoginRoute(location.hash)) return { ok: false, error: "NOT_LOGIN_ROUTE" };
    if (typeof message.account !== "string" || !message.account || typeof message.password !== "string" || !message.password) {
      return { ok: false, error: "FORM_NOT_READY" };
    }
    return doAutoLogin({
      account: message.account,
      password: message.password,
      serviceUrl: message.serviceUrl,
      root: document,
      location,
    }).then(sanitizeAutoLoginResponse).catch(() => ({ ok: false, error: "NEEDS_HUMAN" }));
  }
  if (message.commandType === "QUERY_LI" || message.commandType === "QUERY_QZ") {
    const kind = message.commandType === "QUERY_QZ" ? "qz" : "li";
    const rows = Array.isArray(message.rows) ? message.rows.filter((row) => row?.kind === kind).slice(0, 50) : [];
    if (!rows.length) return { ok: false, error: "NO_CASES" };
    const records = rows.map((row) => {
      const clean = { ...row };
      delete clean.password;
      delete clean.kind;
      return clean;
    });
    await db.applyImport(kind === "qz" ? db.STORE_ENFORCEMENT : db.STORE_CASES, records);
    return startBatch(kind);
  }
  if (message.commandType === "EXPORT_REPORT") {
    ensureListReady();
    return handlePanelExport();
  }
  return { ok: false, error: "UNSUPPORTED_COMMAND" };
}

// —— 消息监听 ——
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "SYNC_STATUS") {
    _panel?.setSyncStatus(msg.payload);
    return false;
  }
  if (msg?.type === "AUTO_LOGIN") {
    // 路由门禁必须先于凭据读取和任何表单 DOM 操作。
    if (!isLoginRoute(location.hash)) {
      sendResponse({ ok: false, error: "NOT_LOGIN_ROUTE" });
      return false;
    }
    if (typeof msg.account !== "string" || !msg.account || typeof msg.password !== "string" || !msg.password) {
      sendResponse({ ok: false, error: "FORM_NOT_READY" });
      return false;
    }
    doAutoLogin({
      account: msg.account,
      password: msg.password,
      serviceUrl: msg.serviceUrl,
      root: document,
      location,
    })
      .then((response) => sendResponse(sanitizeAutoLoginResponse(response)))
      .catch(() => sendResponse({ ok: false, error: "FORM_NOT_READY" }));
    return true;
  }
  if (msg?.type === "START_BATCH") {
    startBatch(msg.kind === "qz" ? "qz" : "li")
      .then((resp) => sendResponse(resp))
      .catch((e) => sendResponse({ ok: false, error: e.message ?? String(e) }));
    return true; // 异步响应
  }
  if (msg?.type === "BROWSER_COMMAND_EXECUTE") {
    executeBrowserCommand(msg)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error?.message ?? "NEEDS_HUMAN" }));
    return true;
  }
  if (msg?.type === "PING") {
    sendResponse({
      ok: true,
      role: isDetailPage() ? "detail" : "list",
      route: location.hash,
      state: detectLoginState({ hash: location.hash, root: document }),
    });
    return false;
  }
  return false;
});

// —— 页面加载完成后的角色分发 ——
(async () => {
  try {
    observeLoginState();
    initPanel();
    if (isDetailPage()) {
      await runDetailCapture();
    } else if (isListPage()) {
      // 预校验选择器（改版检测）：列表页就绪时探测，失效则 toast 提示
      const ok = await waitFor(() => document.querySelectorAll(SELECTORS.list.row).length > 0 || document.body.innerText.includes("暂无数据"), 8000);
      if (ok) {
        try {
          assertSelectors(document);
          showReadyBadge();
        } catch (e) {
          showToast(`⚠ 平台页面结构疑似变更（${e.selectorKey}），请暂停使用并联系维护`, 10000);
        }
      }
    }
  } catch (e) {
    console.warn("[court-helper] init error", e);
  }
})();

/** 就绪徽标：让用户直观看到插件已连接（右上角常驻小徽标，SPA 渲染防误报） */
async function showReadyBadge() {
  const state = await detectLoginStateWhenStable({
    hash: location.hash,
    root: document,
    wait: () => sleep(300),
    timeoutMs: 5000,
  });
  if (state !== "logged-in") return;
  let el = document.getElementById("court-helper-badge");
  if (el) return;
  el = document.createElement("div");
  el.id = "court-helper-badge";
  el.textContent = "查询助手已就绪";
  el.style.cssText =
    "position:fixed;top:12px;right:12px;z-index:2147483646;background:#16a34a;color:#fff;" +
    "padding:6px 12px;border-radius:999px;font:12px/1.4 sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer";
  el.title = "法院立案/强执查询助手：已连接；业务操作请使用后台控制台";
  el.addEventListener("click", () => el.remove());
  document.documentElement.appendChild(el);
}
