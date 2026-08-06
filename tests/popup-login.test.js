import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { createLoginController } from "../extension/popup/login-controller.js";
import {
  LIST_ROUTE,
  LIST_ROUTES,
  canStartBatch,
  createStartBatchSender,
  isListRoute,
  startBatchMessage,
} from "../extension/popup/query-gate.js";

function jsonResponse(payload, ok = true) {
  return { ok, json: async () => payload };
}

function makeDom() {
  return new JSDOM(`
    <!doctype html>
    <html><body>
      <span id="login-status" class="badge badge-off">未登录</span>
      <span id="login-service-status"></span>
      <select id="login-account"></select>
      <button id="btn-auto-login" disabled>一键登录</button>
      <span id="login-result"></span>
    </body></html>
  `);
}

function makeChrome({ tabId = 7, sendResponse = { ok: true }, storageData = {} } = {}) {
  const calls = { query: 0, messages: [], storage: 0, storageWrites: [] };
  return {
    calls,
    tabs: {
      query: async () => {
        calls.query += 1;
        return [{ id: tabId, url: "https://zxfw.court.gov.cn/" }];
      },
      sendMessage: async (_id, message) => {
        calls.messages.push(message);
        return sendResponse;
      },
    },
    storage: {
      local: {
        get: async () => { calls.storage += 1; return storageData; },
        set: async (value) => { calls.storage += 1; calls.storageWrites.push(value); },
      },
    },
  };
}

async function initController({ fetchImpl, chromeApi = makeChrome(), setupDom } = {}) {
  const dom = makeDom();
  setupDom?.(dom.window.document);
  const controller = createLoginController({
    document: dom.window.document,
    fetchImpl,
    chromeApi,
  });
  const result = await controller.init();
  return { dom, controller, chromeApi, result };
}

test("健康检查成功后才读取账号，账号下拉不渲染密码", async () => {
  const calls = [];
  const { dom, controller, chromeApi, result } = await initController({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      return jsonResponse({ ok: true, accounts: [{ account: "acct-one", password: "demo-password with spaces" }] });
    },
  });
  assert.deepEqual(result, { ok: true, accounts: 1, source: "local" });
  assert.deepEqual(calls, [
    "http://127.0.0.1:8765/health",
    "http://127.0.0.1:8765/accounts",
  ]);
  const option = dom.window.document.querySelector("#login-account option");
  assert.equal(option.value, "acct-one");
  assert.equal(option.textContent, "acct-one");
  assert.equal(option.title ?? "", "");
  assert.equal(JSON.stringify(option.dataset).includes("demo-password"), false);
  assert.equal(dom.window.document.body.textContent.includes("demo-password"), false);
  assert.equal(dom.window.document.querySelector("#btn-auto-login").disabled, false);
  assert.equal(chromeApi.calls.storageWrites.length, 0);
  assert.equal(JSON.stringify(chromeApi.calls.storageWrites).includes("demo-password"), false);
  controller.destroy();
  dom.window.close();
});

test("本地服务不可达时显示固定启动提示，不请求账号且不渲染异常正文", async () => {
  const rawError = "private-service-body-demo-password";
  let calls = 0;
  const { dom, controller, result } = await initController({
    fetchImpl: async () => {
      calls += 1;
      throw new Error(rawError);
    },
  });
  assert.deepEqual(result, { ok: false, error: "SERVICE_UNAVAILABLE" });
  assert.equal(calls, 1);
  assert.match(dom.window.document.querySelector("#login-service-status").textContent, /python scripts\/login-helper-server\.py/);
  assert.equal(dom.window.document.body.textContent.includes(rawError), false);
  assert.equal(dom.window.document.querySelector("#btn-auto-login").disabled, true);
  controller.destroy();
  dom.window.close();
});

test("账号列表为空时禁用一键登录", async () => {
  const { dom, controller, result } = await initController({
    fetchImpl: async (url) => url.endsWith("/health")
      ? jsonResponse({ ok: true })
      : jsonResponse({ ok: true, accounts: [] }),
  });
  assert.deepEqual(result, { ok: true, accounts: 0, source: "local" });
  assert.equal(dom.window.document.querySelector("#btn-auto-login").disabled, true);
  assert.equal(dom.window.document.querySelectorAll("#login-account option").length, 0);
  controller.destroy();
  dom.window.close();
});

test("一键登录向当前标签只发送一次 AUTO_LOGIN，密码只在消息中短暂出现", async () => {
  const chromeApi = makeChrome();
  const { dom, controller, result } = await initController({
    chromeApi,
    fetchImpl: async (url) => url.endsWith("/health")
      ? jsonResponse({ ok: true })
      : jsonResponse({ ok: true, accounts: [{ account: "acct-one", password: "demo-password" }] }),
  });
  assert.deepEqual(result, { ok: true, accounts: 1, source: "local" });
  const button = dom.window.document.querySelector("#btn-auto-login");
  button.click();
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(chromeApi.calls.query, 1);
  assert.equal(chromeApi.calls.messages.length, 1);
  assert.deepEqual(chromeApi.calls.messages[0], {
    type: "AUTO_LOGIN",
    account: "acct-one",
    password: "demo-password",
    serviceUrl: "http://127.0.0.1:8765",
  });
  assert.equal(dom.window.document.body.textContent.includes("demo-password"), false);
  assert.match(dom.window.document.querySelector("#login-result").textContent, /登录成功/);
  assert.equal(chromeApi.calls.storageWrites.length, 0);
  assert.equal(JSON.stringify(chromeApi.calls.storageWrites).includes("demo-password"), false);
  controller.destroy();
  dom.window.close();
});

test("服务响应错误正文不进入 UI，销毁 popup 后私有凭据不能再次发送", async () => {
  const chromeApi = makeChrome({ sendResponse: { ok: false, error: "private-service-body-demo-password" } });
  const { dom, controller } = await initController({
    chromeApi,
    fetchImpl: async (url) => url.endsWith("/health")
      ? jsonResponse({ ok: true })
      : jsonResponse({ ok: true, accounts: [{ account: "acct-one", password: "demo-password" }] }),
  });
  const button = dom.window.document.querySelector("#btn-auto-login");
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const resultText = dom.window.document.querySelector("#login-result").textContent;
  assert.match(resultText, /人工/);
  assert.equal(resultText.includes("private-service-body-demo-password"), false);
  const beforeDestroy = chromeApi.calls.messages.length;
  controller.destroy();
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(chromeApi.calls.messages.length, beforeDestroy);
  assert.equal(dom.window.document.body.textContent.includes("demo-password"), false);
  dom.window.close();
});

test("未配置服务器时回退本地 8765 账号服务", async () => {
  const calls = [];
  const chromeApi = makeChrome({ storageData: { serverUrl: "", serverUsername: "" } });
  const { dom, controller, result } = await initController({
    chromeApi,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      return jsonResponse({ ok: true, accounts: [{ account: "local-user", password: "local-secret" }] });
    },
  });
  assert.deepEqual(result, { ok: true, accounts: 1, source: "local" });
  assert.deepEqual(calls, [
    "http://127.0.0.1:8765/health",
    "http://127.0.0.1:8765/accounts",
  ]);
  assert.equal(dom.window.document.querySelector("#login-account option").textContent, "local-user");
  assert.equal(JSON.stringify(chromeApi.calls.storageWrites).includes("local-secret"), false);
  controller.destroy();
  dom.window.close();
});

test("配置服务器后登录、列出平台账号，并在点击时取凭据发送 AUTO_LOGIN", async () => {
  const calls = [];
  const chromeApi = makeChrome({
    storageData: {
      serverUrl: "https://sync.example.test",
      token: "paired-extension-token",
      expiresAt: Date.now() + 60_000,
    },
  });
  const { dom, controller, result } = await initController({
    chromeApi,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url === "https://sync.example.test/api/v1/platform-accounts") {
        assert.equal(init.headers.Authorization, "Bearer paired-extension-token");
        return jsonResponse({
          platformAccounts: [
            { id: "pa-1", label: "Court Primary", enabled: true, updatedAt: "2026-08-05T00:00:00.000Z" },
          ],
        });
      }
      if (url === "https://sync.example.test/api/v1/platform-accounts/pa-1/credential") {
        assert.equal(init.method, "POST");
        assert.equal(init.headers.Authorization, "Bearer paired-extension-token");
        return jsonResponse({ account: "court-user", password: "court-secret" });
      }
      throw new Error(`unexpected url ${url}`);
    },
  });
  assert.deepEqual(result, { ok: true, accounts: 1, source: "server" });
  const option = dom.window.document.querySelector("#login-account option");
  assert.equal(option.value, "pa-1");
  assert.equal(option.textContent, "Court Primary");

  dom.window.document.querySelector("#btn-auto-login").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(chromeApi.calls.messages, [{
    type: "AUTO_LOGIN",
    account: "court-user",
    password: "court-secret",
    serviceUrl: "http://127.0.0.1:8765",
  }]);
  assert.equal(JSON.stringify(calls).includes("server-login-pass"), false);
  assert.equal(JSON.stringify(chromeApi.calls.storageWrites).includes("court-secret"), false);
  assert.equal(dom.window.document.body.textContent.includes("court-secret"), false);
  assert.equal(calls.length, 2);
  controller.destroy();
  dom.window.close();
});

test("服务器不可达时提示服务器不可达且不触发 AUTO_LOGIN", async () => {
  const chromeApi = makeChrome({
    storageData: {
      serverUrl: "https://sync.example.test",
      token: "paired-extension-token",
      expiresAt: Date.now() + 60_000,
    },
  });
  const { dom, controller, result } = await initController({
    chromeApi,
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  assert.deepEqual(result, { ok: false, error: "SERVER_UNREACHABLE" });
  assert.equal(dom.window.document.querySelector("#login-service-status").dataset.state, "offline");
  assert.equal(dom.window.document.querySelector("#btn-auto-login").disabled, true);
  await controller.sendAutoLogin();
  assert.equal(chromeApi.calls.messages.length, 0);
  controller.destroy();
  dom.window.close();
});

test("服务器登录失败时提示登录失败且不触发 AUTO_LOGIN", async () => {
  const chromeApi = makeChrome({
    storageData: {
      serverUrl: "https://sync.example.test",
      token: "paired-extension-token",
      expiresAt: Date.now() + 60_000,
    },
  });
  const { dom, controller, result } = await initController({
    chromeApi,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: "AUTH_REQUIRED" } }),
      text: async () => JSON.stringify({ error: { code: "AUTH_REQUIRED" } }),
    }),
  });
  assert.deepEqual(result, { ok: false, error: "SERVER_AUTH_FAILED" });
  assert.equal(dom.window.document.querySelector("#login-service-status").dataset.state, "auth-failed");
  await controller.sendAutoLogin();
  assert.equal(chromeApi.calls.messages.length, 0);
  controller.destroy();
  dom.window.close();
});

test("取服务器平台凭据失败时提示凭据获取失败且不触发 AUTO_LOGIN", async () => {
  const chromeApi = makeChrome({
    storageData: {
      serverUrl: "https://sync.example.test",
      token: "paired-extension-token",
      expiresAt: Date.now() + 60_000,
    },
  });
  const { dom, controller, result } = await initController({
    chromeApi,
    fetchImpl: async (url) => {
      if (url.endsWith("/auth/login")) return jsonResponse({ token: "opaque-extension-token" });
      if (url.endsWith("/platform-accounts")) {
        return jsonResponse({ platformAccounts: [{ id: "pa-1", label: "Court Primary", enabled: true }] });
      }
      return jsonResponse({ error: { message: "court-secret" } }, false);
    },
  });
  assert.deepEqual(result, { ok: true, accounts: 1, source: "server" });
  const response = await controller.sendAutoLogin();
  assert.deepEqual(response, { ok: false, error: "CREDENTIAL_FETCH_FAILED" });
  assert.equal(chromeApi.calls.messages.length, 0);
  assert.equal(dom.window.document.querySelector("#login-result").dataset.state, "error");
  assert.equal(dom.window.document.body.textContent.includes("court-secret"), false);
  assert.equal(JSON.stringify(chromeApi.calls.storageWrites).includes("opaque-extension-token"), false);
  controller.destroy();
  dom.window.close();
});

test("一键抓取只在已登录立案列表页且未登录操作进行时可用", () => {
  assert.deepEqual(LIST_ROUTES, [
    "#/pagesWsla/pc/list/index",
    "#/pages/pc/case-list/index",
  ]);
  for (const route of LIST_ROUTES) {
    assert.equal(isListRoute(route), true);
    assert.equal(isListRoute(`${route}/`), true);
    assert.equal(isListRoute(`${route}?page=2`), true);
    assert.equal(canStartBatch({ state: "logged-in", route, loginInProgress: false }), true);
  }
  assert.equal(isListRoute("#/pagesWsla/pc/detail/index"), false);
  assert.equal(isListRoute("#/pagesGrxx/pc/login/index"), false);
  assert.equal(canStartBatch({ state: "logged-in", route: LIST_ROUTE, loginInProgress: false }), true);
  assert.equal(canStartBatch({ state: "login", route: LIST_ROUTE, loginInProgress: false }), false);
  assert.equal(canStartBatch({ state: "logged-in", route: "#/pagesGrxx/pc/login/index", loginInProgress: false }), false);
  assert.equal(canStartBatch({ state: "logged-in", route: LIST_ROUTE, loginInProgress: true }), false);
  assert.deepEqual(startBatchMessage(), { type: "START_BATCH", kind: "li" });
  assert.deepEqual(startBatchMessage("qz"), { type: "START_BATCH", kind: "qz" });
});

test("一键抓取 sender 快速双击只发送一个既有 START_BATCH 消息", async () => {
  const messages = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const chromeApi = {
    tabs: {
      sendMessage: async (_tabId, message) => {
        messages.push(message);
        await pending;
        return { ok: true };
      },
    },
  };
  const sendStartBatch = createStartBatchSender({ chromeApi });
  const first = sendStartBatch(7);
  const second = sendStartBatch(7);
  assert.equal(first, second);
  release();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(messages, [{ type: "START_BATCH", kind: "li" }]);
});
