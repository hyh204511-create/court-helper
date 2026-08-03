// court-content.js — 平台页内容脚本（列表页批量执行 + 详情页自动取证）
// 经 esbuild 打包为 ../dist/court-content.bundle.js（manifest 引用）
// 依据 docs/specs/query-module.md 与 app-module.md：
// - 登录全人工：批量执行前校验已登录 + 当前账号与案件账号一致（不一致 → 待人工切换）；
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
import { detectLoginState, getCurrentAccount } from "./login-detector.js";
import { captureElement } from "./screen-capturer.js";
import { runBatch, RETRY_COUNT } from "../data/batch-runner.js";
import { recognizeStatus } from "./status-recognizer.js";
import * as db from "../data/db.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isDetailPage = () => location.hash.includes("wsla/detail");
const isListPage = () => location.hash.includes("list/index");

// —— 页面内进度提示（轻量，不依赖 popup 打开） ——
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
  if (state === "login") throw new Error("NOT_LOGGED_IN");
  if (state === "session-expired") throw new Error("SESSION_EXPIRED");
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
  const store = kind === "qz" ? db.STORE_ENFORCEMENT : db.STORE_CASES;
  const all = await db.query(store, {});
  if (!all.length) throw new Error("NO_CASES");
  showToast(`开始批量查询 ${Math.min(all.length, 50)} 条（${kind === "qz" ? "强执" : "立案"}），请勿切换页面`, 8000);

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
      showToast(`进度 ${done}/${stats?.total ?? "?"}：${record.status}`, 2500);
    },
  });
  return { ok: true, stats };
}

// —— 消息监听 ——
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "START_BATCH") {
    startBatch(msg.kind === "qz" ? "qz" : "li")
      .then((resp) => sendResponse(resp))
      .catch((e) => sendResponse({ ok: false, error: e.message ?? String(e) }));
    return true; // 异步响应
  }
  if (msg?.type === "PING") {
    sendResponse({ ok: true, role: isDetailPage() ? "detail" : "list" });
    return false;
  }
  return false;
});

// —— 页面加载完成后的角色分发 ——
(async () => {
  try {
    if (isDetailPage()) {
      await runDetailCapture();
    } else if (isListPage()) {
      // 预校验选择器（改版检测）：列表页就绪时探测，失效则 toast 提示
      const ok = await waitFor(() => document.querySelectorAll(SELECTORS.list.row).length > 0 || document.body.innerText.includes("暂无数据"), 8000);
      if (ok) {
        try {
          assertSelectors(document);
        } catch (e) {
          showToast(`⚠ 平台页面结构疑似变更（${e.selectorKey}），请暂停使用并联系维护`, 10000);
        }
      }
    }
  } catch (e) {
    console.warn("[court-helper] init error", e);
  }
})();
