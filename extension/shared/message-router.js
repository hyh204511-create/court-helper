// 消息路由纯逻辑（可单测；service-worker 与 popup 共用）
export const VERSION = "0.1.0";
const LOGIN_STATES = new Set(["login", "logged-in", "session-expired", "unknown"]);

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

export function handleMessage(msg = {}) {
  switch (msg.type) {
    case "PING":
      return { type: "PONG", payload: { ok: true, version: VERSION } };
    case "LOGIN_STATE":
      return { type: "LOGIN_STATE_ACK", payload: sanitizeLoginState(msg) };
    default:
      return { type: "ERROR", payload: { code: "UNKNOWN_TYPE", type: msg.type } };
  }
}
