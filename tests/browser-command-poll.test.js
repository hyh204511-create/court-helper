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
    storage: { local: { get: async () => stored, set: async (value) => Object.assign(stored, value) } },
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
