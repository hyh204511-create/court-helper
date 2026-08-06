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

async function loadWorker({ storageData = {}, fetchImpl = async () => makeResponse({}) } = {}) {
  const runtimeListeners = [];
  const storageListeners = [];
  const fetches = [];
  const previous = {
    self: globalThis.self,
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
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
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
      sendMessage() {},
    },
    storage: {
      local: { get: async () => storageData },
      onChanged: { addListener(listener) { storageListeners.push(listener); } },
    },
  };

  try {
    const worker = await import(`../extension/service-worker.js?export-upload-test=${importSequence++}`);
    return { worker, runtimeListener: runtimeListeners.at(-1), fetches, storageData, notifyStorageChange(changes) {
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
    } };
  } catch (error) {
    if (previous.self === undefined) delete globalThis.self;
    else globalThis.self = previous.self;
    if (previous.chrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous.chrome;
    if (previous.fetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous.fetch;
    throw error;
  }
}

function invoke(listener, message) {
  let response;
  const wireMessage = JSON.parse(JSON.stringify(message));
  const returned = listener(wireMessage, {}, (value) => { response = value; });
  return { returned, readResponse: async () => {
    for (let i = 0; i < 20 && response === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return response;
  } };
}

test("popup 配对状态请求会从持久化的设备授权状态恢复", async () => {
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
