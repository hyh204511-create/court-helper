// 消息路由纯逻辑（可单测；service-worker 与 popup 共用）
export const VERSION = "0.1.0";

export function handleMessage(msg = {}) {
  switch (msg.type) {
    case "PING":
      return { type: "PONG", payload: { ok: true, version: VERSION } };
    default:
      return { type: "ERROR", payload: { code: "UNKNOWN_TYPE", type: msg.type } };
  }
}
