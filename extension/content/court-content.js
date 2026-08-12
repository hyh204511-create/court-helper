// court-content.js — 平台页内容脚本（列表页批量执行 + 详情页自动取证）
// 经 esbuild 打包为 ../dist/court-content.bundle.js（manifest 引用）
// 依据 docs/specs/query-module.md 与 app-module.md：
// - 登录由后台统一命令驱动；批量执行前校验已登录 + 当前账号与案件账号一致（不一致 → 待人工切换）；
// - 驳回案件：列表行直读审核意见（驳回原因），审核时间/截图由「案件空间」新标签的
//   详情页实例自动采集（Service Worker 桥接 session storage 传递待办，详情页回写 db）；
// - 截图只渲染已确认的案件行/审核区域，避免依赖 activeTab 临时授权或调试器。
import { SELECTORS } from "./selectors.js";
import {
  assertSelectors,
  collectListRowEntries,
  collectListRows,
  findField,
  extractBusinessFields,
  collectDetail,
  selectLatestAuditRecord,
} from "./case-collectors.js";
import {
  createLoginStateMessage,
  detectLoginState,
  detectLoginStateWhenStable,
  getCurrentAccount,
  isCourtListRoute,
  isLoginRoute,
} from "./login-detector.js";
import { doAutoLogin, requestTrustedClick } from "./login-auto.js";
import { captureElement } from "./screen-capturer.js";
import { persistSyncRecord, runBatch, jitterMs } from "../data/batch-runner.js";
import { createRuntimeCaseOutbox } from "../data/runtime-case-outbox.js";
import { recognizeStatus, reconcileStatusText } from "./status-recognizer.js";
import { createCourtPanel } from "./court-panel.js";
import { importXlsx } from "../data/import-xlsx.js";
import { buildExportWorkbook } from "../data/xlsx-io.js";
import { exportUploadMessage, exportWorkbookToServer } from "../data/export-uploader.js";
import { buildPlatformDiscoveryRecords, parseParticipantField, selectDiscoveredListRow } from "../data/platform-discovery.js";
import {
  evidenceFailureCode,
  preferEvidenceError,
  selectMyCaseApiEvidence,
  selectSourceApiRow,
} from "../data/platform-evidence.js";
import {
  createMainWorldFetch,
  fetchLayyPages,
  fetchMyCases,
  isApprovedLayyStatusText,
  memoizeAsync,
  reconcileApiDomRows,
} from "./query-api.js";
import { isQueryControlsReady, runQueryAllExport, switchQueryCategory, waitForListQuiet } from "./query-all-export.js";
import * as db from "../data/db.js";
import { sanitizeReportFileName } from "../data/report-file-name.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ONLINE_FILING_ROUTE = "#/pagesWsla/pc/list/index";
const CIVIL_CASE_CATEGORIES = "1501_000001-0100;1501_000001-0200;1501_000001-0300;1501_000001-0400;1501_000001-0500";
const EXECUTION_CASE_CATEGORIES = "1501_000001-1000";
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

/** 面板导出：只导出当前平台账号绑定的 IndexedDB 记录。 */
function handlePanelExport({
  platformAccountId = null, accountLabel = "", exportCredential = null, salesperson = "",
  accountBindingVerified = false,
} = {}) {
  if (_exportInFlight) return _exportInFlight;
  const current = (async () => {
    ensureListReady();
    const account = getCurrentAccount(document);
    if (!account) throw new Error("ACCOUNT_UNDETECTED");
    if (typeof platformAccountId !== "string" || !platformAccountId) throw new Error("PLATFORM_ACCOUNT_UNAVAILABLE");
    if (!exportCredential?.account || !exportCredential?.password
      || (!accountBindingVerified && exportCredential.account !== account)) {
      throw new Error("ACCOUNT_MISMATCH");
    }
    const filter = { account, platformAccountId };
    const [cases, enforcementCases] = await Promise.all([
      db.query(db.STORE_CASES, filter),
      db.query(db.STORE_ENFORCEMENT, filter),
    ]);
    if (cases.length + enforcementCases.length === 0) throw new Error("REPORT_EMPTY");
    const wb = await buildExportWorkbook({ cases, enforcementCases, exportCredential, salesperson });
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const fileName = sanitizeReportFileName(accountLabel);
    const a = document.createElement("a");
    const objectUrl = URL.createObjectURL(blob);
    a.href = objectUrl;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(objectUrl);
    const result = await exportWorkbookToServer({ buffer: buf, fileName, platformAccountId, chromeApi: chrome });
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
      if (await fn()) return true;
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

function isBrowserCommandReady() {
  if (!isListPage() || !_panel || !getCurrentAccount(document)) return false;
  return isQueryControlsReady(document);
}

const textOf = (value) => String(value?.textContent ?? value?.innerText ?? "").trim();

function detailItemPair(item) {
  const children = [...(item?.children ?? [])].filter((child) => textOf(child));
  if (children.length >= 2) {
    return { label: textOf(children[0]), value: textOf(children[children.length - 1]) };
  }
  const parts = textOf(item).split("\n").map((part) => part.trim()).filter(Boolean);
  return parts.length ? { label: parts[0], value: parts.slice(1).join(" ") } : null;
}

function detailSectionTitle(section) {
  const attributeTitle = section.getAttribute("title")?.trim();
  if (attributeTitle) return attributeTitle;
  const headings = [...section.querySelectorAll(SELECTORS.detail.sectionTitle)]
    .map(textOf)
    .filter(Boolean);
  return headings.length === 1 ? headings[0] : null;
}

function uniqueDetailSection(title, root = document) {
  const matches = [...root.querySelectorAll(SELECTORS.detail.section)]
    .filter((section) => {
      return detailSectionTitle(section) === title;
    });
  return matches.length === 1 ? matches[0] : null;
}

function latestAuditItems(section, latest) {
  const records = [];
  let current = null;
  for (const item of section.querySelectorAll(SELECTORS.detail.formItem)) {
    const pair = detailItemPair(item);
    if (!pair?.label) continue;
    if (pair.label === "审核结果") {
      current = { status: pair.value, items: [item] };
      records.push(current);
    } else if (pair.label === "审核时间" && current) {
      current.time = pair.value;
      current.items.push(item);
    } else if (pair.label === "审核意见" && current) {
      current.opinion = pair.value;
      current.items.push(item);
    }
  }
  const matches = records.filter((record) => record.status === latest.status
    && record.time === latest.time
    && record.opinion === latest.opinion
    && record.items.length === 3);
  return matches.length === 1 ? matches[0].items : null;
}

/**
 * 定位同一详情页的原生页头、可选重新提交信息与最新审核记录。
 * record 只用于核对原生案件标题归属，不向截图绘制任何本地业务文字。
 */
function findDetailEvidenceSources({ record, latest }) {
  const pages = [...document.querySelectorAll(SELECTORS.detail.page)];
  if (pages.length !== 1) return null;
  const page = pages[0];
  const headers = [...page.querySelectorAll(SELECTORS.detail.header)];
  const contents = [...page.querySelectorAll(SELECTORS.detail.content)];
  if (headers.length !== 1 || contents.length !== 1) return null;
  const expectedParties = [record?.plaintiff, record?.defendant]
    .map((value) => typeof value === "string" ? value.trim() : "");
  const headerText = textOf(headers[0]);
  const sourceCaseName = typeof record?.sourceCaseName === "string" ? record.sourceCaseName.trim() : "";
  const headerMatches = sourceCaseName
    ? headerText.includes(sourceCaseName)
    : expectedParties.every((value) => value && headerText.includes(value));
  if (!headerMatches) return null;
  const content = contents[0];
  const resubmitSections = [...content.querySelectorAll(SELECTORS.detail.section)]
    .filter((section) => detailSectionTitle(section) === "重新提交信息");
  if (resubmitSections.length > 1) return null;
  const auditSection = uniqueDetailSection("审核结果", content);
  if (!auditSection) return null;
  const auditItems = latestAuditItems(auditSection, latest);
  if (!auditItems) return null;

  return { page, content, resubmitSection: resubmitSections[0] ?? null, auditSection, auditItems };
}

function buildDetailEvidenceTarget(input) {
  const sources = findDetailEvidenceSources(input);
  if (!sources) return null;

  const target = sources.page.cloneNode(true);
  target.setAttribute("data-court-helper-detail-evidence", "");
  const width = Math.ceil(sources.page.getBoundingClientRect?.().width || sources.page.scrollWidth || 1200);
  target.style.setProperty("position", "absolute", "important");
  target.style.setProperty("left", "-100000px", "important");
  target.style.setProperty("top", "0", "important");
  target.style.setProperty("width", `${width}px`, "important");
  target.style.setProperty("height", "auto", "important");
  target.style.setProperty("min-height", "0", "important");
  const targetContents = [...target.querySelectorAll(SELECTORS.detail.content)];
  if (targetContents.length !== 1) return null;
  const targetContent = targetContents[0];
  for (const section of [...targetContent.querySelectorAll(SELECTORS.detail.section)]) {
    const title = detailSectionTitle(section);
    if (title !== "重新提交信息" && title !== "审核结果") section.remove();
  }
  const targetAudit = uniqueDetailSection("审核结果", targetContent);
  if (!targetAudit) return null;
  const targetAuditItems = latestAuditItems(targetAudit, input.latest);
  if (!targetAuditItems) return null;
  const keptAuditItems = new Set(targetAuditItems);
  for (const item of targetAudit.querySelectorAll(SELECTORS.detail.formItem)) {
    if (!keptAuditItems.has(item)) item.remove();
  }
  for (const node of target.querySelectorAll(`${SELECTORS.detail.page}, .fd-com-main-container, ${SELECTORS.detail.content}`)) {
    node.style?.setProperty("height", "auto", "important");
    node.style?.setProperty("min-height", "0", "important");
  }
  document.body.append(target);
  return { target, cleanup: () => target.remove() };
}

// —— 详情页角色：读取待办并采集驳回凭证（审核时间/原因/截图） ——
export async function runDetailCapture({
  capture = captureElement,
  waitForEvidence = (predicate) => waitFor(predicate, 15000),
} = {}) {
  const pendingResponse = await chrome.runtime.sendMessage({ type: "CASE_DETAIL_PENDING_GET" });
  if (pendingResponse?.ok !== true) return false;
  const { pendingDetail } = pendingResponse;
  if (!pendingDetail?.uid) return false;
  const { uid, kind } = pendingDetail;
  try {
    await chrome.runtime.sendMessage({ type: "CASE_SPACE_ADOPTED", uid, kind });
  } catch {
    // pendingDetail remains the authoritative handoff; adoption is diagnostic only.
  }
  const store = kind === "qz" ? db.STORE_ENFORCEMENT : db.STORE_CASES;
  const rec = await db.getByUid(store, uid);
  if (!rec) return false;
  await waitForEvidence(() => {
    const candidate = collectDetail(document);
    const candidateLatest = selectLatestAuditRecord(candidate.auditRecords);
    return Boolean(candidateLatest && findDetailEvidenceSources({
      record: rec,
      kind,
      latest: candidateLatest,
    }));
  });
  const detail = collectDetail(document);
  if (!detail.auditRecords.length) {
    showToast("详情页加载超时，驳回凭证未采集，请人工处理");
    return false;
  }
  const latest = selectLatestAuditRecord(detail.auditRecords);
  if (!latest) {
    await db.upsertByUid(store, uid, {
      ...rec,
      needsHuman: true,
      errorCode: "AUDIT_EVIDENCE_INCOMPLETE",
    });
    await chrome.runtime.sendMessage({ type: "CASE_DETAIL_PENDING_CLEAR" });
    return true;
  }
  let image = null;
  let evidenceError = null;
  const evidenceTarget = buildDetailEvidenceTarget({ record: rec, kind, latest });
  if (!evidenceTarget) {
    evidenceError = "DETAIL_SCREENSHOT_TARGET_INCOMPLETE";
  } else {
    try {
      image = await capture(evidenceTarget.target);
      if (!image) evidenceError = "SCREENSHOT_CAPTURE_FAILED";
    } catch (e) {
      console.warn("[court-helper] captureElement failed", e);
      evidenceError = "SCREENSHOT_CAPTURE_FAILED";
    } finally {
      evidenceTarget.cleanup();
    }
  }
  const rejectReason = latest.opinion ?? rec.rejectReason ?? null;
  const recoveredCapture = Boolean(image) && [
    "SCREENSHOT_CAPTURE_FAILED",
    "PARTY_EVIDENCE_INCOMPLETE",
    "DETAIL_SCREENSHOT_TARGET_INCOMPLETE",
  ].includes(rec.errorCode);
  await db.upsertByUid(store, uid, {
    ...rec,
    status: rec.status === "UNKNOWN"
      ? recognizeStatus({ statusText: latest.status, caseType: rec.caseType ?? "", pageKind: "wsla" })
      : rec.status,
    rejectTime: (latest.time || "").slice(0, 10) || rec.rejectTime,
    rejectReason,
    rejectImage: image ?? rec.rejectImage,
    needsHuman: image ? (recoveredCapture ? false : rec.needsHuman === true) : true,
    errorCode: image ? (recoveredCapture ? null : rec.errorCode ?? null) : evidenceError,
  });
  await chrome.runtime.sendMessage({ type: "CASE_DETAIL_PENDING_CLEAR" });
  showToast(`已采集驳回凭证（${uid.slice(0, 8)}…）：${latest.time || "时间未知"}`);
  return true;
}

/** 触发详情采集：登记待办 → 点击「案件空间」打开新标签 */
async function triggerDetailCapture({ uid, kind, target }) {
  let handoff;
  try {
    handoff = await chrome.runtime.sendMessage({ type: "CASE_SPACE_OPEN", uid, kind });
  } catch {
    throw new Error("CASE_SPACE_HANDOFF_FAILED");
  }
  if (handoff?.ok !== true) throw new Error(handoff?.code ?? "CASE_SPACE_HANDOFF_FAILED");
  const btn = target.querySelector(SELECTORS.list.spaceBtn);
  if (!btn?.isConnected) throw new Error("CASE_SPACE_BUTTON_UNAVAILABLE");
  const clickDependencies = {
    sendMessage: chrome.runtime.sendMessage.bind(chrome.runtime),
    clickSessionStarted: false,
  };
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const clicked = await requestTrustedClick(btn, clickDependencies);
      if (!clicked.ok) throw new Error("CASE_SPACE_CLICK_FAILED");
      for (let poll = 0; poll < 20; poll += 1) {
        const state = await chrome.runtime.sendMessage({ type: "CASE_DETAIL_PENDING_GET" });
        const adopted = state?.handoff?.uid === uid
          && state.handoff.kind === kind
          && state.handoff.phase === "adopted";
        if (adopted || (state?.ok === true && state.pendingDetail == null)) return;
        await sleep(250);
      }
    }
    throw new Error("CASE_SPACE_TAB_UNAVAILABLE");
  } finally {
    if (clickDependencies.clickSessionStarted) {
      await chrome.runtime.sendMessage({ type: "CLICK_SESSION_END" }).catch(() => undefined);
    }
  }
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
  const rowEntries = collectListRowEntries(document);
  if (!rowEntries.length) throw new Error("LIST_EMPTY");
  let selectedEntry = null;
  if (rec.plaintiff && rec.defendant && rec.sourceCause) {
    const selection = selectDiscoveredListRow({
      record: rec,
      kind,
      rows: rowEntries.map(({ data }) => data),
    });
    if (!selection.ok) throw new Error(selection.error);
    selectedEntry = rowEntries[selection.index];
  } else {
    const candidates = rec.sourceCaseName
      ? rowEntries.filter(({ data }) => data.caseName === rec.sourceCaseName)
      : rec.caseNumber
        ? rowEntries.filter(({ data }) => extractBusinessFields(data.fields).caseNumber === rec.caseNumber)
        : [];
    if (!candidates.length) throw new Error("CASE_NOT_FOUND_IN_LIST");
    if (candidates.length !== 1) throw new Error("CASE_MATCH_AMBIGUOUS");
    [selectedEntry] = candidates;
  }
  const { data: target, element: targetElement } = selectedEntry;

  const biz = extractBusinessFields(target.fields);
  const statusText = reconcileStatusText({
    domStatusText: target.statusText,
    sourceStatusText: rec.sourceStatusText,
    caseType: target.caseType,
    pageKind,
  });
  const raw = {
    statusText,
    caseType: target.caseType,
    pageKind,
    // 网上立案列表只提供 A/B/C/E/I/J/K 事实；成功日期和案号必须由
    // “我的案件”中的严格唯一搜索结果补齐，不能提前写入 F/G。
    caseNumber: pageKind === "mycase" ? biz.caseNumber : null,
    filedTime: pageKind === "mycase" ? biz.filedDate : null,
  };
  const status = recognizeStatus({ statusText: raw.statusText, caseType: raw.caseType, pageKind });
  if (status === "已驳回") {
    raw.rejectReason = biz.auditOpinion ?? null;
    await triggerDetailCapture({ uid, kind, target: targetElement });
    const ok = await waitFor(async () => {
      const pending = await chrome.runtime.sendMessage({ type: "CASE_DETAIL_PENDING_GET" });
      return pending?.ok === true && pending.pendingDetail == null;
    }, 30000, 1000);
    const updated = await db.getByUid(store, uid);
    if (ok && updated) {
      raw.rejectTime = updated.rejectTime;
      raw.rejectReason = updated.rejectReason ?? raw.rejectReason ?? null;
      raw.rejectImage = updated.rejectImage ?? null;
      raw.evidenceError = updated.errorCode ?? null;
    } else {
      const error = new Error("DETAIL_TIMEOUT");
      error.partialResult = { ...raw, evidenceError: "DETAIL_TIMEOUT" };
      throw error;
    }
  } else if (status === "立案成功" || status === "强执成功") {
    raw.image = await captureRow(targetElement);
  }
  return raw;
}

/** 截图（成功类状态在列表页截行） */
async function captureRow(target) {
  try {
    if (!target?.isConnected) throw new Error("SCREENSHOT_TARGET_UNAVAILABLE");
    return await captureElement(target);
  } catch (e) {
    console.warn("[court-helper] 行截图失败", e);
    return null;
  }
}

/** 批量执行入口（START_BATCH 消息） */
async function startBatch(kind, { account = null, platformAccountId = null, syncPersistence = null } = {}) {
  if (!ensureListReady()) throw new Error("NOT_READY");
  if (kind === "qz") {
    const rows = collectListRows(document);
    if (!rows.some((row) => isEnforcementCaseType(row.caseType))) {
      throw new Error("EXECUTION_TAB_REQUIRED");
    }
  }
  const store = kind === "qz" ? db.STORE_ENFORCEMENT : db.STORE_CASES;
  const all = await db.query(store, {
    ...(account ? { account } : {}),
    ...(platformAccountId ? { platformAccountId } : {}),
  });
  if (!all.length) throw new Error("NO_CASES");
  if (all.length > 50) throw new Error("BATCH_LIMIT_EXCEEDED");
  const total = all.length;
  showToast(`开始批量查询 ${total} 条（${kind === "qz" ? "强执" : "立案"}），请勿切换页面`, 8000);
  _batchRunning = true;
  _batchPaused = false;
  _panel?.setProgress({ done: 0, total, groups: groupByAccount(all) });

  let done = 0;
  let firstManualError = null;
  const stats = await runBatch({
    cases: all.map((r) => ({
      uid: r.uid,
      kind,
      account: r.account,
      platformAccountId: r.platformAccountId ?? platformAccountId,
      plaintiff: r.plaintiff,
    })),
    pageOps: {
      queryCase,
      async capture() {
        // 成功类截图：列表行截图已在 queryCase 内捕获；此处兜底返回 null（由 onUpdate 处理）
        return null;
      },
    },
    timing: { delay: delayWithPause },
    syncPersistence,
    onUpdate: async (record) => {
      if (record.needsHuman && firstManualError === null) {
        const code = record.error ?? record.errorCode;
        firstManualError = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
          ? code
          : "NEEDS_HUMAN";
      }
      const storeName = record.kind === "qz" ? db.STORE_ENFORCEMENT : db.STORE_CASES;
      const existing = await db.getByUid(storeName, record.uid);
      const preservedStatus = record.status === "UNKNOWN" && existing?.status
        ? existing.status
        : record.status;
      const successImage = record.successImage
        ?? (preservedStatus !== "已驳回" ? record.image : null)
        ?? existing?.successImage
        ?? null;
      const rejectImage = record.rejectImage
        ?? (preservedStatus === "已驳回" ? record.image : null)
        ?? existing?.rejectImage
        ?? null;
      await db.upsertByUid(storeName, record.uid, {
        ...existing,
        ...record,
        status: preservedStatus,
        filedTime: record.filedTime ?? existing?.filedTime ?? null,
        caseNumber: record.caseNumber ?? existing?.caseNumber ?? null,
        rejectTime: record.rejectTime ?? existing?.rejectTime ?? null,
        rejectReason: record.rejectReason ?? existing?.rejectReason ?? null,
        successImage,
        rejectImage,
        needsHuman: record.needsHuman
          || (!successImage && ["立案成功", "强执成功"].includes(preservedStatus))
          || (!rejectImage && preservedStatus === "已驳回"),
      });
      done += 1;
      _panel?.setProgress({ done, total, groups: groupByAccount(all) });
      showToast(`进度 ${done}/${total}：${record.status}`, 2500);
    },
  });
  _batchRunning = false;
  return stats.needsHuman > 0
    ? { ok: false, error: firstManualError ?? "NEEDS_HUMAN", stats }
    : { ok: true, stats };
}

/** 空白模板：当前真实列表是案件事实源，先验证完再替换当前账号本地记录。 */
function expectedSuccessStatus(kind) {
  return kind === "qz" ? "强执成功" : "立案成功";
}

function recordManualError(record) {
  for (const code of [record?.errorCode, record?.error]) {
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  }
  return null;
}

async function persistMyCaseEvidence(record, selection, syncPersistence) {
  const existingManualError = recordManualError(record);
  const update = selection.ok
    ? { ...record, ...selection.value, needsHuman: record.needsHuman === true, errorCode: existingManualError }
    : { ...record, needsHuman: true, errorCode: existingManualError ?? selection.error };
  await persistSyncRecord(update, syncPersistence);
  return update;
}

async function completeMyCaseEvidenceFromApi({ kind = "li", account, platformAccountId, sourceApiRows, fetchImpl, syncPersistence }) {
  const store = kind === "qz" ? db.STORE_ENFORCEMENT : db.STORE_CASES;
  const candidates = (await db.query(store, { account, platformAccountId }))
    .filter((record) => record.status === expectedSuccessStatus(kind))
    .filter((record) => !record.caseNumber || !record.filedTime);
  let completed = 0;
  let needsHuman = 0;
  let firstError = null;
  const fetchEvidence = memoizeAsync(
    async ({ body }) => {
      const result = await fetchMyCases({ fetchImpl, pageSize: 50, body });
      if (!result.ok) throw result;
      return result;
    },
    ({ body }) => JSON.stringify({ kind, body }),
  );
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const record = candidates[candidateIndex];
    const sourceSelection = selectSourceApiRow(record, sourceApiRows);
    const sourceApiRow = sourceSelection.ok ? sourceSelection.row : null;
    let selection = sourceSelection.ok
      ? { ok: false, error: "MYCASE_EVIDENCE_UNAVAILABLE" }
      : sourceSelection;
    if (sourceApiRow && record.plaintiff) {
      const result = await fetchEvidence({
        body: {
          ajlb: kind === "qz" ? EXECUTION_CASE_CATEGORIES : CIVIL_CASE_CATEGORIES,
          searchtext: record.plaintiff,
          ajzt: "",
          sfid: "",
          sort: "",
        },
      }).catch((error) => error?.ok === false ? error : { ok: false, code: "MYCASE_EVIDENCE_UNAVAILABLE" });
      selection = result.ok
        ? selectMyCaseApiEvidence({ kind, record, sourceApiRow, rows: result.rows })
        : { ok: false, error: result.code ?? "MYCASE_EVIDENCE_UNAVAILABLE" };
    }
    const updated = await persistMyCaseEvidence(record, selection, syncPersistence);
    if (selection.ok && !updated.needsHuman) completed += 1;
    else {
      needsHuman += 1;
      firstError = preferEvidenceError(firstError, evidenceFailureCode({ selection, updated }));
    }
    if (candidateIndex + 1 < candidates.length) await delayWithPause();
  }
  return { total: candidates.length, completed, needsHuman, error: firstError };
}

async function startPlatformDiscovery(kind, { platformAccountId = null, allowEmpty = false } = {}) {
  const currentRoute = location.hash.split("?", 1)[0];
  if (currentRoute !== ONLINE_FILING_ROUTE) {
    throw new Error("ONLINE_FILING_PAGE_REQUIRED");
  }
  if (!ensureListReady()) throw new Error("NOT_READY");
  if (typeof platformAccountId !== "string" || !platformAccountId) throw new Error("PLATFORM_ACCOUNT_UNAVAILABLE");
  const account = getCurrentAccount(document);
  if (!account) throw new Error("ACCOUNT_UNDETECTED");
  const sendMessage = globalThis.chrome?.runtime?.sendMessage?.bind(globalThis.chrome.runtime);
  if (typeof sendMessage !== "function") throw new Error("CASE_SYNC_UNAVAILABLE");
  const syncPersistence = { db, outbox: createRuntimeCaseOutbox({ sendMessage }) };
  const store = kind === "qz" ? db.STORE_ENFORCEMENT : db.STORE_CASES;
  let rows = collectListRows(document);
  if (!rows.length && !allowEmpty) throw new Error("NO_VISIBLE_CASES");
  // In the real page, the API count is the authoritative page-size guard.
  // JSDOM fixtures intentionally do not expose window.fetch and keep their
  // deterministic DOM-only path.
  const structuredFetch = typeof chrome?.runtime?.id === "string"
    ? createMainWorldFetch(chrome.runtime.sendMessage.bind(chrome.runtime))
    : (typeof globalThis.fetch === "function" && globalThis.fetch.name !== "fetch" ? globalThis.fetch : null);
  if ((kind === "li" || allowEmpty) && !structuredFetch) throw new Error("BRIDGE_UNAVAILABLE");
  if (!structuredFetch && kind === "qz" && rows.length > 0
    && !rows.some((row) => isEnforcementCaseType(row.caseType))) throw new Error("EXECUTION_TAB_REQUIRED");
  let sourceApiRows = [];
  let discoveryRows = rows;
  if (structuredFetch) {
    const readApi = () => fetchLayyPages({
      kind,
      filters: { cxtj: "", kssj: "", jssj: "", zt: "", ajlb: kind === "qz" ? "zx" : "sp", sfid: "", sqrsf: "" },
      pageSize: 50,
      fetchImpl: structuredFetch,
    });
    const readDom = () => {
      const rawValue = collectListRows(document);
      const reportableMask = rawValue.map((row) => {
        const statusText = String(row?.statusText ?? "").trim();
        return statusText ? isApprovedLayyStatusText(statusText) : null;
      });
      const value = rawValue.filter((_row, index) => reportableMask[index] !== false);
      const identities = value.map((row) => {
        const participants = parseParticipantField(findField(row.fields, "参与人"), kind);
        return {
          caseName: String(row.caseName ?? "").trim(),
          applicant: participants.plaintiff,
          respondent: participants.defendant,
          cause: String(findField(row.fields, "案由") ?? "").trim(),
          applicationDate: String(findField(row.fields, "申请日期") ?? "").trim(),
        };
      });
      return { value, rows: identities, rawTotal: rawValue.length, reportableMask };
    };
    const reconciled = await reconcileApiDomRows({
      readApi,
      readDom,
      waitForQuiet: () => waitForListQuiet(document),
    });
    if (!reconciled.ok) throw new Error(reconciled.code ?? "UNKNOWN");
    const apiResult = reconciled.api;
    rows = reconciled.dom.value;
    sourceApiRows = apiResult.rows;
    const confirmedEmpty = apiResult.total === 0 && rows.length === 0;
    if (confirmedEmpty && (allowEmpty || Number(apiResult.rawTotal) > 0)) {
      await db.replaceAccountRecords(store, account, [], { platformAccountId });
      return { ok: true, stats: { total: 0, completed: 0, needsHuman: 0 } };
    }
    discoveryRows = rows.map((row, index) => ({
      ...row,
      sourceStatusText: apiResult.rows[index].statusText,
    }));
  }
  const records = buildPlatformDiscoveryRecords({ account, platformAccountId, kind, rows: discoveryRows });
  await db.replaceAccountRecords(store, account, records, { platformAccountId });
  const initial = await startBatch(kind, { account, platformAccountId, syncPersistence });
  if (kind === "qz" && !structuredFetch) {
    if (!initial.ok) return initial;
    const pendingEvidence = (await db.query(store, { account, platformAccountId }))
      .some((record) => record.status === expectedSuccessStatus(kind)
        && (!record.caseNumber || !record.filedTime));
    return pendingEvidence
      ? { ok: false, error: "MYCASE_PAGE_REQUIRED", stats: initial.stats }
      : { ok: true, stats: initial.stats };
  }
  _batchRunning = true;
  try {
    const evidence = await completeMyCaseEvidenceFromApi({
      kind,
      account,
      platformAccountId,
      sourceApiRows,
      fetchImpl: structuredFetch,
      syncPersistence,
    });
    return !initial.ok
      ? { ...initial, evidence }
      : evidence.needsHuman
      ? {
        ok: false,
        error: evidence.error ?? "MYCASE_EVIDENCE_UNAVAILABLE",
        progress: { done: evidence.completed, total: evidence.total },
        stats: initial.stats,
        evidence,
      }
      : { ok: true, stats: initial.stats, evidence };
  } finally {
    _batchRunning = false;
  }
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
    if (message.queryMode === "platform_discovery") {
      return startPlatformDiscovery(kind, { platformAccountId: message.platformAccountId });
    }
    return { ok: false, error: "TEMPLATE_NOT_EMPTY" };
  }
  if (message.commandType === "EXPORT_REPORT") {
    ensureListReady();
    return handlePanelExport({
      platformAccountId: message.platformAccountId,
      accountLabel: message.accountLabel,
      exportCredential: message.exportCredential,
      salesperson: message.salesperson,
      accountBindingVerified: message.accountBindingVerified === true,
    });
  }
  if (message.commandType === "QUERY_ALL_EXPORT") {
    if (message.queryMode !== "platform_discovery") return { ok: false, error: "TEMPLATE_NOT_EMPTY" };
    if (message.accountBindingVerified !== true) return { ok: false, error: "ACCOUNT_BINDING_REQUIRED" };
    return runQueryAllExport({
      switchCategory: (kind) => switchQueryCategory(document, kind),
      queryKind: (kind) => startPlatformDiscovery(kind, { platformAccountId: message.platformAccountId, allowEmpty: true }),
      exportReport: () => handlePanelExport({
        platformAccountId: message.platformAccountId,
        accountLabel: message.accountLabel,
        exportCredential: message.exportCredential,
        salesperson: message.salesperson,
        accountBindingVerified: true,
      }),
    });
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
      route: location.hash.split("?", 1)[0],
      state: detectLoginState({ hash: location.hash, root: document }),
      ready: isBrowserCommandReady(),
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
