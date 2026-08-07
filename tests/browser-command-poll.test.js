import assert from "node:assert/strict";
import { test } from "node:test";

import { createBrowserCommandPoller } from "../extension/sw/browser-command-poll.js";

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function chromeMock(sendMessage) {
  const stored = {
    serverUrl: "https://court-helper.test",
    token: "extension-token",
    expiresAt: Date.now() + 60_000,
    remoteLoginEnabled: true,
    browserCommandDeviceId: "device-test",
  };
  return {
    storage: { local: {
      get: async () => stored,
      set: async (value) => Object.assign(stored, value),
      remove: async (keys) => { for (const key of (Array.isArray(keys) ? keys : [keys])) delete stored[key]; },
    } },
    tabs: {
      query: async () => [{ id: 7, url: "https://zxfw.court.gov.cn/#/pagesWsla/pc/list/index" }],
      sendMessage,
    },
    alarms: { create() {}, clear() {} },
  };
}

test("browser command poller claims QUERY_LI, reads only bound extension data, dispatches and reports success", async () => {
  const calls = [];
  const command = {
    id: "00000000-0000-4000-8000-000000000101",
    type: "QUERY_LI",
    clientBatchId: "00000000-0000-4000-8000-000000000202",
  };
  const chromeApi = chromeMock(async (_tabId, message) => {
    assert.equal(message.type, "BROWSER_COMMAND_EXECUTE");
    assert.equal(message.commandType, "QUERY_LI");
    assert.equal(message.rows.length, 1);
    assert.equal("password" in message.rows[0], false);
    return { ok: true, progress: { done: 1, total: 1 } };
  });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/browser-commands/next")) return response({ command });
    if (String(url).endsWith(`/browser-commands/${command.id}/claim`)) {
      return response({ command: { ...command, status: "executing" }, claimToken: "claim-once" });
    }
    if (String(url).endsWith(`/import-batches/${command.clientBatchId}/extension-data`)) {
      assert.equal(init.headers["x-browser-command-claim"], "claim-once");
      return response({ rows: [{ kind: "li", account: "masked-fixture", plaintiff: "测试甲", defendant: "测试乙", status: "UNKNOWN" }] });
    }
    if (String(url).endsWith(`/browser-commands/${command.id}/result`)) return response({ command: { status: "succeeded" } });
    throw new Error(`unexpected ${url}`);
  };
  const poller = createBrowserCommandPoller({ chromeApi, fetchImpl });
  const result = await poller.pollOnce();
  assert.equal(result.ok, true);
  const resultCall = calls.find(({ url }) => url.endsWith(`/browser-commands/${command.id}/result`));
  assert.ok(resultCall);
  assert.deepEqual(JSON.parse(resultCall.init.body), {
    deviceId: "device-test",
    claimToken: "claim-once",
    status: "succeeded",
    resultCode: "SUCCESS",
    resultSummary: "任务已完成",
    progress: { done: 1, total: 1 },
  });
});

test("browser command poller reports NO_COURT_TAB without dispatching content", async () => {
  const command = { id: "00000000-0000-4000-8000-000000000303", type: "EXPORT_REPORT" };
  const chromeApi = chromeMock(async () => assert.fail("content must not be called"));
  chromeApi.tabs.query = async () => [];
  let resultBody;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/browser-commands/next")) return response({ command });
    if (String(url).endsWith(`/browser-commands/${command.id}/claim`)) return response({ command, claimToken: "claim" });
    if (String(url).endsWith(`/browser-commands/${command.id}/result`)) {
      resultBody = JSON.parse(init.body);
      return response({ command: { status: "failed" } });
    }
    throw new Error(`unexpected ${url}`);
  };
  const result = await createBrowserCommandPoller({ chromeApi, fetchImpl }).pollOnce();
  assert.equal(result.error, "NO_COURT_TAB");
  assert.equal(resultBody.resultCode, "NO_COURT_TAB");
  assert.equal(resultBody.status, "failed");
});

test("report command rejects detail and similarly named routes before content execution", async () => {
  const command = { id: "00000000-0000-4000-8000-000000000405", type: "EXPORT_REPORT" };
  const chromeApi = chromeMock(async () => assert.fail("content must not be called"));
  chromeApi.tabs.query = async () => [
    { id: 7, url: "https://zxfw.court.gov.cn/#/pagesWsla/pc/history/list/index" },
    { id: 8, url: "https://zxfw.court.gov.cn/#/pagesWsla/pc/detail/index" },
  ];
  let resultBody;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/browser-commands/next")) return response({ command });
    if (String(url).endsWith(`/browser-commands/${command.id}/claim`)) return response({ command, claimToken: "claim" });
    if (String(url).endsWith(`/browser-commands/${command.id}/result`)) {
      resultBody = JSON.parse(init.body);
      return response({ command: { status: "failed" } });
    }
    throw new Error(`unexpected ${url}`);
  };

  const result = await createBrowserCommandPoller({ chromeApi, fetchImpl }).pollOnce();
  assert.equal(result.error, "NO_COURT_TAB");
  assert.equal(resultBody.resultCode, "NO_COURT_TAB");
  assert.equal(resultBody.status, "failed");
});

test("报表命令回写区分服务器上传成功、未配置与失败", async () => {
  const reportResponses = [
    {
      contentResponse: { status: "uploaded", exportId: "export-1" },
      expectedResult: { status: "succeeded", resultCode: "SUCCESS", resultSummary: "报表已上传服务器" },
    },
    {
      contentResponse: { status: "not_configured", code: "NOT_CONFIGURED" },
      expectedResult: { status: "manual_required", resultCode: "NOT_CONFIGURED", resultSummary: "本地文件已保存，服务器未配置" },
    },
    {
      contentResponse: { status: "failed", code: "NETWORK_UNAVAILABLE" },
      expectedResult: { status: "manual_required", resultCode: "NETWORK_UNAVAILABLE", resultSummary: "本地文件已保存，上传失败" },
    },
  ];

  for (const { contentResponse, expectedResult } of reportResponses) {
    const command = {
      id: "00000000-0000-4000-8000-000000000404",
      type: "EXPORT_REPORT",
    };
    let resultBody;
    const chromeApi = chromeMock(async (_tabId, message) => {
      assert.deepEqual(message, {
        type: "BROWSER_COMMAND_EXECUTE",
        commandType: "EXPORT_REPORT",
      });
      return contentResponse;
    });
    const fetchImpl = async (url, init = {}) => {
      if (String(url).endsWith("/browser-commands/next")) return response({ command });
      if (String(url).endsWith(`/browser-commands/${command.id}/claim`)) {
        return response({ command, claimToken: "claim-report" });
      }
      if (String(url).endsWith(`/browser-commands/${command.id}/result`)) {
        resultBody = JSON.parse(init.body);
        return response({ command: { status: "succeeded" } });
      }
      throw new Error(`unexpected ${url}`);
    };

    const result = await createBrowserCommandPoller({ chromeApi, fetchImpl }).pollOnce();
    assert.equal(result.commandId, command.id, contentResponse.status);
    assert.deepEqual(resultBody, {
      deviceId: "device-test",
      claimToken: "claim-report",
      ...expectedResult,
      progress: null,
    }, contentResponse.status);
  }
});

test("browser command polling depends on a valid device token, not the legacy remote-login switch", async () => {
  const chromeApi = chromeMock(async () => ({ ok: true }));
  const stored = await chromeApi.storage.local.get();
  stored.remoteLoginEnabled = false;
  chromeApi.storage.local.get = async () => stored;
  const scheduler = {
    intervals: new Map(),
    setInterval(callback, delay) { this.intervals.set(1, { callback, delay }); return 1; },
    clearInterval(id) { this.intervals.delete(id); },
  };
  const poller = createBrowserCommandPoller({
    chromeApi,
    scheduler,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/browser-commands/next')) return response({ command: null });
      throw new Error(`unexpected ${url}`);
    },
  });
  const started = await poller.start({ immediate: false });
  assert.deepEqual(started, { ok: true });
  assert.equal(scheduler.intervals.size, 1);
});

test("an old in-flight command auth failure cannot clear the token of a newly paired server", async () => {
  const chromeApi = chromeMock(async () => ({ ok: true }));
  const stored = await chromeApi.storage.local.get();
  let resolveOldRequest;
  const poller = createBrowserCommandPoller({
    chromeApi,
    fetchImpl: async (url) => {
      assert.equal(String(url), "https://court-helper.test/api/v1/browser-commands/next");
      return new Promise((resolve) => { resolveOldRequest = resolve; });
    },
  });

  const oldPoll = poller.pollOnce();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(typeof resolveOldRequest, "function");

  poller.stop();
  Object.assign(stored, {
    serverUrl: "http://127.0.0.1:3000",
    token: "new-device-token",
    expiresAt: Date.now() + 60_000,
    browserCommandDeviceId: "new-device-id",
  });
  resolveOldRequest(response({ error: { code: "AUTH_REQUIRED" } }, 401));

  assert.deepEqual(await oldPoll, { ok: false, reason: "CONFIG_CHANGED" });
  assert.equal(stored.token, "new-device-token");
  assert.equal(stored.expiresAt > Date.now(), true);
  assert.equal(stored.browserCommandDeviceId, "new-device-id");
});

test("revoked device authorization clears its local token and stops unified polling", async () => {
  const chromeApi = chromeMock(async () => ({ ok: true }));
  const scheduler = {
    intervals: new Map(),
    setInterval(callback, delay) { this.intervals.set(1, { callback, delay }); return 1; },
    clearInterval(id) { this.intervals.delete(id); },
  };
  const poller = createBrowserCommandPoller({
    chromeApi,
    scheduler,
    fetchImpl: async () => response({ error: { code: "AUTH_REQUIRED" } }, 401),
  });

  await poller.start({ immediate: false });
  const result = await poller.pollOnce();

  assert.deepEqual(result, { ok: false, reason: "AUTH_REQUIRED" });
  const stored = await chromeApi.storage.local.get();
  assert.equal(stored.token, undefined);
  assert.equal(stored.expiresAt, undefined);
  assert.equal(scheduler.intervals.size, 0);
});
