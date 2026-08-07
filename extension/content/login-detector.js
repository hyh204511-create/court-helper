// login-detector.js — 登录状态检测与当前账号识别（纯函数）
// 依据 docs/engineering/platform-recon-2026-08-03.md：
// - 登录页路由 #/pagesGrxx/pc/login*；
// - 已登录标志：顶栏用户区 .fd-header-operate .fd-user-name 有账号文本。
// 自动登录为可选流程；本文件只负责无凭据的状态/路由检测。
import { SELECTORS } from "./selectors.js";

const LOGIN_STATES = new Set(["login", "logged-in", "session-expired", "unknown"]);
const COURT_LIST_ROUTES = new Set([
  "#/pagesWsla/pc/list/index",
  "#/pages/pc/case-list/index",
]);

/** 账号脱敏：保留最小可辨识前后片段，不返回完整身份证/统一社会信用代码。 */
export function maskAccount(account) {
  const value = account == null ? "" : String(account).trim();
  if (!value) return "";
  if (value.length === 1) return "*";
  if (value.length <= 4) return `${value[0]}****${value[value.length - 1]}`;
  return `${value.slice(0, 4)}****${value.slice(-3)}`;
}

/** 构造只含脱敏会话信息的 runtime 消息。 */
export function createLoginStateMessage({ state = "unknown", account = null, updatedAt = Date.now() } = {}) {
  const safeState = LOGIN_STATES.has(state) ? state : "unknown";
  return {
    type: "LOGIN_STATE",
    state: safeState,
    maskedAccount: safeState === "logged-in" ? maskAccount(account) : "",
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

/** 当前是否在登录页路由 */
export function isLoginRoute(hash = "") {
  const value = typeof hash === "string" ? hash : "";
  const prefix = SELECTORS.route.login;
  return value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`);
}

/** 仅允许规格列出的两条法院案件列表路由；忽略其 query 参数。 */
export function isCourtListRoute(hash = "") {
  const value = typeof hash === "string" ? hash : "";
  return COURT_LIST_ROUTES.has(value.split("?", 1)[0]);
}

/**
 * 检测登录状态。
 * @param {{hash?: string, root?: object}} input 页面 hash 与 DOM root（document）
 * @returns {'login'|'logged-in'|'session-expired'|'unknown'}
 */
export function detectLoginState({ hash = "", root } = {}) {
  if (!root || typeof root.querySelector !== "function") return "unknown";
  if (isLoginRoute(hash)) return "login";
  const userNameEl = root.querySelector(SELECTORS.header.userName);
  if ((userNameEl?.textContent ?? userNameEl?.innerText ?? "").toString().trim()) return "logged-in";
  // 非登录页但用户区缺失 → 疑似会话失效（由调用方在页面稳定后判定）
  return "session-expired";
}

/** 读取当前登录账号名；无则返回 null */
export function getCurrentAccount(root, selectors = SELECTORS) {
  if (!root || typeof root.querySelector !== "function") return null;
  const el = root.querySelector(selectors.header.userName);
  return (el?.textContent ?? el?.innerText ?? "").toString().trim() || null;
}

/**
 * 等待页面稳定后再判定登录状态（SPA 异步渲染防误报）。
 * content script 在 document_start 注入时用户区可能尚未渲染，直接判定
 * session-expired 会把"还没渲染"误判为"会话过期"。本函数先等待用户区
 * 出现（或超时），再按最终 DOM 判定。
 * @param {{hash?: string, root?: object, wait?: (() => Promise<boolean>)|null, timeoutMs?: number, intervalMs?: number}} input
 * @returns {Promise<'login'|'logged-in'|'session-expired'|'unknown'>}
 */
export async function detectLoginStateWhenStable({
  hash = "",
  root,
  wait = null,
  timeoutMs = 5000,
  intervalMs = 300,
} = {}) {
  if (!root || typeof root.querySelector !== "function") return "unknown";
  // 登录页路由：无需等待用户区
  if (isLoginRoute(hash)) return "login";
  // 用户区立即可见 → 直接判定
  const userNameEl = root.querySelector(SELECTORS.header.userName);
  if ((userNameEl?.textContent ?? userNameEl?.innerText ?? "").toString().trim()) return "logged-in";
  // 用户区暂缺 → 等待其出现（SPA 渲染），超时后按最终 DOM 判定
  if (typeof wait === "function") {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await wait();
      const el = root.querySelector(SELECTORS.header.userName);
      if ((el?.textContent ?? el?.innerText ?? "").toString().trim()) return "logged-in";
    }
  }
  return detectLoginState({ hash, root });
}
