import assert from "node:assert/strict";
import { test } from "node:test";

import { createBrowserCommandPoller } from "../extension/sw/browser-command-poll.js";
import { CONTENT_PROTOCOL_VERSION } from "../extension/shared/runtime-protocol.js";

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
      sendMessage: async (tabId, message) => {
        const value = await sendMessage(tabId, message);
        if (message?.type === "PING" && value && !Object.hasOwn(value, "protocolVersion")) {
          return { ...value, protocolVersion: CONTENT_PROTOCOL_VERSION };
        }
        return value;
      },
    },
    alarms: { create() {}, clear() {} },
  };
}

function platformDiscoveryHarness(command) {
  let resultBody;
  return {
    fetchImpl: async (url, init = {}) => {
      const value = String(url);
      if (value.endsWith("/browser-commands/next")) return response({ command });
      if (value.endsWith(`/browser-commands/${command.id}/claim`)) {
        return response({ command, claimToken: "claim-once" });
      }
      if (value.endsWith(`/import-batches/${command.clientBatchId}/extension-data`)) {
        return response({ queryMode: "platform_discovery", rows: [] });
      }
      if (value.endsWith(`/platform-accounts/${command.platformAccountId}/credential`)) {
        return response({ label: "测试账号标签", account: "synthetic-account", password: "synthetic-password" });
      }
      if (value.endsWith(`/browser-commands/${command.id}/result`)) {
        resultBody = JSON.parse(init.body);
        return response({ command: { status: resultBody.status } });
      }
      throw new Error(`unexpected ${value}`);
    },
    resultBody: () => resultBody,
  };
}

test("browser command poller claims QUERY_LI, reads only bound extension data, dispatches and reports success", async () => {
  const calls = [];
  const command = {
    id: "00000000-0000-4000-8000-000000000101",
    type: "QUERY_LI",
    platformAccountId: "00000000-0000-4000-8000-000000000303",
    clientBatchId: "00000000-0000-4000-8000-000000000202",
  };
  const chromeApi = chromeMock(async (_tabId, message) => {
    assert.equal(message.type, "BROWSER_COMMAND_EXECUTE");
    assert.equal(message.commandType, "QUERY_LI");
    assert.equal(message.platformAccountId, command.platformAccountId);
    assert.equal(message.queryMode, "platform_discovery");
    assert.equal("rows" in message, false);
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
      return response({ queryMode: "platform_discovery", rows: [] });
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

test("查询命令发现旧 content 协议时刷新法院列表页并等待新版后再执行", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000121",
    type: "QUERY_ALL_EXPORT",
    platformAccountId: "00000000-0000-4000-8000-000000000321",
    clientBatchId: "00000000-0000-4000-8000-000000000221",
  };
  const messages = [];
  let refreshed = false;
  const chromeApi = chromeMock(async (_tabId, message) => {
    messages.push(message);
    if (message.type === "PING") {
      return refreshed
        ? { ok: true, protocolVersion: CONTENT_PROTOCOL_VERSION, route: "#/pagesWsla/pc/list/index", ready: true }
        : { ok: true, protocolVersion: null, route: "#/pagesWsla/pc/list/index", ready: true };
    }
    return { ok: true, progress: { done: 1, total: 1 } };
  });
  let reloads = 0;
  chromeApi.tabs.reload = async (tabId) => {
    assert.equal(tabId, 7);
    reloads += 1;
    refreshed = true;
  };
  const harness = platformDiscoveryHarness(command);
  const result = await createBrowserCommandPoller({
    chromeApi,
    fetchImpl: harness.fetchImpl,
    contentRouteRetryDelayMs: 0,
    contentRouteRetryAttempts: 2,
    contentRoutePingTimeoutMs: 10,
    initialActivePlatformAccountId: command.platformAccountId,
  }).pollOnce();
  assert.equal(result.ok, true);
  assert.equal(reloads, 1);
  assert.deepEqual(messages.map((message) => message.type), ["PING", "PING", "PING", "BROWSER_COMMAND_EXECUTE"]);
});

test("QUERY_ALL_EXPORT 只读取一次批次并向网上立案页下发单一命令", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000111",
    type: "QUERY_ALL_EXPORT",
    platformAccountId: "00000000-0000-4000-8000-000000000311",
    clientBatchId: "00000000-0000-4000-8000-000000000211",
    payload: { salesperson: "测试业务员甲" },
  };
  let batchReads = 0;
  const messages = [];
  const chromeApi = chromeMock(async (_tabId, message) => {
    messages.push(message);
    if (message.type === "PING") return { ok: true, route: "#/pagesWsla/pc/list/index", ready: true };
    return { ok: true, progress: { stage: "exported" } };
  });
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/browser-commands/next")) return response({ command });
    if (value.endsWith(`/browser-commands/${command.id}/claim`)) return response({ command, claimToken: "claim-all" });
    if (value.endsWith(`/import-batches/${command.clientBatchId}/extension-data`)) {
      batchReads += 1;
      return response({ queryMode: "platform_discovery", rows: [] });
    }
    if (value.endsWith(`/platform-accounts/${command.platformAccountId}/credential`)) {
      return response({ label: "测试账号标签", account: "synthetic-account", password: "synthetic-password" });
    }
    if (value.endsWith(`/browser-commands/${command.id}/result`)) return response({ command: { status: JSON.parse(init.body).status } });
    throw new Error(`unexpected ${value}`);
  };

  const result = await createBrowserCommandPoller({
    chromeApi,
    fetchImpl,
    initialActivePlatformAccountId: command.platformAccountId,
  }).pollOnce();

  assert.equal(result.ok, true);
  assert.equal(batchReads, 1);
  assert.deepEqual(messages.filter((message) => message.type === "BROWSER_COMMAND_EXECUTE"), [{
    type: "BROWSER_COMMAND_EXECUTE",
    commandType: "QUERY_ALL_EXPORT",
    queryMode: "platform_discovery",
    platformAccountId: command.platformAccountId,
    accountBindingVerified: true,
    accountLabel: "测试账号标签",
    exportCredential: { account: "synthetic-account", password: "synthetic-password" },
    salesperson: "测试业务员甲",
  }]);
});

test("QUERY_ALL_EXPORT 未建立同运行期登录绑定时不读取批次、凭据或执行页面", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000116",
    type: "QUERY_ALL_EXPORT",
    platformAccountId: "00000000-0000-4000-8000-000000000316",
    clientBatchId: "00000000-0000-4000-8000-000000000216",
  };
  let contentCalls = 0;
  let protectedReads = 0;
  let resultBody;
  const chromeApi = chromeMock(async () => {
    contentCalls += 1;
    return { ok: true };
  });
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/browser-commands/next")) return response({ command });
    if (value.endsWith(`/browser-commands/${command.id}/claim`)) {
      return response({ command, claimToken: "claim-binding-required" });
    }
    if (value.includes("/extension-data") || value.includes("/credential")) {
      protectedReads += 1;
      throw new Error("protected data must not be read");
    }
    if (value.endsWith(`/browser-commands/${command.id}/result`)) {
      resultBody = JSON.parse(init.body);
      return response({ command: { status: resultBody.status } });
    }
    throw new Error(`unexpected ${value}`);
  };
  const result = await createBrowserCommandPoller({ chromeApi, fetchImpl }).pollOnce();
  assert.equal(result.error, "ACCOUNT_BINDING_REQUIRED");
  assert.equal(contentCalls, 0);
  assert.equal(protectedReads, 0);
  assert.equal(resultBody.status, "manual_required");
  assert.equal(resultBody.resultCode, "ACCOUNT_BINDING_REQUIRED");
  assert.equal(resultBody.resultSummary, "请先对同一平台账号执行一键登录");
});

test("同运行期 LOGIN 绑定与一键任务账号一致时下发已验证绑定证明", async () => {
  const platformAccountId = "00000000-0000-4000-8000-000000000318";
  const loginCommand = {
    id: "00000000-0000-4000-8000-000000000118",
    type: "LOGIN",
    platformAccountId,
  };
  const queryCommand = {
    id: "00000000-0000-4000-8000-000000000119",
    type: "QUERY_ALL_EXPORT",
    platformAccountId,
    clientBatchId: "00000000-0000-4000-8000-000000000219",
  };
  const commands = [loginCommand, queryCommand];
  let currentHash = "#/pagesGrxx/pc/login/index";
  let dispatchedQuery;
  const chromeApi = chromeMock(async (_tabId, message) => {
    if (message.type === "PING") return {
      ok: true,
      route: currentHash,
      ready: currentHash === "#/pagesWsla/pc/list/index",
    };
    if (message.commandType === "LOGIN") {
      currentHash = "#/pagesWsla/pc/list/index";
      return { ok: true };
    }
    dispatchedQuery = message;
    return { ok: true };
  });
  chromeApi.tabs.query = async () => [{ id: 7, url: `https://zxfw.court.gov.cn/${currentHash}` }];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/browser-commands/next")) return response({ command: commands.shift() ?? null });
    const command = [loginCommand, queryCommand].find((item) => value.endsWith(`/browser-commands/${item.id}/claim`));
    if (command) return response({ command, claimToken: `claim-${command.id}` });
    if (value.endsWith(`/platform-accounts/${platformAccountId}/credential`)) {
      return response({ label: "SYNTHETIC LABEL", account: "synthetic-account", password: "synthetic-password" });
    }
    if (value.endsWith(`/import-batches/${queryCommand.clientBatchId}/extension-data`)) {
      return response({ queryMode: "platform_discovery", rows: [] });
    }
    if (value.includes("/browser-commands/") && value.endsWith("/result")) {
      return response({ command: { status: JSON.parse(init.body).status } });
    }
    throw new Error(`unexpected ${value}`);
  };
  const poller = createBrowserCommandPoller({ chromeApi, fetchImpl });
  assert.equal((await poller.pollOnce()).ok, true);
  await poller.pollOnce();
  assert.equal(dispatchedQuery.accountBindingVerified, true);
});

test("QUERY_ALL_EXPORT waits for the list content to become ready before dispatching", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000113",
    type: "QUERY_ALL_EXPORT",
    platformAccountId: "00000000-0000-4000-8000-000000000313",
    clientBatchId: "00000000-0000-4000-8000-000000000213",
  };
  const messages = [];
  let pingCount = 0;
  const chromeApi = chromeMock(async (_tabId, message) => {
    messages.push(message);
    if (message.type === "PING") {
      pingCount += 1;
      return {
        ok: true,
        route: "#/pagesWsla/pc/list/index",
        ready: pingCount >= 2,
      };
    }
    return { ok: true, progress: { stage: "exported" } };
  });
  const harness = platformDiscoveryHarness(command);

  const result = await createBrowserCommandPoller({
    chromeApi,
    fetchImpl: harness.fetchImpl,
    contentRouteRetryDelayMs: 0,
    contentRouteRetryAttempts: 2,
    contentRoutePingTimeoutMs: 10,
    initialActivePlatformAccountId: command.platformAccountId,
  }).pollOnce();

  assert.equal(result.ok, true);
  assert.equal(pingCount, 2);
  assert.deepEqual(messages.map((message) => message.type), ["PING", "PING", "BROWSER_COMMAND_EXECUTE"]);
});

test("QUERY_ALL_EXPORT 分类切换超时按待人工回写", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000112",
    type: "QUERY_ALL_EXPORT",
    platformAccountId: "00000000-0000-4000-8000-000000000312",
    clientBatchId: "00000000-0000-4000-8000-000000000212",
  };
  const harness = platformDiscoveryHarness(command);
  const chromeApi = chromeMock(async (_tabId, message) => (
    message.type === "PING"
      ? { ok: true, route: "#/pagesWsla/pc/list/index", ready: true }
      : { ok: false, error: "QUERY_TAB_TIMEOUT" }
  ));

  const result = await createBrowserCommandPoller({
    chromeApi,
    fetchImpl: harness.fetchImpl,
    initialActivePlatformAccountId: command.platformAccountId,
  }).pollOnce();

  assert.equal(result.error, "QUERY_TAB_TIMEOUT");
  assert.equal(harness.resultBody().status, "manual_required");
  assert.equal(harness.resultBody().resultCode, "QUERY_TAB_TIMEOUT");
});

test("QUERY_ALL_EXPORT 报表已上传但证据未闭环时按待人工回写", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000128",
    type: "QUERY_ALL_EXPORT",
    platformAccountId: "00000000-0000-4000-8000-000000000328",
    clientBatchId: "00000000-0000-4000-8000-000000000228",
  };
  const harness = platformDiscoveryHarness(command);
  const chromeApi = chromeMock(async (_tabId, message) => (
    message.type === "PING"
      ? { ok: true, route: "#/pagesWsla/pc/list/index", ready: true }
      : { ok: true, status: "uploaded" }
  ));

  const result = await createBrowserCommandPoller({
    chromeApi,
    fetchImpl: harness.fetchImpl,
    initialActivePlatformAccountId: command.platformAccountId,
  }).pollOnce();

  assert.equal(result.ok, true);
  assert.deepEqual(harness.resultBody(), {
    deviceId: "device-test",
    claimToken: "claim-once",
    status: "manual_required",
    resultCode: "EVIDENCE_NOT_CLOSED",
    resultSummary: "证据未完成服务器闭环",
    progress: null,
    evidenceClosed: false,
  });
});

test("QUERY_ALL_EXPORT 仅在报表上传且证据闭环时回写成功", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000129",
    type: "QUERY_ALL_EXPORT",
    platformAccountId: "00000000-0000-4000-8000-000000000329",
    clientBatchId: "00000000-0000-4000-8000-000000000229",
  };
  const harness = platformDiscoveryHarness(command);
  const chromeApi = chromeMock(async (_tabId, message) => (
    message.type === "PING"
      ? { ok: true, route: "#/pagesWsla/pc/list/index", ready: true }
      : { ok: true, status: "uploaded", evidenceClosed: true }
  ));

  const result = await createBrowserCommandPoller({
    chromeApi,
    fetchImpl: harness.fetchImpl,
    initialActivePlatformAccountId: command.platformAccountId,
  }).pollOnce();

  assert.equal(result.ok, true);
  assert.equal(harness.resultBody().status, "succeeded");
  assert.equal(harness.resultBody().resultCode, "SUCCESS");
  assert.equal(harness.resultBody().evidenceClosed, true);
});

test("多个非活动法院列表标签时选择最近使用标签并在执行前显式激活", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000121",
    type: "QUERY_LI",
    platformAccountId: "00000000-0000-4000-8000-000000000221",
    clientBatchId: "00000000-0000-4000-8000-000000000321",
  };
  const activated = [];
  const dispatched = [];
  const chromeApi = chromeMock(async (tabId) => {
    dispatched.push(tabId);
    return { ok: true, progress: { done: 1, total: 1 } };
  });
  chromeApi.tabs.query = async () => [
    { id: 7, active: false, lastAccessed: 200, url: "https://zxfw.court.gov.cn/#/pages/pc/case-list/index" },
    { id: 8, active: false, lastAccessed: 300, url: "https://zxfw.court.gov.cn/#/pagesWsla/pc/list/index" },
  ];
  chromeApi.tabs.update = async (tabId, options) => {
    activated.push([tabId, options]);
    return { id: tabId, active: options.active };
  };
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.endsWith("/browser-commands/next")) return response({ command });
    if (value.endsWith(`/browser-commands/${command.id}/claim`)) {
      return response({ command, claimToken: "claim-active-tab" });
    }
    if (value.endsWith(`/import-batches/${command.clientBatchId}/extension-data`)) {
      return response({ queryMode: "platform_discovery", rows: [] });
    }
    if (value.endsWith(`/browser-commands/${command.id}/result`)) {
      return response({ command: { status: "succeeded" } });
    }
    throw new Error(`unexpected ${value}`);
  };

  const result = await createBrowserCommandPoller({ chromeApi, fetchImpl }).pollOnce();
  assert.equal(result.ok, true);
  assert.deepEqual(activated, [[8, { active: true }]]);
  assert.deepEqual(dispatched, [8]);
});

test("QUERY_LI 始终选择网上立案列表，即使我的案件标签处于活动状态", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000124",
    type: "QUERY_LI",
    platformAccountId: "00000000-0000-4000-8000-000000000224",
    clientBatchId: "00000000-0000-4000-8000-000000000324",
  };
  const dispatched = [];
  const chromeApi = chromeMock(async (tabId) => {
    dispatched.push(tabId);
    return { ok: true };
  });
  chromeApi.tabs.query = async () => [
    { id: 7, active: true, lastAccessed: 500, url: "https://zxfw.court.gov.cn/#/pages/pc/case-list/index" },
    { id: 8, active: false, lastAccessed: 100, url: "https://zxfw.court.gov.cn/#/pagesWsla/pc/list/index" },
  ];
  chromeApi.tabs.update = async (tabId) => ({ id: tabId, active: true });
  const harness = platformDiscoveryHarness(command);

  const result = await createBrowserCommandPoller({ chromeApi, fetchImpl: harness.fetchImpl }).pollOnce();

  assert.equal(result.ok, true);
  assert.deepEqual(dispatched, [8]);
});

test("QUERY_LI 只有我的案件标签时转人工且不下发 content 命令", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000125",
    type: "QUERY_LI",
    platformAccountId: "00000000-0000-4000-8000-000000000225",
    clientBatchId: "00000000-0000-4000-8000-000000000325",
  };
  let dispatched = 0;
  const chromeApi = chromeMock(async () => {
    dispatched += 1;
    return { ok: true };
  });
  chromeApi.tabs.query = async () => [
    { id: 7, active: true, url: "https://zxfw.court.gov.cn/#/pages/pc/case-list/index" },
  ];
  const harness = platformDiscoveryHarness(command);

  const result = await createBrowserCommandPoller({ chromeApi, fetchImpl: harness.fetchImpl }).pollOnce();

  assert.equal(result.ok, false);
  assert.equal(dispatched, 0);
  assert.equal(harness.resultBody().resultCode, "ONLINE_FILING_PAGE_REQUIRED");
});

test("QUERY_QZ 也只选择网上立案标签，不再派发到我的案件执行页", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000126",
    type: "QUERY_QZ",
    platformAccountId: "00000000-0000-4000-8000-000000000226",
    clientBatchId: "00000000-0000-4000-8000-000000000326",
  };
  const dispatched = [];
  const chromeApi = chromeMock(async (tabId) => {
    dispatched.push(tabId);
    return { ok: true };
  });
  chromeApi.tabs.query = async () => [
    { id: 7, active: true, lastAccessed: 500, url: "https://zxfw.court.gov.cn/#/pages/pc/case-list/index" },
    { id: 8, active: false, lastAccessed: 100, url: "https://zxfw.court.gov.cn/#/pagesWsla/pc/list/index" },
  ];
  chromeApi.tabs.update = async (tabId) => ({ id: tabId, active: true });
  const harness = platformDiscoveryHarness(command);

  const result = await createBrowserCommandPoller({ chromeApi, fetchImpl: harness.fetchImpl }).pollOnce();

  assert.equal(result.ok, true);
  assert.deepEqual(dispatched, [8]);
});

test("QUERY_QZ 只有我的案件标签时回写 ONLINE_FILING_PAGE_REQUIRED", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000127",
    type: "QUERY_QZ",
    platformAccountId: "00000000-0000-4000-8000-000000000227",
    clientBatchId: "00000000-0000-4000-8000-000000000327",
  };
  let dispatched = 0;
  const chromeApi = chromeMock(async () => {
    dispatched += 1;
    return { ok: true };
  });
  chromeApi.tabs.query = async () => [
    { id: 7, active: true, url: "https://zxfw.court.gov.cn/#/pages/pc/case-list/index" },
  ];
  const harness = platformDiscoveryHarness(command);

  const result = await createBrowserCommandPoller({ chromeApi, fetchImpl: harness.fetchImpl }).pollOnce();

  assert.equal(result.ok, false);
  assert.equal(dispatched, 0);
  assert.equal(harness.resultBody().resultCode, "ONLINE_FILING_PAGE_REQUIRED");
});

test("活动法院标签优先于 lastAccessed 更新的非活动标签", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000122",
    type: "QUERY_LI",
    platformAccountId: "00000000-0000-4000-8000-000000000222",
    clientBatchId: "00000000-0000-4000-8000-000000000322",
  };
  const activated = [];
  const dispatched = [];
  const chromeApi = chromeMock(async (tabId) => {
    dispatched.push(tabId);
    return { ok: true };
  });
  chromeApi.tabs.query = async () => [
    { id: 7, active: true, lastAccessed: 100, url: "https://zxfw.court.gov.cn/#/pagesWsla/pc/list/index" },
    { id: 8, active: false, lastAccessed: 500, url: "https://zxfw.court.gov.cn/#/pagesWsla/pc/list/index" },
  ];
  chromeApi.tabs.update = async (tabId, options) => {
    activated.push([tabId, options]);
    return { id: tabId, active: true };
  };
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.endsWith("/browser-commands/next")) return response({ command });
    if (value.endsWith(`/browser-commands/${command.id}/claim`)) return response({ command, claimToken: "claim-active-priority" });
    if (value.endsWith(`/import-batches/${command.clientBatchId}/extension-data`)) return response({ queryMode: "platform_discovery", rows: [] });
    if (value.endsWith(`/browser-commands/${command.id}/result`)) return response({ command: { status: "succeeded" } });
    throw new Error(`unexpected ${value}`);
  };

  assert.equal((await createBrowserCommandPoller({ chromeApi, fetchImpl }).pollOnce()).ok, true);
  assert.deepEqual(activated, [[7, { active: true }]]);
  assert.deepEqual(dispatched, [7]);
});

test("法院标签激活失败时不发送 content 命令并转人工", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000123",
    type: "QUERY_LI",
    platformAccountId: "00000000-0000-4000-8000-000000000223",
    clientBatchId: "00000000-0000-4000-8000-000000000323",
  };
  let dispatched = 0;
  let resultBody;
  const chromeApi = chromeMock(async () => {
    dispatched += 1;
    return { ok: true };
  });
  chromeApi.tabs.update = async () => { throw new Error("synthetic activation failure"); };
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/browser-commands/next")) return response({ command });
    if (value.endsWith(`/browser-commands/${command.id}/claim`)) return response({ command, claimToken: "claim-activation-failure" });
    if (value.endsWith(`/browser-commands/${command.id}/result`)) {
      resultBody = JSON.parse(init.body);
      return response({ command: { status: "manual_required" } });
    }
    throw new Error(`unexpected ${value}`);
  };

  const result = await createBrowserCommandPoller({ chromeApi, fetchImpl }).pollOnce();
  assert.deepEqual(result, { ok: false, error: "COURT_TAB_ACTIVATION_FAILED", commandId: command.id });
  assert.equal(dispatched, 0);
  assert.equal(resultBody.status, "manual_required");
  assert.equal(resultBody.resultCode, "COURT_TAB_ACTIVATION_FAILED");
});

test("同一运行期自动登录绑定的后台账号与查询账号不一致时，不读取批次数据并转人工", async () => {
  const loginCommand = {
    id: "00000000-0000-4000-8000-000000000111",
    type: "LOGIN",
    platformAccountId: "00000000-0000-4000-8000-000000000211",
  };
  const queryCommand = {
    id: "00000000-0000-4000-8000-000000000112",
    type: "QUERY_LI",
    platformAccountId: "00000000-0000-4000-8000-000000000212",
    clientBatchId: "00000000-0000-4000-8000-000000000312",
  };
  const commands = [loginCommand, queryCommand];
  const resultBodies = new Map();
  let currentHash = "#/pagesGrxx/pc/login/index";
  let extensionDataCalls = 0;
  const chromeApi = chromeMock(async (_tabId, message) => {
    if (message.type === "PING") return { ok: true, route: "#/pagesGrxx/pc/login/index" };
    assert.equal(message.commandType, "LOGIN");
    currentHash = "#/pagesWsla/pc/list/index";
    return { ok: true };
  });
  chromeApi.tabs.query = async () => [{ id: 7, url: `https://zxfw.court.gov.cn/${currentHash}` }];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/browser-commands/next")) return response({ command: commands.shift() ?? null });
    const command = [loginCommand, queryCommand].find((item) => value.endsWith(`/browser-commands/${item.id}/claim`));
    if (command) return response({ command: { ...command, status: "executing" }, claimToken: `claim-${command.id}` });
    if (value.endsWith(`/platform-accounts/${loginCommand.platformAccountId}/credential`)) {
      return response({ account: "synthetic-account", password: "synthetic-password" });
    }
    if (value.endsWith(`/import-batches/${queryCommand.clientBatchId}/extension-data`)) {
      extensionDataCalls += 1;
      return response({ queryMode: "platform_discovery", rows: [] });
    }
    const resultCommand = [loginCommand, queryCommand].find((item) => value.endsWith(`/browser-commands/${item.id}/result`));
    if (resultCommand) {
      resultBodies.set(resultCommand.id, JSON.parse(init.body));
      return response({ command: { status: "succeeded" } });
    }
    throw new Error(`unexpected ${value}`);
  };

  const poller = createBrowserCommandPoller({ chromeApi, fetchImpl });
  assert.equal((await poller.pollOnce()).ok, true);
  const queryResult = await poller.pollOnce();

  assert.deepEqual(queryResult, { ok: false, error: "ACCOUNT_MISMATCH", commandId: queryCommand.id });
  assert.equal(extensionDataCalls, 0);
  assert.deepEqual(resultBodies.get(queryCommand.id), {
    deviceId: "device-test",
    claimToken: `claim-${queryCommand.id}`,
    status: "manual_required",
    resultCode: "ACCOUNT_MISMATCH",
    resultSummary: "需要人工接管",
    progress: null,
  });
  assert.equal(JSON.stringify(resultBodies.get(queryCommand.id)).includes("synthetic-password"), false);
});

test("历史非空模板任务只回写待人工，绝不将业务行发送给 content", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000113",
    type: "QUERY_LI",
    platformAccountId: "00000000-0000-4000-8000-000000000213",
    clientBatchId: "00000000-0000-4000-8000-000000000313",
  };
  let resultBody;
  const chromeApi = chromeMock(async () => assert.fail("content must not receive legacy rows"));
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/browser-commands/next")) return response({ command });
    if (value.endsWith(`/browser-commands/${command.id}/claim`)) return response({ command, claimToken: "claim-legacy" });
    if (value.endsWith(`/import-batches/${command.clientBatchId}/extension-data`)) {
      return response({ queryMode: "template_not_empty", rows: [] });
    }
    if (value.endsWith(`/browser-commands/${command.id}/result`)) {
      resultBody = JSON.parse(init.body);
      return response({ command: { status: "manual_required" } });
    }
    throw new Error(`unexpected ${value}`);
  };

  const result = await createBrowserCommandPoller({ chromeApi, fetchImpl }).pollOnce();
  assert.equal(result.error, "TEMPLATE_NOT_EMPTY");
  assert.deepEqual(resultBody, {
    deviceId: "device-test",
    claimToken: "claim-legacy",
    status: "manual_required",
    resultCode: "TEMPLATE_NOT_EMPTY",
    resultSummary: "需要人工接管",
    progress: null,
  });
});

test("LOGIN waits for the selected court tab to reach the login route before fetching credentials", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000301",
    type: "LOGIN",
    platformAccountId: "00000000-0000-4000-8000-000000000302",
  };
  let tabQueries = 0;
  const dispatched = [];
  let resultBody;
  const chromeApi = chromeMock(async (_tabId, message) => {
    if (message.type === "PING") return { ok: true, route: "#/pagesGrxx/pc/login/password?from=redirect" };
    dispatched.push(message);
    return { ok: true };
  });
  chromeApi.tabs.query = async () => {
    tabQueries += 1;
    const hash = tabQueries === 1 ? "#/pages/pc/index" : "#/pagesGrxx/pc/login/password?from=redirect";
    return [{ id: 7, active: true, url: `https://zxfw.court.gov.cn/${hash}` }];
  };
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/browser-commands/next")) return response({ command });
    if (value.endsWith(`/browser-commands/${command.id}/claim`)) return response({ command, claimToken: "claim-login-route" });
    if (value.endsWith(`/platform-accounts/${command.platformAccountId}/credential`)) {
      return response({ account: "synthetic-account", password: "synthetic-password" });
    }
    if (value.endsWith(`/browser-commands/${command.id}/result`)) {
      resultBody = JSON.parse(init.body);
      return response({ command: { status: "succeeded" } });
    }
    throw new Error(`unexpected ${value}`);
  };

  const result = await createBrowserCommandPoller({
    chromeApi,
    fetchImpl,
    contentRouteRetryDelayMs: 0,
    contentRouteRetryAttempts: 2,
  }).pollOnce();

  assert.equal(result.ok, true);
  assert.ok(tabQueries >= 2);
  assert.equal(dispatched.filter((message) => message.commandType === "LOGIN").length, 1);
  assert.equal(resultBody.resultCode, "SUCCESS");
  assert.equal(JSON.stringify(resultBody).includes("synthetic-password"), false);
});

test("LOGIN retries a transient missing content receiver without fetching credentials again", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000304",
    type: "LOGIN",
    platformAccountId: "00000000-0000-4000-8000-000000000305",
  };
  let commandDispatches = 0;
  let credentialReads = 0;
  let resultBody;
  const chromeApi = chromeMock(async (_tabId, message) => {
    if (message.type === "PING") return { ok: true, route: "#/pagesGrxx/pc/login/index" };
    commandDispatches += 1;
    if (commandDispatches === 1) throw new Error("Could not establish connection. Receiving end does not exist.");
    return { ok: true };
  });
  chromeApi.tabs.query = async () => [{ id: 7, url: "https://zxfw.court.gov.cn/#/pagesGrxx/pc/login/index" }];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/browser-commands/next")) return response({ command });
    if (value.endsWith(`/browser-commands/${command.id}/claim`)) return response({ command, claimToken: "claim-login-content" });
    if (value.endsWith(`/platform-accounts/${command.platformAccountId}/credential`)) {
      credentialReads += 1;
      return response({ account: "synthetic-account", password: "synthetic-password" });
    }
    if (value.endsWith(`/browser-commands/${command.id}/result`)) {
      resultBody = JSON.parse(init.body);
      return response({ command: { status: "succeeded" } });
    }
    throw new Error(`unexpected ${value}`);
  };

  const result = await createBrowserCommandPoller({
    chromeApi,
    fetchImpl,
    contentRouteRetryDelayMs: 0,
    contentRouteRetryAttempts: 2,
  }).pollOnce();

  assert.equal(result.ok, true);
  assert.equal(commandDispatches, 2);
  assert.equal(credentialReads, 1);
  assert.equal(resultBody.resultCode, "SUCCESS");
  assert.equal(JSON.stringify(resultBody).includes("synthetic-password"), false);
});

test("LOGIN route timeout does not fetch credentials and reports a manual-required code", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000306",
    type: "LOGIN",
    platformAccountId: "00000000-0000-4000-8000-000000000307",
  };
  let credentialReads = 0;
  let resultBody;
  const chromeApi = chromeMock(async () => assert.fail("content must not be called before the login route is ready"));
  chromeApi.tabs.query = async () => [{ id: 7, url: "https://zxfw.court.gov.cn/#/pages/pc/index" }];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/browser-commands/next")) return response({ command });
    if (value.endsWith(`/browser-commands/${command.id}/claim`)) return response({ command, claimToken: "claim-login-timeout" });
    if (value.endsWith(`/platform-accounts/${command.platformAccountId}/credential`)) credentialReads += 1;
    if (value.endsWith(`/browser-commands/${command.id}/result`)) {
      resultBody = JSON.parse(init.body);
      return response({ command: { status: "manual_required" } });
    }
    throw new Error(`unexpected ${value}`);
  };

  const result = await createBrowserCommandPoller({
    chromeApi,
    fetchImpl,
    contentRouteRetryDelayMs: 0,
    contentRouteRetryAttempts: 2,
  }).pollOnce();

  assert.equal(result.error, "LOGIN_PAGE_TIMEOUT");
  assert.equal(credentialReads, 0);
  assert.equal(resultBody.status, "manual_required");
  assert.equal(resultBody.resultCode, "LOGIN_PAGE_TIMEOUT");
});

test("LOGIN content timeout does not leak credentials in the result", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000308",
    type: "LOGIN",
    platformAccountId: "00000000-0000-4000-8000-000000000309",
  };
  let commandDispatches = 0;
  let credentialReads = 0;
  let resultBody;
  const chromeApi = chromeMock(async (_tabId, message) => {
    if (message.type === "PING") return { ok: false };
    commandDispatches += 1;
    throw new Error("Could not establish connection. Receiving end does not exist.");
  });
  chromeApi.tabs.query = async () => [{ id: 7, url: "https://zxfw.court.gov.cn/#/pagesGrxx/pc/login/index" }];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/browser-commands/next")) return response({ command });
    if (value.endsWith(`/browser-commands/${command.id}/claim`)) return response({ command, claimToken: "claim-login-content-timeout" });
    if (value.endsWith(`/platform-accounts/${command.platformAccountId}/credential`)) {
      credentialReads += 1;
      return response({ account: "synthetic-account", password: "synthetic-password" });
    }
    if (value.endsWith(`/browser-commands/${command.id}/result`)) {
      resultBody = JSON.parse(init.body);
      return response({ command: { status: "manual_required" } });
    }
    throw new Error(`unexpected ${value}`);
  };

  const result = await createBrowserCommandPoller({
    chromeApi,
    fetchImpl,
    contentRouteRetryDelayMs: 0,
    contentRouteRetryAttempts: 2,
  }).pollOnce();

  assert.equal(result.error, "LOGIN_CONTENT_UNAVAILABLE");
  assert.equal(commandDispatches, 0);
  assert.equal(credentialReads, 0);
  assert.equal(resultBody.status, "manual_required");
  assert.equal(resultBody.resultCode, "LOGIN_CONTENT_UNAVAILABLE");
  assert.equal(JSON.stringify(resultBody).includes("synthetic-password"), false);
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

test("报表命令在 Worker 冷启动后仍使用命令绑定的账号执行导出", async () => {
  const platformAccountId = "00000000-0000-4000-8000-000000000407";
  const command = {
    id: "00000000-0000-4000-8000-000000000406",
    type: "EXPORT_REPORT",
    platformAccountId,
  };
  const dispatched = [];
  const chromeApi = chromeMock(async (tabId, message) => {
    dispatched.push({ tabId, message });
    return { status: "uploaded", exportId: "synthetic-export" };
  });
  let resultBody;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith("/browser-commands/next")) return response({ command });
    if (String(url).endsWith(`/browser-commands/${command.id}/claim`)) return response({ command, claimToken: "claim" });
    if (String(url).endsWith(`/platform-accounts/${platformAccountId}/credential`)) {
      return response({ label: "测试账号标签", account: "synthetic-account", password: "synthetic-password" });
    }
    if (String(url).endsWith(`/browser-commands/${command.id}/result`)) {
      resultBody = JSON.parse(init.body);
      return response({ command: { status: "succeeded" } });
    }
    throw new Error(`unexpected ${url}`);
  };

  const result = await createBrowserCommandPoller({ chromeApi, fetchImpl }).pollOnce();
  assert.equal(result.commandId, command.id);
  assert.deepEqual(dispatched, [{
    tabId: 7,
    message: {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "EXPORT_REPORT",
      platformAccountId,
      accountLabel: "测试账号标签",
      exportCredential: { account: "synthetic-account", password: "synthetic-password" },
    },
  }]);
  assert.deepEqual(resultBody, {
    deviceId: "device-test",
    claimToken: "claim",
    status: "succeeded",
    resultCode: "SUCCESS",
    resultSummary: "报表已上传服务器",
    progress: null,
  });
});

test("报表命令兼容旧服务凭据响应并按 UUID 精确补取非敏感账号标签", async () => {
  const platformAccountId = "00000000-0000-4000-8000-000000000417";
  const command = {
    id: "00000000-0000-4000-8000-000000000416",
    type: "QUERY_ALL_EXPORT",
    platformAccountId,
    clientBatchId: "00000000-0000-4000-8000-000000000422",
  };
  let accountListReads = 0;
  let dispatched;
  const chromeApi = chromeMock(async (_tabId, message) => {
    if (message.type === "PING") {
      return { ok: true, route: "#/pagesWsla/pc/list/index", ready: true };
    }
    dispatched = message;
    return { status: "uploaded", exportId: "synthetic-export" };
  });
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/browser-commands/next")) return response({ command });
    if (value.endsWith(`/browser-commands/${command.id}/claim`)) return response({ command, claimToken: "claim-old-service" });
    if (value.endsWith(`/import-batches/${command.clientBatchId}/extension-data`)) {
      return response({ queryMode: "platform_discovery", rows: [] });
    }
    if (value.endsWith(`/platform-accounts/${platformAccountId}/credential`)) {
      return response({ account: "synthetic-account", password: "synthetic-password" });
    }
    if (value.endsWith("/platform-accounts")) {
      accountListReads += 1;
      return response({
        platformAccounts: [
          { id: "00000000-0000-4000-8000-000000000999", label: "其他账号" },
          { id: platformAccountId, label: "旧服务兼容标签" },
        ],
      });
    }
    if (value.endsWith(`/browser-commands/${command.id}/result`)) {
      return response({ command: { status: JSON.parse(init.body).status } });
    }
    throw new Error(`unexpected ${value}`);
  };

  const result = await createBrowserCommandPoller({
    chromeApi,
    fetchImpl,
    initialActivePlatformAccountId: platformAccountId,
  }).pollOnce();

  assert.equal(result.status, "uploaded");
  assert.equal(accountListReads, 1);
  assert.deepEqual(dispatched, {
    type: "BROWSER_COMMAND_EXECUTE",
    commandType: "QUERY_ALL_EXPORT",
    queryMode: "platform_discovery",
    platformAccountId,
    accountBindingVerified: true,
    accountLabel: "旧服务兼容标签",
    exportCredential: { account: "synthetic-account", password: "synthetic-password" },
  });
});

test("旧服务缺少可精确匹配的账号标签时拒绝导出且不使用真实账号命名", async () => {
  const platformAccountId = "00000000-0000-4000-8000-000000000419";
  const command = {
    id: "00000000-0000-4000-8000-000000000418",
    type: "EXPORT_REPORT",
    platformAccountId,
  };
  let resultBody;
  const chromeApi = chromeMock(async () => assert.fail("标签不可用时不得调用 content 下载或上传"));
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/browser-commands/next")) return response({ command });
    if (value.endsWith(`/browser-commands/${command.id}/claim`)) return response({ command, claimToken: "claim-label-missing" });
    if (value.endsWith(`/platform-accounts/${platformAccountId}/credential`)) {
      return response({ account: "must-not-be-a-file-name", password: "synthetic-password" });
    }
    if (value.endsWith("/platform-accounts")) return response({ platformAccounts: [] });
    if (value.endsWith(`/browser-commands/${command.id}/result`)) {
      resultBody = JSON.parse(init.body);
      return response({ command: { status: resultBody.status } });
    }
    throw new Error(`unexpected ${value}`);
  };

  const result = await createBrowserCommandPoller({ chromeApi, fetchImpl }).pollOnce();

  assert.equal(result.error, "ACCOUNT_LABEL_UNAVAILABLE");
  assert.equal(resultBody.status, "manual_required");
  assert.equal(resultBody.resultCode, "ACCOUNT_LABEL_UNAVAILABLE");
  assert.equal(JSON.stringify(resultBody).includes("must-not-be-a-file-name"), false);
  assert.equal(JSON.stringify(resultBody).includes("synthetic-password"), false);
});

test("报表凭据请求保留授权失效及账号不可用的稳定错误语义", async () => {
  const scenarios = [
    { status: 401, code: "AUTH_REQUIRED", expectedReason: "AUTH_REQUIRED", writesResult: false },
    { status: 404, code: "NOT_FOUND", expectedCode: "PLATFORM_ACCOUNT_UNAVAILABLE", writesResult: true },
    { status: 409, code: "ACCOUNT_DISABLED", expectedCode: "ACCOUNT_DISABLED", writesResult: true },
    { status: 503, code: "CREDENTIAL_UNAVAILABLE", expectedCode: "CREDENTIAL_UNAVAILABLE", writesResult: true },
  ];

  for (const scenario of scenarios) {
    const platformAccountId = "00000000-0000-4000-8000-000000000421";
    const command = {
      id: "00000000-0000-4000-8000-000000000420",
      type: "EXPORT_REPORT",
      platformAccountId,
    };
    let resultBody;
    const chromeApi = chromeMock(async () => assert.fail("凭据失败时不得调用 content"));
    const fetchImpl = async (url, init = {}) => {
      const value = String(url);
      if (value.endsWith("/browser-commands/next")) return response({ command });
      if (value.endsWith(`/browser-commands/${command.id}/claim`)) return response({ command, claimToken: "claim-credential-error" });
      if (value.endsWith(`/platform-accounts/${platformAccountId}/credential`)) {
        return response({ error: { code: scenario.code, message: "safe" } }, scenario.status);
      }
      if (value.endsWith(`/browser-commands/${command.id}/result`)) {
        resultBody = JSON.parse(init.body);
        return response({ command: { status: resultBody.status } });
      }
      throw new Error(`unexpected ${value}`);
    };

    const result = await createBrowserCommandPoller({ chromeApi, fetchImpl }).pollOnce();
    if (scenario.writesResult) {
      assert.equal(result.error, scenario.expectedCode);
      assert.equal(resultBody.status, "manual_required");
      assert.equal(resultBody.resultCode, scenario.expectedCode);
    } else {
      assert.deepEqual(result, { ok: false, reason: scenario.expectedReason });
      assert.equal(resultBody, undefined);
      const stored = await chromeApi.storage.local.get();
      assert.equal(stored.token, undefined);
    }
  }
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
    const platformAccountId = "00000000-0000-4000-8000-000000000414";
    const loginCommand = {
      id: "00000000-0000-4000-8000-000000000413",
      type: "LOGIN",
      platformAccountId,
    };
    const command = {
      id: "00000000-0000-4000-8000-000000000404",
      type: "EXPORT_REPORT",
      platformAccountId,
    };
    const commands = [loginCommand, command];
    let currentHash = "#/pagesGrxx/pc/login/index";
    let resultBody;
    const chromeApi = chromeMock(async (_tabId, message) => {
      if (message.type === "PING") return { ok: true, route: currentHash };
      if (message.commandType === "LOGIN") {
        currentHash = "#/pagesWsla/pc/list/index";
        return { ok: true };
      }
      assert.deepEqual(message, {
        type: "BROWSER_COMMAND_EXECUTE",
        commandType: "EXPORT_REPORT",
        platformAccountId,
        accountLabel: "测试账号标签",
        exportCredential: { account: "synthetic-account", password: "synthetic-password" },
      });
      return contentResponse;
    });
    chromeApi.tabs.query = async () => [{ id: 7, url: `https://zxfw.court.gov.cn/${currentHash}` }];
    const fetchImpl = async (url, init = {}) => {
      if (String(url).endsWith("/browser-commands/next")) return response({ command: commands.shift() ?? null });
      if (String(url).endsWith(`/platform-accounts/${platformAccountId}/credential`)) {
        return response({ label: "测试账号标签", account: "synthetic-account", password: "synthetic-password" });
      }
      if (String(url).endsWith(`/browser-commands/${loginCommand.id}/claim`)) {
        return response({ command: loginCommand, claimToken: "claim-login" });
      }
      if (String(url).endsWith(`/browser-commands/${command.id}/claim`)) {
        return response({ command, claimToken: "claim-report" });
      }
      if (String(url).endsWith(`/browser-commands/${loginCommand.id}/result`)) {
        return response({ command: { status: "succeeded" } });
      }
      if (String(url).endsWith(`/browser-commands/${command.id}/result`)) {
        resultBody = JSON.parse(init.body);
        return response({ command: { status: "succeeded" } });
      }
      throw new Error(`unexpected ${url}`);
    };

    const poller = createBrowserCommandPoller({ chromeApi, fetchImpl });
    const result = await poller.pollOnce();
    assert.equal(result.commandId, loginCommand.id, contentResponse.status);
    const exportResult = await poller.pollOnce();
    assert.equal(exportResult.commandId, command.id, contentResponse.status);
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

test("QUERY_LI does not reconnect after a non-navigation content error", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000811",
    type: "QUERY_LI",
    platformAccountId: "00000000-0000-4000-8000-000000000812",
    clientBatchId: "00000000-0000-4000-8000-000000000813",
  };
  let commandSendCount = 0;
  let resultBody;
  const chromeApi = chromeMock(async () => {
    commandSendCount += 1;
    throw new Error("Could not establish connection. Receiving end does not exist.");
  });
  chromeApi.tabs.query = async () => [{ id: 7, url: "https://zxfw.court.gov.cn/#/pagesWsla/pc/list/index" }];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/browser-commands/next")) return response({ command });
    if (value.endsWith(`/browser-commands/${command.id}/claim`)) return response({ command, claimToken: "claim-once" });
    if (value.endsWith(`/import-batches/${command.clientBatchId}/extension-data`)) return response({ queryMode: "platform_discovery", rows: [] });
    if (value.endsWith(`/browser-commands/${command.id}/result`)) {
      resultBody = JSON.parse(init.body);
      return response({ command: { status: "failed" } });
    }
    throw new Error(`unexpected ${value}`);
  };

  const result = await createBrowserCommandPoller({ chromeApi, fetchImpl, contentRouteRetryDelayMs: 0 }).pollOnce();

  assert.equal(commandSendCount, 1);
  assert.equal(result.error, "CONTENT_UNAVAILABLE");
  assert.equal(resultBody.resultCode, "CONTENT_UNAVAILABLE");
  assert.equal(resultBody.status, "failed");
});

test("QUERY_LI does not reconnect after an unexpected route handoff", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000801",
    type: "QUERY_LI",
    platformAccountId: "00000000-0000-4000-8000-000000000802",
    clientBatchId: "00000000-0000-4000-8000-000000000803",
  };
  let handedOff = false;
  let commandSendCount = 0;
  let pingCount = 0;
  let resultBody;
  const chromeApi = chromeMock(async (_tabId, message) => {
    if (message.type === "PING") {
      pingCount += 1;
      return { ok: true, route: "#/pages/pc/case-list/index" };
    }
    commandSendCount += 1;
    assert.equal(message.commandType, "QUERY_LI");
    if (commandSendCount === 1) {
      assert.equal(message.queryPhase, undefined);
      handedOff = true;
      throw new Error("The message port closed before a response was received.");
    }
    assert.equal(message.queryPhase, "mycase_evidence");
    return { ok: false, error: "UNKNOWN" };
  });
  chromeApi.tabs.query = async () => [{
    id: 7,
    url: `https://zxfw.court.gov.cn/#/${handedOff ? "pages/pc/case-list/index" : "pagesWsla/pc/list/index"}`,
  }];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.endsWith("/browser-commands/next")) return response({ command });
    if (value.endsWith(`/browser-commands/${command.id}/claim`)) {
      return response({ command, claimToken: "claim-once" });
    }
    if (value.endsWith(`/import-batches/${command.clientBatchId}/extension-data`)) {
      return response({ queryMode: "platform_discovery", rows: [] });
    }
    if (value.endsWith(`/browser-commands/${command.id}/result`)) {
      resultBody = JSON.parse(init.body);
      return response({ command: { status: "manual_required" } });
    }
    throw new Error(`unexpected ${value}`);
  };

  const poller = createBrowserCommandPoller({
    chromeApi,
    fetchImpl,
    contentRouteRetryDelayMs: 0,
  });
  const result = await poller.pollOnce();

  assert.equal(commandSendCount, 1);
  assert.equal(pingCount, 0);
  assert.equal(result.error, "CONTENT_UNAVAILABLE");
  assert.equal(resultBody.status, "failed");
});

test("QUERY_LI does not reattach when a message closes from an initial my-case route", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000821",
    type: "QUERY_LI",
    platformAccountId: "00000000-0000-4000-8000-000000000822",
    clientBatchId: "00000000-0000-4000-8000-000000000823",
  };
  let commandSendCount = 0;
  const chromeApi = chromeMock(async () => {
    commandSendCount += 1;
    throw new Error("The message port closed before a response was received.");
  });
  chromeApi.tabs.query = async () => [{ id: 7, url: "https://zxfw.court.gov.cn/#/pages/pc/case-list/index" }];
  const harness = platformDiscoveryHarness(command);

  const result = await createBrowserCommandPoller({ chromeApi, fetchImpl: harness.fetchImpl }).pollOnce();

  assert.equal(commandSendCount, 0);
  assert.equal(result.error, "ONLINE_FILING_PAGE_REQUIRED");
  assert.equal(harness.resultBody()?.status, "manual_required");
});

test("QUERY_LI bounds a pending my-case PING before reporting the route timeout", { timeout: 1000 }, async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000831",
    type: "QUERY_LI",
    platformAccountId: "00000000-0000-4000-8000-000000000832",
    clientBatchId: "00000000-0000-4000-8000-000000000833",
  };
  let handedOff = false;
  let pingCount = 0;
  const chromeApi = chromeMock(async (_tabId, message) => {
    if (message.type === "PING") {
      pingCount += 1;
      return new Promise(() => {});
    }
    handedOff = true;
    throw new Error("The message port closed before a response was received.");
  });
  chromeApi.tabs.query = async () => [{
    id: 7,
    url: `https://zxfw.court.gov.cn/#/${handedOff ? "pages/pc/case-list/index" : "pagesWsla/pc/list/index"}`,
  }];
  const harness = platformDiscoveryHarness(command);

  const result = await createBrowserCommandPoller({
    chromeApi,
    fetchImpl: harness.fetchImpl,
    contentRouteRetryDelayMs: 0,
    contentRouteRetryAttempts: 1,
    contentRoutePingTimeoutMs: 1,
  }).pollOnce();

  assert.equal(pingCount, 0);
  assert.equal(result.error, "CONTENT_UNAVAILABLE");
  assert.equal(harness.resultBody()?.status, "failed");
});

test("QUERY_LI bounds a pending my-case evidence phase and returns a manual code", { timeout: 1000 }, async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000841",
    type: "QUERY_LI",
    platformAccountId: "00000000-0000-4000-8000-000000000842",
    clientBatchId: "00000000-0000-4000-8000-000000000843",
  };
  let handedOff = false;
  let phaseSendCount = 0;
  const chromeApi = chromeMock(async (_tabId, message) => {
    if (message.type === "PING") return { ok: true, route: "#/pages/pc/case-list/index" };
    if (message.queryPhase === "mycase_evidence") {
      phaseSendCount += 1;
      return new Promise(() => {});
    }
    handedOff = true;
    throw new Error("The message port closed before a response was received.");
  });
  chromeApi.tabs.query = async () => [{
    id: 7,
    url: `https://zxfw.court.gov.cn/#/${handedOff ? "pages/pc/case-list/index" : "pagesWsla/pc/list/index"}`,
  }];
  const harness = platformDiscoveryHarness(command);

  const result = await createBrowserCommandPoller({
    chromeApi,
    fetchImpl: harness.fetchImpl,
    contentRouteRetryDelayMs: 0,
    contentRoutePhaseTimeoutMs: 1,
  }).pollOnce();

  assert.equal(phaseSendCount, 0);
  assert.equal(result.error, "CONTENT_UNAVAILABLE");
  assert.equal(harness.resultBody()?.status, "failed");
});

test("QUERY_LI maps a second-phase port closure to a manual code without a third dispatch", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000851",
    type: "QUERY_LI",
    platformAccountId: "00000000-0000-4000-8000-000000000852",
    clientBatchId: "00000000-0000-4000-8000-000000000853",
  };
  let handedOff = false;
  let commandSendCount = 0;
  const chromeApi = chromeMock(async (_tabId, message) => {
    if (message.type === "PING") return { ok: true, route: "#/pages/pc/case-list/index" };
    commandSendCount += 1;
    if (commandSendCount === 1) {
      handedOff = true;
      throw new Error("The message port closed before a response was received.");
    }
    throw new Error("The message port closed before a response was received.");
  });
  chromeApi.tabs.query = async () => [{
    id: 7,
    url: `https://zxfw.court.gov.cn/#/${handedOff ? "pages/pc/case-list/index" : "pagesWsla/pc/list/index"}`,
  }];
  const harness = platformDiscoveryHarness(command);

  const result = await createBrowserCommandPoller({
    chromeApi,
    fetchImpl: harness.fetchImpl,
    contentRouteRetryDelayMs: 0,
  }).pollOnce();

  assert.equal(commandSendCount, 1);
  assert.equal(result.error, "CONTENT_UNAVAILABLE");
  assert.equal(harness.resultBody()?.status, "failed");
});

test("QUERY_LI normalizes an unknown second-phase content error to a manual code", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000861",
    type: "QUERY_LI",
    platformAccountId: "00000000-0000-4000-8000-000000000862",
    clientBatchId: "00000000-0000-4000-8000-000000000863",
  };
  let handedOff = false;
  const chromeApi = chromeMock(async (_tabId, message) => {
    if (message.type === "PING") return { ok: true, route: "#/pages/pc/case-list/index" };
    if (message.queryPhase === "mycase_evidence") return { ok: false, error: "NOT_READY" };
    handedOff = true;
    throw new Error("The message port closed before a response was received.");
  });
  chromeApi.tabs.query = async () => [{
    id: 7,
    url: `https://zxfw.court.gov.cn/#/${handedOff ? "pages/pc/case-list/index" : "pagesWsla/pc/list/index"}`,
  }];
  const harness = platformDiscoveryHarness(command);

  const result = await createBrowserCommandPoller({
    chromeApi,
    fetchImpl: harness.fetchImpl,
    contentRouteRetryDelayMs: 0,
  }).pollOnce();

  assert.equal(result.error, "CONTENT_UNAVAILABLE");
  assert.equal(harness.resultBody()?.status, "failed");
});
