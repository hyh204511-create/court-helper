import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { createLoginCommandPoller } from "../extension/sw/login-command-poll.js";

const BASE_URL = "https://sync.example.test";
const TOKEN = "extension-token";
const FUTURE = 10_000 + 8 * 60 * 60 * 1000;

function jsonResponse(payload, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function makeScheduler() {
  let nextId = 1;
  const intervals = new Map();
  return {
    intervals,
    setInterval(fn, ms) {
      const id = nextId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
  };
}

function makeChrome({
  storageData = {},
  tabs = [{ id: 7, url: "https://zxfw.court.gov.cn/zxfw/#/pagesGrxx/pc/login/index" }],
  pingResponse = { ok: true, state: "login", route: "#/pagesGrxx/pc/login/index" },
  autoLoginResponse = { ok: true },
} = {}) {
  const localData = {
    serverUrl: BASE_URL,
    serverUsername: "worker",
    remoteLoginEnabled: true,
    token: TOKEN,
    expiresAt: FUTURE,
    ...storageData,
  };
  const calls = {
    query: [],
    messages: [],
    storageSet: [],
    storageRemove: [],
    alarmsCreate: [],
    alarmsClear: [],
  };
  return {
    calls,
    data: localData,
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return { ...localData };
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, localData[key]]));
          }
          if (typeof keys === "string") return { [keys]: localData[keys] };
          return { ...keys, ...Object.fromEntries(Object.keys(keys).map((key) => [key, localData[key] ?? keys[key]])) };
        },
        async set(value) {
          Object.assign(localData, value);
          calls.storageSet.push(value);
        },
        async remove(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const key of list) delete localData[key];
          calls.storageRemove.push(list);
        },
      },
    },
    tabs: {
      async query(query) {
        calls.query.push(query);
        return tabs;
      },
      async sendMessage(tabId, message) {
        calls.messages.push({ tabId, message });
        if (message?.type === "PING") return pingResponse;
        if (message?.type === "AUTO_LOGIN") return autoLoginResponse;
        return undefined;
      },
    },
    alarms: {
      create(name, alarmInfo) {
        calls.alarmsCreate.push({ name, alarmInfo });
      },
      clear(name) {
        calls.alarmsClear.push(name);
        return Promise.resolve(true);
      },
    },
  };
}

function makeFetch({ command = null, credential = { account: "court-user", password: "court-secret" }, delayCommand = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === `${BASE_URL}/api/v1/login-commands?status=pending`) {
      if (delayCommand) await delayCommand;
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      return jsonResponse({ command });
    }
    if (url === `${BASE_URL}/api/v1/platform-accounts/pa-1/credential`) {
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      return jsonResponse(credential);
    }
    if (url === `${BASE_URL}/api/v1/login-commands/cmd-1/result`) {
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      return jsonResponse({ ok: true });
    }
    if (url === `${BASE_URL}/api/v1/auth/login`) {
      return jsonResponse({ token: TOKEN });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function parseBody(call) {
  return JSON.parse(call.init.body);
}

function createPollerForTest(options = {}) {
  const scheduler = makeScheduler();
  const chromeApi = options.chromeApi ?? makeChrome(options.chromeOptions);
  const fetchImpl = options.fetchImpl ?? makeFetch(options.fetchOptions);
  const poller = createLoginCommandPoller({
    chromeApi,
    fetchImpl,
    scheduler,
    now: () => 10_000,
  });
  return { poller, chromeApi, fetchImpl, scheduler };
}

test("poll with no command does not send AUTO_LOGIN", async () => {
  const { poller, chromeApi, fetchImpl } = createPollerForTest({ fetchOptions: { command: null } });
  await poller.pollOnce();
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(chromeApi.calls.messages.some((entry) => entry.message.type === "AUTO_LOGIN"), false);
});

test("pending command on login tab fetches credential, sends AUTO_LOGIN, and writes success", async () => {
  const command = { id: "cmd-1", platformAccountId: "pa-1" };
  const { poller, chromeApi, fetchImpl } = createPollerForTest({ fetchOptions: { command } });
  const result = await poller.pollOnce();
  assert.deepEqual(result, { ok: true, commandId: "cmd-1" });
  assert.deepEqual(chromeApi.calls.messages, [
    { tabId: 7, message: { type: "PING" } },
    {
      tabId: 7,
      message: {
        type: "AUTO_LOGIN",
        account: "court-user",
        password: "court-secret",
        serviceUrl: "http://127.0.0.1:8765",
      },
    },
  ]);
  assert.deepEqual(parseBody(fetchImpl.calls.at(-1)), { ok: true });
});

test("pending command without court login tab writes NO_TAB", async () => {
  const command = { id: "cmd-1", platformAccountId: "pa-1" };
  const { poller, chromeApi, fetchImpl } = createPollerForTest({
    chromeOptions: {
      tabs: [{ id: 2, url: "https://zxfw.court.gov.cn/zxfw/#/pagesWsla/pc/list/index" }],
    },
    fetchOptions: { command },
  });
  await poller.pollOnce();
  assert.equal(chromeApi.calls.messages.length, 0);
  assert.deepEqual(parseBody(fetchImpl.calls.at(-1)), { ok: false, code: "NO_TAB" });
});

test("content NEEDS_HUMAN response writes failed result code", async () => {
  const command = { id: "cmd-1", platformAccountId: "pa-1" };
  const { poller, fetchImpl } = createPollerForTest({
    chromeOptions: { autoLoginResponse: { ok: false, error: "NEEDS_HUMAN" } },
    fetchOptions: { command },
  });
  await poller.pollOnce();
  assert.deepEqual(parseBody(fetchImpl.calls.at(-1)), { ok: false, code: "NEEDS_HUMAN" });
});

test("logged-in content state writes idempotent success without credential fetch", async () => {
  const command = { id: "cmd-1", platformAccountId: "pa-1" };
  const { poller, fetchImpl } = createPollerForTest({
    chromeOptions: { pingResponse: { ok: true, state: "logged-in", route: "#/pagesWsla/pc/list/index" } },
    fetchOptions: { command },
  });
  await poller.pollOnce();
  assert.equal(fetchImpl.calls.some((call) => call.url.includes("/credential")), false);
  assert.deepEqual(parseBody(fetchImpl.calls.at(-1)), { ok: true });
});

test("poller is single-flight while a command claim is running", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { poller, fetchImpl } = createPollerForTest({
    fetchOptions: { command: null, delayCommand: pending },
  });
  const first = poller.pollOnce();
  const second = poller.pollOnce();
  assert.deepEqual(await second, { ok: false, skipped: "IN_FLIGHT" });
  release();
  assert.deepEqual(await first, { ok: false, command: null });
  assert.equal(fetchImpl.calls.length, 1);
});

test("expired token pauses polling and exposes token-expired status", async () => {
  const { poller, chromeApi, scheduler } = createPollerForTest({
    chromeOptions: { storageData: { expiresAt: 9_999 } },
  });
  const result = await poller.start({ immediate: true });
  assert.deepEqual(result, { ok: false, reason: "TOKEN_EXPIRED" });
  assert.equal(scheduler.intervals.size, 0);
  assert.deepEqual(await poller.getStatus(), {
    enabled: true,
    status: "token-expired",
    running: false,
    inFlight: false,
    expiresAt: 9_999,
    hasToken: true,
  });
  assert.equal(chromeApi.calls.messages.length, 0);
});

test("disable clears token and stops interval", async () => {
  const { poller, chromeApi, scheduler } = createPollerForTest();
  await poller.start({ immediate: false });
  assert.equal(scheduler.intervals.size, 1);
  assert.deepEqual(chromeApi.calls.alarmsCreate, [
    { name: "remote-login-poll", alarmInfo: { periodInMinutes: 1 } },
  ]);
  const result = await poller.disable();
  assert.deepEqual(result, { ok: true });
  assert.equal(chromeApi.data.remoteLoginEnabled, false);
  assert.equal(chromeApi.data.token, undefined);
  assert.equal(chromeApi.data.expiresAt, undefined);
  assert.equal(scheduler.intervals.size, 0);
  assert.deepEqual(chromeApi.calls.alarmsClear, ["remote-login-poll"]);
});

test("auth failure clears stored token, stops interval, and clears fallback alarm", async () => {
  const chromeApi = makeChrome();
  const fetchImpl = async (url) => {
    if (url === `${BASE_URL}/api/v1/login-commands?status=pending`) {
      return jsonResponse({ error: { code: "AUTH_REQUIRED" } }, false, 401);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  fetchImpl.calls = [];
  const scheduler = makeScheduler();
  const poller = createLoginCommandPoller({
    chromeApi,
    fetchImpl,
    scheduler,
    now: () => 10_000,
  });
  await poller.start({ immediate: false });
  assert.equal(scheduler.intervals.size, 1);
  const result = await poller.pollOnce();
  assert.deepEqual(result, { ok: false, reason: "TOKEN_INVALID" });
  assert.equal(chromeApi.data.token, undefined);
  assert.equal(chromeApi.data.expiresAt, undefined);
  assert.equal(scheduler.intervals.size, 0);
  assert.deepEqual(chromeApi.calls.storageRemove, [["token", "expiresAt"]]);
  assert.deepEqual(chromeApi.calls.alarmsClear, ["remote-login-poll"]);
});

test("enable logs in with server password, stores only token TTL, and starts polling", async () => {
  const chromeApi = makeChrome({ storageData: { remoteLoginEnabled: false, token: undefined, expiresAt: undefined } });
  const fetchImpl = makeFetch({ command: null });
  const scheduler = makeScheduler();
  const poller = createLoginCommandPoller({
    chromeApi,
    fetchImpl,
    scheduler,
    now: () => 10_000,
  });
  const result = await poller.enable({ serverPassword: "server-pass" });
  assert.equal(result.ok, true);
  assert.equal(result.status, "running");
  assert.equal(chromeApi.data.remoteLoginEnabled, true);
  assert.equal(chromeApi.data.token, TOKEN);
  assert.equal(chromeApi.data.expiresAt, FUTURE);
  assert.equal(scheduler.intervals.size, 1);
  assert.ok(chromeApi.calls.alarmsCreate.some((entry) => entry.name === "remote-login-poll"));
  assert.deepEqual(parseBody(fetchImpl.calls[0]), {
    username: "worker",
    password: "server-pass",
    clientType: "extension",
  });
  assert.equal(JSON.stringify(chromeApi.calls.storageSet).includes("server-pass"), false);
});

test("popup remote login section sends enable, disable, and status messages to service worker", async () => {
  const dom = new JSDOM(`
    <!doctype html><html><body>
      <input id="remote-login-password" value="server-pass">
      <button id="btn-enable-remote-login"></button>
      <button id="btn-disable-remote-login"></button>
      <span id="remote-login-status"></span>
    </body></html>
  `);
  const messages = [];
  const { createRemoteLoginControls } = await import(`../extension/popup/remote-login-controls.js?test=${Date.now()}`);
  const controls = createRemoteLoginControls({
    document: dom.window.document,
    chromeApi: {
      runtime: {
        sendMessage: async (message) => {
          messages.push(message);
          if (message.type === "REMOTE_LOGIN_STATUS_REQUEST") {
            return { ok: true, status: "stopped", enabled: false };
          }
          return { ok: true, status: "running", enabled: true };
        },
      },
    },
  });
  await controls.init();
  dom.window.document.querySelector("#btn-enable-remote-login").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  dom.window.document.querySelector("#btn-disable-remote-login").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(messages, [
    { type: "REMOTE_LOGIN_STATUS_REQUEST" },
    { type: "ENABLE_REMOTE_LOGIN", serverPassword: "server-pass" },
    { type: "DISABLE_REMOTE_LOGIN" },
  ]);
  assert.equal(dom.window.document.body.textContent.includes("server-pass"), false);
  controls.destroy();
  dom.window.close();
});
