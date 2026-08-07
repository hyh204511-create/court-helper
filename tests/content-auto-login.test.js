import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

import * as db from "../extension/data/db.js";

let importSequence = 0;

function makeChrome() {
  const listeners = [];
  return {
    listeners,
    runtime: {
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
      sendMessage: async () => undefined,
    },
    storage: {
      session: {
        get: async () => ({}),
        set: async () => undefined,
      },
    },
  };
}

function setRect(element, rect) {
  element.getBoundingClientRect = () => ({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
  });
}

function prepareLoginClickTargets(document) {
  setRect(document.querySelector("#submit"), { left: 10, top: 20, width: 100, height: 40 });
  const image = document.querySelector("img");
  if (image) setRect(image, { left: 200, top: 60, width: 100, height: 40 });
}

async function loadContent({ hash, html = "<main></main>" }) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: `https://zxfw.court.gov.cn/zxfw/${hash}`,
  });
  const chrome = makeChrome();
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.chrome = chrome;
  const module = await import(`../extension/content/court-content.js?auto-login-test=${importSequence++}`);
  assert.equal(typeof module.observePanelLogin, "function");
  return { dom, chrome, listener: chrome.listeners.at(-1) };
}

async function dispatch(listener, message) {
  let response;
  const returnValue = listener(message, {}, (value) => { response = value; });
  if (returnValue === true) {
    const deadline = Date.now() + 1000;
    while (response === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return { returnValue, response };
}

function cleanup(dom) {
  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.location;
  delete globalThis.chrome;
  delete globalThis.fetch;
}

function batchListHtml(caseType = "民事案件") {
  return `
    <div class="fd-header-operate"><div class="fd-user-name">demo-account</div></div>
    <div class="fd-case-item">
      <div class="fd-header-status">待审核</div>
      <div class="fd-header-ajmc">原告测试案件</div>
      <div class="fd-header-ajlx">${caseType}</div>
      <div class="fd-field-item"><span class="fd-field-lable">案号</span><span class="fd-field-value">case-1</span></div>
      <div class="fd-field-item"><span class="fd-field-lable">立案日期</span><span class="fd-field-value">2026-08-06</span></div>
    </div>`;
}

test("AUTO_LOGIN 非登录路由先拒绝，不触碰 DOM/fetch，且不回传 payload", async () => {
  const { dom, listener } = await loadContent({ hash: "#/pagesWsla/pc/home" });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("must not fetch");
  };
  const result = await dispatch(listener, {
    type: "AUTO_LOGIN",
    account: "demo-account",
    password: "demo-password",
    serviceUrl: "http://127.0.0.1:8765",
  });
  assert.equal(result.returnValue, false);
  assert.deepEqual(result.response, { ok: false, error: "NOT_LOGIN_ROUTE" });
  assert.equal(fetchCalls, 0);
  assert.equal(JSON.stringify(result.response).includes("demo-password"), false);
  cleanup(dom);
});

test("EXPORT_REPORT 在非允许列表路由先拒绝，不下载或上传", async () => {
  const { dom, chrome, listener } = await loadContent({ hash: "#/pagesWsla/pc/history/list/index" });
  let sent = 0;
  chrome.runtime.sendMessage = async () => { sent += 1; return { ok: true }; };
  try {
    const result = await dispatch(listener, {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "EXPORT_REPORT",
    });
    assert.equal(result.returnValue, true);
    assert.deepEqual(result.response, { ok: false, error: "PAGE_NOT_LIST" });
    assert.equal(sent, 0);
  } finally {
    cleanup(dom);
  }
});

test("AUTO_LOGIN 登录路由异步响应成功，并只执行页面表单操作", async () => {
  const { dom, chrome, listener } = await loadContent({
    hash: "#/pagesGrxx/pc/login/index",
    html: `
      <view id="password-tab">密码登录</view>
      <input type="text" class="uni-input-input">
      <input type="password" class="uni-input-input">
      <input type="text" class="uni-input-input">
      <img src="data:image/jpeg;base64,amJzZG9t">
      <view id="submit">登录</view>
    `,
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => ({ ok: true, text: "A7x2" }) };
  };
  prepareLoginClickTargets(dom.window.document);
  const clickRequests = [];
  chrome.runtime.sendMessage = async (message) => {
    if (message?.type === "CLICK_REQUEST") {
      clickRequests.push(message);
      dom.window.location.hash = "#/pagesWsla/pc/list/index";
    }
    return { ok: true };
  };

  const result = await dispatch(listener, {
    type: "AUTO_LOGIN",
    account: "demo-account",
    password: "demo-password",
    serviceUrl: "http://127.0.0.1:8765",
  });
  assert.equal(result.returnValue, true);
  assert.deepEqual(result.response, { ok: true });
  assert.equal(fetchCalls, 1);
  assert.deepEqual(clickRequests, [{ type: "CLICK_REQUEST", x: 60, y: 40 }]);
  assert.equal(chrome.listeners.length, 1);
  cleanup(dom);
});

test("AUTO_LOGIN 缺少账号或密码只返回 FORM_NOT_READY，不使用敏感字段", async () => {
  const { dom, listener } = await loadContent({ hash: "#/pagesGrxx/pc/login/index" });
  for (const payload of [
    { type: "AUTO_LOGIN", password: "demo-password", serviceUrl: "http://127.0.0.1:8765" },
    { type: "AUTO_LOGIN", account: "demo-account", serviceUrl: "http://127.0.0.1:8765" },
  ]) {
    const result = await dispatch(listener, payload);
    assert.deepEqual(result.response, { ok: false, error: "FORM_NOT_READY" });
    assert.equal(JSON.stringify(result.response).includes("demo-password"), false);
  }
  cleanup(dom);
});

test("连续 AUTO_LOGIN 消息共享单飞流程，不并行提交", async () => {
  const { dom, listener } = await loadContent({
    hash: "#/pagesGrxx/pc/login/index",
    html: `
      <input type="text" class="uni-input-input">
      <input type="password" class="uni-input-input">
      <input type="text" class="uni-input-input">
      <img src="data:image/jpeg;base64,amJzZG9t">
      <view id="submit">登录</view>
    `,
  });
  let releaseFetch;
  let fetchCalls = 0;
  let clickRequests = 0;
  const fetchReady = new Promise((resolve) => { releaseFetch = resolve; });
  globalThis.fetch = async () => {
    fetchCalls += 1;
    await fetchReady;
    return { ok: true, json: async () => ({ ok: true, text: "A7x2" }) };
  };
  prepareLoginClickTargets(dom.window.document);
  chrome.runtime.sendMessage = async (message) => {
    if (message?.type === "CLICK_REQUEST") {
      clickRequests += 1;
      dom.window.location.hash = "#/pagesWsla/pc/list/index";
    }
    return { ok: true };
  };

  const payload = { type: "AUTO_LOGIN", account: "demo-account", password: "demo-password", serviceUrl: "http://127.0.0.1:8765" };
  const first = dispatch(listener, payload);
  const second = dispatch(listener, payload);
  releaseFetch();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult.response, { ok: true });
  assert.deepEqual(secondResult.response, { ok: true });
  assert.equal(fetchCalls, 1);
  assert.equal(clickRequests, 1);
  cleanup(dom);
});

test("START_BATCH qz：民事 tab 无执行类行时返回 EXECUTION_TAB_REQUIRED", async () => {
  const { dom, listener } = await loadContent({
    hash: "#/pages/pc/case-list/index",
    html: batchListHtml("民事案件"),
  });
  try {
    const result = await dispatch(listener, { type: "START_BATCH", kind: "qz" });
    assert.deepEqual(result.response, { ok: false, error: "EXECUTION_TAB_REQUIRED" });
  } finally {
    cleanup(dom);
  }
});

test("START_BATCH qz：存在执行类行时允许正常启动批量任务", async () => {
  await db.resetDb();
  await db.upsert(db.STORE_ENFORCEMENT, {
    account: "demo-account",
    plaintiff: "原告测试",
    defendant: "被告测试",
    caseNumber: "case-1",
    kind: "qz",
    status: "UNKNOWN",
  });
  const { dom, listener } = await loadContent({
    hash: "#/pages/pc/case-list/index",
    html: batchListHtml("执行类案件"),
  });
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    return nativeSetTimeout(callback, delay >= 3000 ? 0 : delay, ...args);
  };
  try {
    const result = await dispatch(listener, { type: "START_BATCH", kind: "qz" });
    assert.equal(result.response?.ok, true);
    assert.equal(result.response?.stats?.total, 1);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    cleanup(dom);
    await db.resetDb();
  }
});
