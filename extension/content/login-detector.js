// login-detector.js — 登录状态检测与当前账号识别（纯函数）
// 依据 docs/engineering/platform-recon-2026-08-03.md：
// - 登录页路由 #/pagesGrxx/pc/login*；
// - 已登录标志：顶栏用户区 .fd-header-operate .fd-user-name 有账号文本。
// 登录全人工（插件不碰登录表单/凭据，见 login-module 规格）。
import { SELECTORS } from "./selectors.js";

/** 当前是否在登录页路由 */
function isLoginHash(hash = "") {
  return hash.includes("pagesGrxx/pc/login");
}

/**
 * 检测登录状态。
 * @param {{hash?: string, root?: object}} input 页面 hash 与 DOM root（document）
 * @returns {'login'|'logged-in'|'session-expired'|'unknown'}
 */
export function detectLoginState({ hash = "", root } = {}) {
  if (!root || typeof root.querySelector !== "function") return "unknown";
  if (isLoginHash(hash)) return "login";
  const userNameEl = root.querySelector(SELECTORS.header.userName);
  if (userNameEl?.innerText?.trim()) return "logged-in";
  // 非登录页但用户区缺失 → 疑似会话失效（由调用方在页面稳定后判定）
  return "session-expired";
}

/** 读取当前登录账号名；无则返回 null */
export function getCurrentAccount(root, selectors = SELECTORS) {
  if (!root || typeof root.querySelector !== "function") return null;
  const el = root.querySelector(selectors.header.userName);
  return el?.innerText?.trim() ?? null;
}
