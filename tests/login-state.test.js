import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { createLoginStateMessage, maskAccount } from "../extension/content/login-detector.js";

let importSequence = 0;
let globalsQueue = Promise.resolve();

async function withGlobals(callback) {
  const previous = globalsQueue;
  let release;
  globalsQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

function cleanupGlobals(dom, names) {
  dom?.window.close();
  for (const name of names) delete globalThis[name];
}

test("maskAccount 保留可辨识片段但不返回完整账号", () => {
  assert.equal(maskAccount("3503123452X"), "3503****52X");
  assert.equal(maskAccount("A"), "*");
  assert.equal(maskAccount("AB"), "A****B");
  assert.equal(maskAccount(""), "");
  const full = "913500000000000000";
  assert.notEqual(maskAccount(full), full);
  assert.equal(maskAccount(full).includes(full), false);
});

test("登录态消息先脱敏，消息只含允许字段", () => {
  const full = "3503123452X";
  assert.deepEqual(createLoginStateMessage({ state: "logged-in", account: full, updatedAt: 123 }), {
    type: "LOGIN_STATE",
    state: "logged-in",
    maskedAccount: "3503****52X",
    updatedAt: 123,
  });
  assert.deepEqual(createLoginStateMessage({ state: "session-expired", account: full, updatedAt: 124 }), {
    type: "LOGIN_STATE",
    state: "session-expired",
    maskedAccount: "",
    updatedAt: 124,
  });
});

test("content 登录态上报 login/logged-in/session-expired，过期暂停且恢复不自动继续", async () => {
  await withGlobals(async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://zxfw.court.gov.cn/zxfw/#/pagesWsla/pc/list/index",
    });
    const sent = [];
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.location = dom.window.location;
    globalThis.chrome = {
      runtime: {
        sendMessage(message) {
          sent.push(message);
          return Promise.resolve();
        },
        onMessage: { addListener() {} },
      },
      storage: { session: { get: async () => ({}), set: async () => undefined } },
    };
    const module = await import(`../extension/content/court-content.js?login-state-test=${importSequence++}`);

    module.handleLoginState("login", null, { now: () => 1000 });
    module.handleLoginState("logged-in", "3503123452X", { now: () => 1001 });
    module.handleLoginState("session-expired", "3503123452X", { now: () => 1002 });
    assert.deepEqual(sent, [
      { type: "LOGIN_STATE", state: "login", maskedAccount: "", updatedAt: 1000 },
      { type: "LOGIN_STATE", state: "logged-in", maskedAccount: "3503****52X", updatedAt: 1001 },
      { type: "LOGIN_STATE", state: "session-expired", maskedAccount: "", updatedAt: 1002 },
    ]);
    assert.equal(JSON.stringify(sent).includes("3503123452X"), false);
    assert.equal(module.getBatchState().paused, true);
    module.handleLoginState("logged-in", "3503123452X", { now: () => 1003 });
    assert.equal(module.getBatchState().paused, true);

    const refreshes = [];
    const stop = module.observeLoginState({
      root: dom.window.document,
      view: dom.window,
      refresh: () => { refreshes.push(dom.window.location.hash); },
    });
    dom.window.location.hash = "#/pagesWsla/pc/list/index";
    dom.window.dispatchEvent(new dom.window.Event("hashchange"));
    const userArea = dom.window.document.createElement("div");
    userArea.className = "fd-header-operate";
    userArea.innerHTML = '<span class="fd-user-name">3503123452X</span>';
    dom.window.document.body.append(userArea);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.ok(refreshes.length >= 1);
    stop();
    cleanupGlobals(dom, ["window", "document", "location", "chrome"]);
  });
});

test("service worker 登录态持久化只写 state/maskedAccount/updatedAt，忽略 AUTO_LOGIN", async () => {
  await withGlobals(async () => {
    const runtimeListeners = [];
    const storageWrites = [];
    const selfListeners = [];
    globalThis.self = {
      addEventListener(type, listener) {
        selfListeners.push({ type, listener });
      },
      skipWaiting() {},
      clients: { claim() {} },
    };
    globalThis.chrome = {
      runtime: { onMessage: { addListener(listener) { runtimeListeners.push(listener); } } },
      storage: { local: { set: async (value) => { storageWrites.push(value); } } },
    };
    await import(`../extension/service-worker.js?login-state-test=${importSequence++}`);
    assert.equal(runtimeListeners.length, 1);
    const listener = runtimeListeners[0];
    let response;
    assert.equal(listener({
      type: "LOGIN_STATE",
      state: "logged-in",
      maskedAccount: "3503****52X",
      updatedAt: 123,
      account: "3503123452X",
      password: "demo-password",
      captcha: "A7x2",
    }, {}, (value) => { response = value; }), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(storageWrites, [{ state: "logged-in", maskedAccount: "3503****52X", updatedAt: 123 }]);
    assert.deepEqual(response, { ok: true });
    assert.equal(JSON.stringify(storageWrites).includes("demo-password"), false);
    assert.equal(JSON.stringify(storageWrites).includes("3503123452X"), false);

    let autoResponse;
    assert.equal(listener({ type: "AUTO_LOGIN", account: "3503123452X", password: "demo-password" }, {}, (value) => { autoResponse = value; }), false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(autoResponse, undefined);
    assert.equal(storageWrites.length, 1);
    assert.ok(selfListeners.some(({ type }) => type === "install"));
    cleanupGlobals(null, ["self", "chrome"]);
  });
});
