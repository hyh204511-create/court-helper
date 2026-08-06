import "fake-indexeddb/auto";

import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { createLoginStateMessage, maskAccount } from "../extension/content/login-detector.js";
import { resetDb } from "../extension/data/db.js";

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

function makeScheduler() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending() {
      return [...timers.values()];
    },
  };
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
      url: "https://zxfw.court.gov.cn/zxfw/#/pagesGrxx/pc/login/index",
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
    assert.equal(sent[0]?.state, "login");
    sent.length = 0;

    module.handleLoginState("login", null, { now: () => 1000 });
    module.handleLoginState("logged-in", "3503123452X", { now: () => 1001 });
    module.handleLoginState("session-expired", "3503123452X", { now: () => 1002 });
    assert.deepEqual(sent, [
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

test("service worker registers only unified browser-command alarm wakeups", async () => {
  await withGlobals(async () => {
    const nativeSetInterval = globalThis.setInterval;
    const nativeClearInterval = globalThis.clearInterval;
    const runtimeListeners = { startup: [], installed: [], message: [] };
    const alarmListeners = [];
    const alarmCreates = [];
    const pollFetches = [];
    const remoteConfig = {
      serverUrl: "",
      token: "",
      expiresAt: 0,
      browserCommandDeviceId: "",
    };
    let intervalId = 0;
    const intervals = new Map();
    try {
      globalThis.setInterval = (callback, delay) => {
        intervalId += 1;
        intervals.set(intervalId, { callback, delay });
        return intervalId;
      };
      globalThis.clearInterval = (id) => {
        intervals.delete(id);
      };
      globalThis.self = {
        addEventListener() {},
        skipWaiting() {},
        clients: { claim() {} },
      };
      globalThis.fetch = async (url) => {
        pollFetches.push(String(url));
        return {
          ok: true,
          status: 200,
          async json() { return { command: null }; },
          async text() { return '{"command":null}'; },
        };
      };
      globalThis.chrome = {
        runtime: {
          onStartup: { addListener(listener) { runtimeListeners.startup.push(listener); } },
          onInstalled: { addListener(listener) { runtimeListeners.installed.push(listener); } },
          onMessage: { addListener(listener) { runtimeListeners.message.push(listener); } },
          sendMessage() {},
        },
        storage: {
          local: {
            get: async () => ({ ...remoteConfig }),
          },
          onChanged: { addListener() {} },
        },
        alarms: {
          create(name, alarmInfo) {
            alarmCreates.push({ name, alarmInfo });
          },
          clear() {},
          onAlarm: { addListener(listener) { alarmListeners.push(listener); } },
        },
        tabs: { query: async () => [] },
      };
      await import(`../extension/service-worker.js?alarm-test=${importSequence++}`);
      assert.equal(runtimeListeners.startup.length, 1);
      assert.equal(runtimeListeners.installed.length, 1);
      assert.equal(alarmListeners.length, 1);

      runtimeListeners.startup[0]();
      runtimeListeners.installed[0]();
      remoteConfig.serverUrl = "https://sync.example.test";
      remoteConfig.token = "extension-token";
      remoteConfig.expiresAt = Date.now() + 60_000;
      remoteConfig.browserCommandDeviceId = "00000000-0000-4000-8000-000000000001";
      await alarmListeners[0]({ name: "browser-command-poll" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.ok(alarmCreates.some((entry) => (
        entry.name === "browser-command-poll" && entry.alarmInfo.periodInMinutes === 1
      )));
      assert.ok(pollFetches.some((url) => url.endsWith("/api/v1/browser-commands/next")));
      assert.equal(pollFetches.some((url) => url.includes("/login-commands")), false);
      assert.equal(intervals.size, 0);
    } finally {
      globalThis.setInterval = nativeSetInterval;
      globalThis.clearInterval = nativeClearInterval;
      cleanupGlobals(null, ["self", "chrome", "fetch"]);
    }
  });
});

test("service worker 同步初始化：未配置不启动，配置后启动并建立轮询", async () => {
  await withGlobals(async () => {
    await resetDb();
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    try {
      const selfListeners = [];
      let fetchCalls = 0;
      globalThis.self = {
        addEventListener(type, listener) {
          selfListeners.push({ type, listener });
        },
        skipWaiting() {},
        clients: { claim() {} },
      };
      globalThis.fetch = async () => {
        fetchCalls += 1;
        throw new Error("should not fetch without sync config");
      };
      globalThis.chrome = {
        runtime: {
          onMessage: { addListener() {} },
          sendMessage() {},
        },
        storage: { local: { get: async () => ({}) } },
      };
      const unconfigured = await import(`../extension/service-worker.js?sync-init-test=${importSequence++}`);
      await unconfigured.syncInitialization;
      assert.equal(unconfigured.getSyncCoordinator(), null);
      assert.equal(fetchCalls, 0);

      await resetDb();
      const scheduler = makeScheduler();
      const states = [];
      fetchCalls = 0;
      globalThis.setTimeout = scheduler.setTimeout;
      globalThis.clearTimeout = scheduler.clearTimeout;
      globalThis.fetch = async (url) => {
        fetchCalls += 1;
        const body = url.endsWith("/health")
          ? { ok: true }
          : url.includes("/platform-accounts")
            ? { platformAccounts: [] }
            : { cases: [], nextCursor: 0 };
        return {
          ok: true,
          status: 200,
          async json() { return body; },
          async text() { return JSON.stringify(body); },
        };
      };
      globalThis.chrome = {
        runtime: {
          onMessage: { addListener() {} },
          sendMessage(message) {
            states.push(message);
            return Promise.resolve();
          },
        },
        storage: {
          local: {
            get: async () => ({
              syncServerUrl: "http://127.0.0.1:3000",
              syncDeviceToken: "opaque-device-token",
            }),
          },
        },
      };
      const configured = await import(`../extension/service-worker.js?sync-init-test=${importSequence++}`);
      await configured.syncInitialization;
      assert.ok(configured.getSyncCoordinator());
      assert.ok(fetchCalls >= 3, "configured coordinator should run health/accounts/changes");
      assert.ok(states.some((message) => message.type === "SYNC_STATUS" && message.payload.status === "online"));
      assert.ok(scheduler.pending().some((timer) => timer.delay === 4000), "configured coordinator should poll");
      configured.getSyncCoordinator().stop();
      assert.deepEqual(scheduler.pending(), []);
      assert.ok(selfListeners.some(({ type }) => type === "install"));
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
      globalThis.clearTimeout = nativeClearTimeout;
      cleanupGlobals(null, ["self", "chrome", "fetch"]);
    }
  });
});
