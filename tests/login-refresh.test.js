// login-refresh 测试：SPA 异步渲染下登录状态判定（防误报"已过期"）
// 根因：content script 在 document_start 注入，用户区可能尚未渲染；
// 直接判定 session-expired 会把"还没渲染"误判为"会话过期"。
import assert from "node:assert/strict";
import { test } from "node:test";

import { detectLoginStateWhenStable } from "../extension/content/login-detector.js";

function makeRoot(userNameText) {
  return {
    querySelector(sel) {
      if (sel === ".fd-header-operate .fd-user-name") {
        return userNameText === undefined ? null : { innerText: userNameText };
      }
      return null;
    },
  };
}

/** 模拟异步渲染：wait 回调在 N 次后返回 true（用户区出现） */
function asyncWait(untilTrue, { timeoutMs = 5000, intervalMs = 0 } = {}) {
  let attempts = 0;
  return async () => {
    attempts += 1;
    return untilTrue(attempts);
  };
}

test("页面稳定后用户区出现 → 判定 logged-in（修复误报根因）", async () => {
  // 模拟 SPA 异步渲染：开始无用户区，wait 期间用户区出现
  let rendered = false;
  const root = {
    querySelector(sel) {
      if (sel === ".fd-header-operate .fd-user-name") {
        return rendered ? { innerText: "罗虎" } : null;
      }
      return null;
    },
  };
  const state = await detectLoginStateWhenStable({
    hash: "#/pagesWsla/pc/list/index",
    root,
    wait: async () => {
      rendered = true; // 第一次 wait 后用户区渲染完成
    },
    timeoutMs: 500,
  });
  assert.equal(state, "logged-in", "用户区渲染后应判定已登录");
});

test("一直无用户区（真实会话过期）→ 仍判定 session-expired", async () => {
  const state = await detectLoginStateWhenStable({
    hash: "#/pagesWsla/pc/list/index",
    root: makeRoot(undefined),
    wait: asyncWait(() => false, { intervalMs: 0 }),
    timeoutMs: 300,
  });
  assert.equal(state, "session-expired");
});

test("用户区立即可见 → 直接判定 logged-in，不等待", async () => {
  const state = await detectLoginStateWhenStable({
    hash: "#/pagesWsla/pc/list/index",
    root: makeRoot("账号A"),
    wait: asyncWait(() => true, { intervalMs: 0 }),
    timeoutMs: 300,
  });
  assert.equal(state, "logged-in");
});

test("登录页路由 → login（不等待用户区）", async () => {
  const state = await detectLoginStateWhenStable({
    hash: "#/pagesGrxx/pc/login/index",
    root: makeRoot(undefined),
    wait: asyncWait(() => false, { intervalMs: 0 }),
    timeoutMs: 300,
  });
  assert.equal(state, "login");
});

test("等待超时但期间用户区曾出现 → 取最终判定（幂等）", async () => {
  const root = makeRoot("账号B");
  const state = await detectLoginStateWhenStable({
    hash: "#/pagesWsla/pc/list/index",
    root,
    wait: asyncWait(() => true, { intervalMs: 0 }),
    timeoutMs: 50,
  });
  assert.equal(state, "logged-in");
});
