import assert from "node:assert/strict";
import { test } from "node:test";

import { VERSION, handleMessage, sanitizeLoginState } from "../extension/shared/message-router.js";

test("PING → PONG", () => {
  const res = handleMessage({ type: "PING" });
  assert.equal(res.type, "PONG");
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.version, VERSION);
});

test("未知类型 → ERROR", () => {
  const res = handleMessage({ type: "WHATEVER" });
  assert.equal(res.type, "ERROR");
  assert.equal(res.payload.code, "UNKNOWN_TYPE");
  assert.equal(res.payload.type, "WHATEVER");
});

test("登录态消息只保留脱敏会话字段，丢弃凭据和原始账号", () => {
  const sanitized = sanitizeLoginState({
    type: "LOGIN_STATE",
    state: "logged-in",
    maskedAccount: "3503****52X",
    updatedAt: 123,
    account: "3503123452X",
    password: "demo-password",
    captcha: "A7x2",
  });
  assert.deepEqual(sanitized, {
    state: "logged-in",
    maskedAccount: "3503****52X",
    updatedAt: 123,
  });
  assert.equal(JSON.stringify(sanitized).includes("demo-password"), false);
  assert.equal(JSON.stringify(sanitized).includes("3503123452X"), false);
});

test("handleMessage：LOGIN_STATE 返回相同的脱敏 payload", () => {
  const res = handleMessage({
    type: "LOGIN_STATE",
    state: "session-expired",
    maskedAccount: "",
    updatedAt: 456,
    password: "demo-password",
  });
  assert.equal(res.type, "LOGIN_STATE_ACK");
  assert.deepEqual(res.payload, { state: "session-expired", maskedAccount: "", updatedAt: 456 });
});
