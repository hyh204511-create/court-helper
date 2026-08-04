// 消息路由纯逻辑（可单测；service-worker 与 popup 共用）
export const VERSION = "0.1.0";
const LOGIN_STATES = new Set(["login", "logged-in", "session-expired", "unknown"]);
const SYNC_STATES = new Set(["disabled", "idle", "syncing", "online", "offline", "paused", "error"]);
const SYNC_CONFLICT_CODES = new Set(["CONFLICT", "ACCOUNT_DISABLED", "NOT_FOUND"]);
const SAFE_SYNC_MESSAGES = new Set([
  "服务器不可达，请重试",
  "页面不可见，已暂停同步",
  "同步失败，请检查后重试",
  "未配置服务器",
]);

export const SYNC_MESSAGE_TYPES = Object.freeze([
  "SYNC_STATUS",
  "SYNC_STATE",
  "SYNC_CURSOR",
  "SYNC_RETRY",
]);

/** 只提取可持久化的脱敏登录态；原始 account/password/captcha 一律忽略。 */
export function sanitizeLoginState(message = {}, now = Date.now) {
  const source = message?.payload && typeof message.payload === "object" ? message.payload : message;
  const state = LOGIN_STATES.has(source?.state) ? source.state : "unknown";
  const candidate = typeof source?.maskedAccount === "string" ? source.maskedAccount.trim() : "";
  const maskedAccount = state === "logged-in" && candidate.includes("****") && candidate.length <= 64 && !/[\u0000-\u001f]/.test(candidate)
    ? candidate
    : "";
  const updatedAt = Number.isFinite(source?.updatedAt) ? source.updatedAt : now();
  return { state, maskedAccount, updatedAt };
}

function safeMaskedAccount(value) {
  if (typeof value !== "string") return "";
  const candidate = value.trim();
  return candidate.length <= 64 && candidate.includes("*") && !/[\u0000-\u001f]/.test(candidate)
    ? candidate
    : "";
}

function safeConflict(value = {}) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  if (typeof value.id === "string" && value.id.length <= 128 && !/[\u0000-\u001f]/.test(value.id)) {
    result.id = value.id;
  }
  if (SYNC_CONFLICT_CODES.has(value.code)) result.code = value.code;
  const maskedAccount = safeMaskedAccount(value.maskedAccount);
  if (maskedAccount) result.maskedAccount = maskedAccount;
  return Object.keys(result).length ? result : null;
}

/** 同步消息只允许状态、游标、计数、最后时间、冲突摘要和脱敏账号。 */
export function sanitizeSyncState(message = {}) {
  const source = message?.payload && typeof message.payload === "object" ? message.payload : message;
  const status = SYNC_STATES.has(source?.status) ? source.status : "idle";
  const cursor = Number.isSafeInteger(source?.cursor) && source.cursor >= 0 ? source.cursor : 0;
  const pendingCount = Number.isSafeInteger(source?.pendingCount) && source.pendingCount >= 0
    ? source.pendingCount
    : 0;
  const lastSyncAt = typeof source?.lastSyncAt === "string"
    && source.lastSyncAt.length <= 64
    && !/[\u0000-\u001f]/.test(source.lastSyncAt)
    ? source.lastSyncAt
    : null;
  const conflicts = Array.isArray(source?.conflicts)
    ? source.conflicts.map(safeConflict).filter(Boolean).slice(0, 50)
    : [];
  const payload = {
    status,
    cursor,
    pendingCount,
    lastSyncAt,
    maskedAccount: safeMaskedAccount(source?.maskedAccount),
    conflicts,
  };
  if (SAFE_SYNC_MESSAGES.has(source?.message)) {
    payload.message = source.message;
  }
  return payload;
}

export function handleMessage(msg = {}) {
  switch (msg.type) {
    case "PING":
      return { type: "PONG", payload: { ok: true, version: VERSION } };
    case "LOGIN_STATE":
      return { type: "LOGIN_STATE_ACK", payload: sanitizeLoginState(msg) };
    case "SYNC_STATUS":
    case "SYNC_STATE":
      return { type: "SYNC_STATUS_ACK", payload: sanitizeSyncState(msg) };
    case "SYNC_CURSOR": {
      const source = msg?.payload && typeof msg.payload === "object" ? msg.payload : msg;
      const cursor = Number.isSafeInteger(source?.cursor) && source.cursor >= 0 ? source.cursor : 0;
      return { type: "SYNC_CURSOR_ACK", payload: { cursor } };
    }
    case "SYNC_RETRY":
      return { type: "SYNC_RETRY_ACK", payload: { ok: true } };
    default:
      return { type: "ERROR", payload: { code: "UNKNOWN_TYPE", type: msg.type } };
  }
}
