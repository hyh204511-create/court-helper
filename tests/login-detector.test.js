import assert from "node:assert/strict";
import { test } from "node:test";

import { detectLoginState, getCurrentAccount } from "../extension/content/login-detector.js";

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

test("登录页路由 → login", () => {
  assert.equal(detectLoginState({ hash: "#/pagesGrxx/pc/login/index", root: makeRoot() }), "login");
  assert.equal(detectLoginState({ hash: "#/pagesGrxx/pc/login/xxx", root: makeRoot() }), "login");
});

test("已登录（用户区有账号文本）→ logged-in", () => {
  const root = makeRoot("测试账号");
  assert.equal(detectLoginState({ hash: "#/pagesWsla/pc/list/index", root }), "logged-in");
});

test("非登录页但用户区缺失 → session-expired（会话失效）", () => {
  assert.equal(detectLoginState({ hash: "#/pagesWsla/pc/list/index", root: makeRoot() }), "session-expired");
});

test("getCurrentAccount：读取当前登录账号；缺失返回 null", () => {
  assert.equal(getCurrentAccount(makeRoot("测试账号")), "测试账号");
  assert.equal(getCurrentAccount(makeRoot("  账号A  ")), "账号A");
  assert.equal(getCurrentAccount(makeRoot()), null);
  assert.equal(getCurrentAccount(null), null);
});

test("异常输入容错 → unknown", () => {
  assert.equal(detectLoginState({}), "unknown");
  assert.equal(detectLoginState({ hash: "#/pagesWsla/pc/list/index" }), "unknown");
});
