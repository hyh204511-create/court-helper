import assert from "node:assert/strict";
import { test } from "node:test";

let importSequence = 0;

function makeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

async function waitFor(predicate, { attempts = 50 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met before timeout");
}

async function loadWorker({
  storageData = {},
  fetchImpl = async () => makeResponse({}),
  tabs = [],
  captureVisibleTab = async () => "data:image/jpeg;base64,",
} = {}) {
  const runtimeListeners = [];
  const storageListeners = [];
  const fetches = [];
  const alarmCreates = [];
  const intervals = new Map();
  let nextIntervalId = 1;
  const previous = {
    self: globalThis.self,
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  globalThis.self = {
    addEventListener() {},
    skipWaiting() {},
    clients: { claim() {} },
  };
  globalThis.fetch = async (url, init) => {
    fetches.push({ url, init });
    return fetchImpl(url, init);
  };
  globalThis.setInterval = (callback, delay) => {
    const id = nextIntervalId;
    nextIntervalId += 1;
    intervals.set(id, { callback, delay });
    return id;
  };
  globalThis.clearInterval = (id) => intervals.delete(id);
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
      sendMessage() {},
    },
    storage: {
      local: {
        get: async () => storageData,
        set: async (values) => Object.assign(storageData, values),
        remove: async (keys) => {
          for (const key of (Array.isArray(keys) ? keys : [keys])) delete storageData[key];
        },
      },
      onChanged: { addListener(listener) { storageListeners.push(listener); } },
    },
    alarms: {
      create(name, options) { alarmCreates.push({ name, options }); },
      clear() {},
      onAlarm: { addListener() {} },
    },
    tabs: {
      query: async () => tabs,
      sendMessage: async () => ({ ok: true }),
      captureVisibleTab,
    },
  };

  try {
    const worker = await import(`../extension/service-worker.js?export-upload-test=${importSequence++}`);
    return { worker, runtimeListener: runtimeListeners.at(-1), fetches, alarmCreates, intervals, storageData, notifyStorageChange(changes) {
      for (const [key, change] of Object.entries(changes)) {
        if (!Object.hasOwn(change ?? {}, "newValue")) continue;
        if (change.newValue === undefined) delete storageData[key];
        else storageData[key] = change.newValue;
      }
      for (const listener of storageListeners) listener(changes, "local");
    }, cleanup() {
      worker.getSyncCoordinator()?.stop?.();
      if (previous.self === undefined) delete globalThis.self;
      else globalThis.self = previous.self;
      if (previous.chrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = previous.chrome;
      if (previous.fetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = previous.fetch;
      if (previous.setInterval === undefined) delete globalThis.setInterval;
      else globalThis.setInterval = previous.setInterval;
      if (previous.clearInterval === undefined) delete globalThis.clearInterval;
      else globalThis.clearInterval = previous.clearInterval;
    } };
  } catch (error) {
    if (previous.self === undefined) delete globalThis.self;
    else globalThis.self = previous.self;
    if (previous.chrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous.chrome;
    if (previous.fetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous.fetch;
    if (previous.setInterval === undefined) delete globalThis.setInterval;
    else globalThis.setInterval = previous.setInterval;
    if (previous.clearInterval === undefined) delete globalThis.clearInterval;
    else globalThis.clearInterval = previous.clearInterval;
    throw error;
  }
}

function invoke(listener, message, sender = {}) {
  let response;
  const wireMessage = JSON.parse(JSON.stringify(message));
  const returned = listener(wireMessage, sender, (value) => { response = value; });
  return { returned, readResponse: async () => {
    for (let i = 0; i < 20 && response === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return response;
  } };
}

test("Service Worker 不暴露需要 activeTab 临时授权的截图消息", async () => {
  const loaded = await loadWorker();
  try {
    const request = invoke(
      loaded.runtimeListener,
      { type: "CAPTURE_VISIBLE_TAB" },
      { tab: { id: 17, windowId: 23, url: "https://zxfw.court.gov.cn/zxfw/#/pagesWsla/pc/list/index" } },
    );
    assert.equal(request.returned, false);
    assert.deepEqual(await request.readResponse(), {
      type: "ERROR",
      payload: { code: "UNKNOWN_TYPE", type: "CAPTURE_VISIBLE_TAB" },
    });
  } finally {
    loaded.cleanup();
  }
});

test("已授权 Worker 冷启动无需 onStartup 事件也会领取待执行命令", async () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000501",
    type: "EXPORT_REPORT",
    platformAccountId: "00000000-0000-4000-8000-000000000502",
  };
  let resultBody;
  const loaded = await loadWorker({
    storageData: {
      serverUrl: "http://127.0.0.1:3000",
      token: "opaque-device-token",
      expiresAt: Date.now() + 60_000,
      browserCommandDeviceId: "00000000-0000-4000-8000-000000000001",
    },
    tabs: [],
    fetchImpl: async (url, init = {}) => {
      const value = String(url);
      if (value.endsWith("/health")) return makeResponse({ ok: true });
      if (value.endsWith("/platform-accounts")) return makeResponse({ platformAccounts: [] });
      if (value.includes("/sync/changes")) return makeResponse({ cases: [], nextCursor: 0 });
      if (value.endsWith("/browser-commands/next")) return makeResponse({ command });
      if (value.endsWith(`/browser-commands/${command.id}/claim`)) {
        return makeResponse({ command, claimToken: "claim-once" });
      }
      if (value.endsWith(`/browser-commands/${command.id}/result`)) {
        resultBody = JSON.parse(init.body);
        return makeResponse({ command: { status: "failed" } });
      }
      throw new Error(`unexpected url: ${value}`);
    },
  });
  try {
    await waitFor(() => loaded.fetches.some(({ url }) => String(url).endsWith(`/browser-commands/${command.id}/result`)));
    assert.ok(loaded.alarmCreates.some(({ name, options }) => (
      name === "browser-command-poll" && options?.periodInMinutes === 1
    )));
    assert.ok(loaded.fetches.some(({ url }) => String(url).endsWith("/browser-commands/next")));
    assert.ok(loaded.fetches.some(({ url }) => String(url).endsWith(`/browser-commands/${command.id}/claim`)));
    assert.deepEqual(resultBody, {
      deviceId: "00000000-0000-4000-8000-000000000001",
      claimToken: "claim-once",
      status: "failed",
      resultCode: "NO_COURT_TAB",
      resultSummary: "任务执行失败",
      progress: null,
    });
  } finally {
    loaded.cleanup();
  }
});

test("未配对的 Worker 冷启动不得请求后台命令", async () => {
  const loaded = await loadWorker();
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(loaded.fetches.length, 0);
  } finally {
    loaded.cleanup();
  }
});

test("Options/Setup 配对状态请求会从持久化的设备授权状态恢复", async () => {
  const loaded = await loadWorker({
    storageData: {
      serverUrl: "http://127.0.0.1:3000",
      token: "opaque-device-token",
      expiresAt: Date.now() + 60_000,
      extensionDeviceId: "6b520a09-87bc-4adb-bacd-4b4f7c5ab4d1",
    },
  });
  try {
    const request = invoke(loaded.runtimeListener, { type: "EXTENSION_PAIRING_STATUS_REQUEST" });
    assert.equal(request.returned, true);
    const status = await request.readResponse();
    assert.equal(status.ok, true);
    assert.equal(status.status, "authorized");
  } finally {
    loaded.cleanup();
  }
});

test("EXPORT_UPLOAD 未配置服务器时返回 NOT_CONFIGURED", async () => {
  const loaded = await loadWorker();
  try {
    const request = invoke(loaded.runtimeListener, {
      type: "EXPORT_UPLOAD",
      fileName: "report.xlsx",
      sha256: "a".repeat(64),
      base64: Buffer.from("xlsx").toString("base64"),
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(request.returned, true);
    assert.deepEqual(await request.readResponse(), { ok: false, code: "NOT_CONFIGURED" });
    assert.equal(loaded.fetches.length, 0);
  } finally {
    loaded.cleanup();
  }
});

test("EXPORT_UPLOAD 懒初始化：启动未配置，后置写入配置可上传，清除配置后返回 NOT_CONFIGURED", async () => {
  const loaded = await loadWorker({
    storageData: {},
    fetchImpl: async (url) => {
      if (url.endsWith("/health")) return makeResponse({ ok: true });
      if (url.includes("/platform-accounts")) return makeResponse({ platformAccounts: [] });
      if (url.includes("/sync/changes")) return makeResponse({ cases: [], nextCursor: 0 });
      if (url.endsWith("/report-exports")) {
        return makeResponse({
          id: "post-config-export",
          fileName: "report.xlsx",
          byteSize: 4,
          sha256: "a".repeat(64),
          createdAt: "2026-08-06T00:00:00.000Z",
          created: true,
        }, 201);
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });
  try {
    await loaded.worker.syncInitialization;
    assert.equal(loaded.worker.getSyncCoordinator(), null);

    loaded.notifyStorageChange({
      syncServerUrl: { oldValue: undefined, newValue: "https://sync.example.test" },
      syncDeviceToken: { oldValue: undefined, newValue: "opaque-device-token" },
    });
    await loaded.worker.syncInitialization;
    assert.ok(loaded.worker.getSyncCoordinator());

    const uploaded = invoke(loaded.runtimeListener, {
      type: "EXPORT_UPLOAD",
      fileName: "report.xlsx",
      sha256: "a".repeat(64),
      base64: Buffer.from("xlsx").toString("base64"),
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.deepEqual(await uploaded.readResponse(), {
      ok: true,
      exportId: "post-config-export",
      fileName: "report.xlsx",
      byteSize: 4,
      createdAt: "2026-08-06T00:00:00.000Z",
    });

    loaded.notifyStorageChange({
      syncServerUrl: { oldValue: "https://sync.example.test", newValue: undefined },
      syncDeviceToken: { oldValue: "opaque-device-token", newValue: undefined },
    });
    await loaded.worker.syncInitialization;
    assert.equal(loaded.worker.getSyncCoordinator(), null);
    const notConfigured = invoke(loaded.runtimeListener, {
      type: "EXPORT_UPLOAD",
      fileName: "report.xlsx",
      sha256: "a".repeat(64),
      base64: Buffer.from("xlsx").toString("base64"),
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.deepEqual(await notConfigured.readResponse(), { ok: false, code: "NOT_CONFIGURED" });
  } finally {
    loaded.cleanup();
  }
});

test("EXPORT_UPLOAD 已配置时调用远端客户端并返回导出元数据", async () => {
  let reportStatus = 201;
  const loaded = await loadWorker({
    storageData: {
      syncServerUrl: "https://sync.example.test",
      syncDeviceToken: "opaque-device-token",
    },
    fetchImpl: async (url) => {
      if (url.endsWith("/health")) return makeResponse({ ok: true });
      if (url.includes("/platform-accounts")) return makeResponse({ platformAccounts: [] });
      if (url.includes("/sync/changes")) return makeResponse({ cases: [], nextCursor: 0 });
      if (url.endsWith("/report-exports")) {
        if (reportStatus === 503) {
          return makeResponse({ error: { code: "DEPENDENCY_UNAVAILABLE" } }, reportStatus);
        }
        return makeResponse({
          id: "export-1",
          fileName: "report.xlsx",
          byteSize: 4,
          sha256: "a".repeat(64),
          createdAt: "2026-08-06T00:00:00.000Z",
          created: true,
        }, 201);
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });
  try {
    await loaded.worker.syncInitialization;
    const request = invoke(loaded.runtimeListener, {
      type: "EXPORT_UPLOAD",
      fileName: "report.xlsx",
      sha256: "a".repeat(64),
      base64: Buffer.from("xlsx").toString("base64"),
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(request.returned, true);
    assert.deepEqual(await request.readResponse(), {
      ok: true,
      exportId: "export-1",
      fileName: "report.xlsx",
      byteSize: 4,
      createdAt: "2026-08-06T00:00:00.000Z",
    });
    const upload = loaded.fetches.find(({ url }) => url.endsWith("/report-exports"));
    assert.ok(upload);
    assert.equal(upload.init.headers.Authorization, "Bearer opaque-device-token");
    assert.equal(upload.init.body.get("sha256"), "a".repeat(64));
    assert.equal(upload.init.body.get("file").name, "report.xlsx");
    assert.equal(upload.init.body.get("file").type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.deepEqual(
      new Uint8Array(await upload.init.body.get("file").arrayBuffer()),
      Uint8Array.from([120, 108, 115, 120]),
    );

    reportStatus = 503;
    const failed = invoke(loaded.runtimeListener, {
      type: "EXPORT_UPLOAD",
      fileName: "report.xlsx",
      sha256: "a".repeat(64),
      base64: Buffer.from("xlsx").toString("base64"),
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.deepEqual(await failed.readResponse(), { ok: false, code: "DEPENDENCY_UNAVAILABLE" });
  } finally {
    loaded.cleanup();
  }
});
