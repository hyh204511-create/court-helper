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
  sessionData = {},
  fetchImpl = async () => makeResponse({}),
  tabs = [],
  captureVisibleTab = async () => "data:image/jpeg;base64,",
} = {}) {
  const runtimeListeners = [];
  const storageListeners = [];
  const tabCreatedListeners = [];
  const tabUpdatedListeners = [];
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
      session: {
        get: async (key) => (typeof key === "string" ? { [key]: sessionData[key] } : { ...sessionData }),
        set: async (values) => Object.assign(sessionData, values),
        remove: async (keys) => {
          for (const key of (Array.isArray(keys) ? keys : [keys])) delete sessionData[key];
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
      onCreated: { addListener(listener) { tabCreatedListeners.push(listener); } },
      onUpdated: { addListener(listener) { tabUpdatedListeners.push(listener); } },
      sendMessage: async () => ({ ok: true }),
      captureVisibleTab,
    },
  };

  try {
    const worker = await import(`../extension/service-worker.js?export-upload-test=${importSequence++}`);
    return { worker, runtimeListener: runtimeListeners.at(-1), fetches, alarmCreates, intervals, storageData, sessionData, tabCreatedListeners, tabUpdatedListeners, notifyStorageChange(changes) {
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

test("案件空间待办由 Worker 桥接 session storage，且只接受法院标签页", async () => {
  const loaded = await loadWorker();
  const courtSender = { tab: { id: 17, url: "https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/pc/list/index" } };
  try {
    const opened = invoke(loaded.runtimeListener, { type: "CASE_SPACE_OPEN", uid: "synthetic-uid", kind: "qz" }, courtSender);
    assert.equal(opened.returned, true);
    assert.deepEqual(await opened.readResponse(), { ok: true, phase: "opening", tabId: 17 });
    assert.deepEqual(loaded.sessionData.pendingDetail, { uid: "synthetic-uid", kind: "qz" });

    const read = invoke(loaded.runtimeListener, { type: "CASE_DETAIL_PENDING_GET" }, courtSender);
    assert.equal(read.returned, true);
    assert.deepEqual(await read.readResponse(), {
      ok: true,
      pendingDetail: { uid: "synthetic-uid", kind: "qz" },
      handoff: { uid: "synthetic-uid", kind: "qz", phase: "opening" },
    });

    const adopted = invoke(
      loaded.runtimeListener,
      { type: "CASE_SPACE_ADOPTED", uid: "synthetic-uid", kind: "qz" },
      { tab: { id: 18, url: "https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/common/wsla/detail/index" } },
    );
    assert.deepEqual(await adopted.readResponse(), { ok: true, phase: "adopted", tabId: 18 });
    const adoptedRead = invoke(loaded.runtimeListener, { type: "CASE_DETAIL_PENDING_GET" }, courtSender);
    assert.deepEqual(await adoptedRead.readResponse(), {
      ok: true,
      pendingDetail: { uid: "synthetic-uid", kind: "qz" },
      handoff: { uid: "synthetic-uid", kind: "qz", phase: "adopted" },
    });

    const cleared = invoke(loaded.runtimeListener, { type: "CASE_DETAIL_PENDING_CLEAR" }, courtSender);
    assert.equal(cleared.returned, true);
    assert.deepEqual(await cleared.readResponse(), { ok: true });
    assert.equal(loaded.sessionData.pendingDetail, undefined);

    const rejected = invoke(
      loaded.runtimeListener,
      { type: "CASE_DETAIL_PENDING_GET" },
      { tab: { id: 18, url: "https://example.invalid/" } },
    );
    assert.deepEqual(await rejected.readResponse(), { ok: false, code: "UNTRUSTED_SENDER" });
  } finally {
    loaded.cleanup();
  }
});

test("案件空间原标签导航到详情页时 Worker 自动确认接管", async () => {
  const loaded = await loadWorker({ tabs: [{ id: 17, url: "https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/pc/list/index" }] });
  try {
    const opened = invoke(loaded.runtimeListener, { type: "CASE_SPACE_OPEN", uid: "synthetic-nav", kind: "li" }, { tab: { id: 17, url: "https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/pc/list/index" } });
    assert.deepEqual(await opened.readResponse(), { ok: true, phase: "opening", tabId: 17 });
    await loaded.tabUpdatedListeners[0](17, { url: "https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/common/wsla/detail/index" }, { id: 17, url: "https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/common/wsla/detail/index" });
    const read = invoke(loaded.runtimeListener, { type: "CASE_DETAIL_PENDING_GET" }, { tab: { id: 17, url: "https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/common/wsla/detail/index" } });
    assert.equal((await read.readResponse()).handoff.phase, "adopted");
  } finally {
    loaded.cleanup();
  }
});

test("案件空间新标签创建时已携带详情 URL 也由 Worker 自动确认接管", async () => {
  const loaded = await loadWorker({ tabs: [{ id: 17, url: "https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/pc/list/index" }] });
  try {
    const opened = invoke(loaded.runtimeListener, { type: "CASE_SPACE_OPEN", uid: "synthetic-created", kind: "li" }, { tab: { id: 17, url: "https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/pc/list/index" } });
    assert.deepEqual(await opened.readResponse(), { ok: true, phase: "opening", tabId: 17 });
    await loaded.tabCreatedListeners[0]({
      id: 19,
      url: "",
      pendingUrl: "https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/common/wsla/detail/index?synthetic=1",
    });
    const read = invoke(loaded.runtimeListener, { type: "CASE_DETAIL_PENDING_GET" }, { tab: { id: 17, url: "https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/pc/list/index" } });
    assert.deepEqual((await read.readResponse()).handoff, { uid: "synthetic-created", kind: "li", phase: "adopted" });
  } finally {
    loaded.cleanup();
  }
});

test("案件空间复用点击前已有详情标签且 URL 更新时 Worker 自动确认接管", async () => {
  const loaded = await loadWorker({ tabs: [
    { id: 17, url: "https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/pc/list/index" },
    { id: 18, url: "https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/common/wsla/detail/index?old=1" },
  ] });
  try {
    const opened = invoke(loaded.runtimeListener, { type: "CASE_SPACE_OPEN", uid: "synthetic-reuse", kind: "qz" }, { tab: { id: 17, url: "https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/pc/list/index" } });
    assert.deepEqual(await opened.readResponse(), { ok: true, phase: "opening", tabId: 17 });
    await loaded.tabUpdatedListeners[0](18, { url: "https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/common/wsla/detail/index?current=1" }, { id: 18, url: "https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/common/wsla/detail/index?current=1" });
    const read = invoke(loaded.runtimeListener, { type: "CASE_DETAIL_PENDING_GET" }, { tab: { id: 17, url: "https://zxfw.court.gov.cn/zxfw/index.html#/pagesWsla/pc/list/index" } });
    assert.deepEqual((await read.readResponse()).handoff, { uid: "synthetic-reuse", kind: "qz", phase: "adopted" });
  } finally {
    loaded.cleanup();
  }
});

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
      platformAccountId: "00000000-0000-0000-0000-000000000010",
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
      platformAccountId: "00000000-0000-0000-0000-000000000010",
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
    assert.equal(upload.init.body.get("platformAccountId"), "00000000-0000-0000-0000-000000000010");
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
