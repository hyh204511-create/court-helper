import "fake-indexeddb/auto";

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";

import { createRemoteClient } from "../extension/data/remote-client.js";
import {
  SYNC_META_ACCOUNTS,
  SYNC_META_CURSOR,
  createSyncCoordinator,
} from "../extension/data/sync-coordinator.js";
import {
  STORE_CASES,
  getByUid,
  getSyncMeta,
  resetDb,
} from "../extension/data/db.js";
import { enqueue, getOutbox, pendingCount } from "../extension/data/outbox.js";
import { handleMessage } from "../extension/shared/message-router.js";
import { createCourtPanel } from "../extension/content/court-panel.js";
import { runBatch } from "../extension/data/batch-runner.js";

beforeEach(async () => {
  await resetDb();
});

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
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
    async runNext() {
      const [id, timer] = timers.entries().next().value ?? [];
      if (!timer) return;
      timers.delete(id);
      await timer.callback();
    },
  };
}

function makeClient(fetchImpl) {
  return createRemoteClient({
    baseUrl: "https://sync.example.test",
    token: "opaque-token",
    fetchImpl,
  });
}

function makeDocument() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://zxfw.court.gov.cn/zxfw/#/pagesWsla/pc/list/index",
  });
  Object.defineProperty(dom.window.document, "hidden", { configurable: true, value: false });
  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "visible" });
  return dom;
}

test("同步协调器持久化 pull cursor，并缓存脱敏的平台账号元数据", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith("/health")) return jsonResponse({ ok: true });
    if (url.includes("/platform-accounts")) {
      return jsonResponse({
        platformAccounts: [{
          id: "platform-1",
          label: "账号甲",
          enabled: true,
          updatedAt: "2026-08-05T00:00:00.000Z",
          account: "must-not-cache",
          password: "must-not-cache",
        }],
      });
    }
    if (url.includes("/sync/changes")) {
      return jsonResponse({
        cases: [{
          clientUid: "uid-1",
          platformAccountId: "platform-1",
          kind: "li",
          plaintiff: "脱敏原告",
          defendant: "脱敏被告",
          status: "审核中",
          filedTime: null,
          caseNumber: "case-1",
          rejectTime: null,
          rejectReason: null,
          queryTime: "2026-08-05T00:00:00.000Z",
          needsHuman: false,
          errorCode: null,
          sourceUpdatedAt: "2026-08-05T00:00:00.000Z",
          revision: 7,
        }],
        nextCursor: 7,
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const coordinator = createSyncCoordinator({
    client: makeClient(fetchImpl),
    document: makeDocument().window.document,
  });

  const result = await coordinator.syncNow();

  assert.equal(result.status, "online");
  assert.equal(await getSyncMeta(SYNC_META_CURSOR), 7);
  assert.equal((await getByUid(STORE_CASES, "uid-1")).status, "审核中");
  assert.deepEqual(await getSyncMeta(SYNC_META_ACCOUNTS), [{
    id: "platform-1",
    label: "账号甲",
    enabled: true,
    updatedAt: "2026-08-05T00:00:00.000Z",
  }]);
  assert.equal(JSON.stringify(await getSyncMeta(SYNC_META_ACCOUNTS)).includes("must-not-cache"), false);

  const refreshA = coordinator.refreshAccounts({ force: true });
  const refreshB = coordinator.refreshAccounts({ force: true });
  assert.equal(refreshA, refreshB);
  await refreshA;

  const second = createSyncCoordinator({
    client: makeClient(async (url) => {
      requests.push(url);
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      if (url.includes("/sync/changes")) return jsonResponse({ cases: [], nextCursor: 7 });
      throw new Error(`unexpected second request: ${url}`);
    }),
    document: makeDocument().window.document,
  });
  await second.syncNow();
  assert.ok(requests.some((url) => url.includes("/sync/changes?after=7&limit=200")));
});

test("前台轮询使用 3 秒间隔，页面隐藏时退避，入口重复调用不产生并发轮询", async () => {
  const scheduler = makeScheduler();
  let changes = 0;
  const client = makeClient(async (url) => {
    if (url.endsWith("/health")) return jsonResponse({ ok: true });
    if (url.includes("/sync/changes")) {
      changes += 1;
      return jsonResponse({ cases: [], nextCursor: changes });
    }
    if (url.includes("/platform-accounts")) return jsonResponse({ platformAccounts: [] });
    throw new Error(`unexpected request: ${url}`);
  });
  const dom = makeDocument();
  const coordinator = createSyncCoordinator({
    client,
    document: dom.window.document,
    scheduler,
    pollIntervalMs: 3000,
    hiddenPollIntervalMs: 9000,
  });

  coordinator.start({ immediate: false });
  coordinator.start({ immediate: false });
  assert.deepEqual(scheduler.pending().map((timer) => timer.delay), [3000]);
  await scheduler.runNext();
  assert.equal(changes, 1);
  assert.deepEqual(scheduler.pending().map((timer) => timer.delay), [3000]);

  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "hidden" });
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  assert.deepEqual(scheduler.pending().map((timer) => timer.delay), [9000]);
  coordinator.stop();
  assert.deepEqual(scheduler.pending(), []);
});

test("409 冲突转为 needs_human，并在同步状态中列出", async () => {
  const event = await enqueue({
    id: "outbox-conflict",
    type: "case.sync",
    clientMutationId: "mutation-conflict",
    payload: {
      clientUid: "uid-conflict",
      platformAccountId: "platform-1",
      kind: "li",
      status: "审核中",
      sourceUpdatedAt: "2026-08-05T00:00:00.000Z",
    },
  });
  const coordinator = createSyncCoordinator({
    client: makeClient(async (url) => {
      if (url.endsWith("/health")) return jsonResponse({ ok: true });
      if (url.includes("/platform-accounts")) return jsonResponse({ platformAccounts: [] });
      if (url.includes("/sync/changes")) return jsonResponse({ cases: [], nextCursor: 0 });
      if (url.includes("/sync/cases")) {
        return jsonResponse({
          error: {
            code: "CONFLICT",
            message: "safe conflict",
            retryable: false,
            details: [{ clientUid: "uid-conflict", eventId: "mutation-conflict", code: "CONFLICT" }],
          },
        }, { status: 409 });
      }
      throw new Error(`unexpected request: ${url}`);
    }),
  });

  const result = await coordinator.syncNow();
  const stored = await getOutbox(event.id);

  assert.equal(result.status, "online");
  assert.equal(stored.status, "needs_human");
  assert.deepEqual(stored.conflicts, [{
    clientUid: "uid-conflict",
    eventId: "mutation-conflict",
    code: "CONFLICT",
  }]);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].id, event.id);
});

test("服务器不可达暂停批量且保留 outbox；重试恢复后自动续跑", async () => {
  let online = false;
  const paused = [];
  const resumed = [];
  await enqueue({
    id: "outbox-retry",
    type: "case.sync",
    payload: { clientUid: "uid-retry", platformAccountId: "platform-1", kind: "li", status: "审核中" },
  });
  const coordinator = createSyncCoordinator({
    client: makeClient(async (url) => {
      if (url.endsWith("/health")) {
        if (!online) throw new Error("network down");
        return jsonResponse({ ok: true });
      }
      if (url.includes("/platform-accounts")) return jsonResponse({ platformAccounts: [] });
      if (url.includes("/sync/changes")) return jsonResponse({ cases: [], nextCursor: 0 });
      if (url.includes("/sync/cases")) return jsonResponse({ accepted: [], conflicts: [], cursor: 1 });
      throw new Error(`unexpected request: ${url}`);
    }),
    onPauseBatch: (reason) => paused.push(reason),
    onResumeBatch: (reason) => resumed.push(reason),
  });

  const unavailable = await coordinator.syncNow();
  assert.equal(unavailable.status, "offline");
  assert.equal(paused.length, 1);
  assert.equal(await pendingCount(), 1);

  online = true;
  const recovered = await coordinator.retry();
  assert.equal(recovered.status, "online");
  assert.equal(resumed.length, 1);
  assert.equal(await getOutbox("outbox-retry").then((item) => item.status), "sent");
});

test("不可达后的自动恢复探测失败一次后停止定时重试，等待人工重试", async () => {
  const scheduler = makeScheduler();
  let healthCalls = 0;
  const coordinator = createSyncCoordinator({
    client: makeClient(async (url) => {
      if (url.endsWith("/health")) {
        healthCalls += 1;
        throw new Error("network down");
      }
      throw new Error(`unexpected request: ${url}`);
    }),
    document: makeDocument().window.document,
    scheduler,
  });

  await coordinator.start();
  assert.deepEqual(scheduler.pending().map((timer) => timer.delay), [4000]);
  await scheduler.runNext();
  assert.equal(healthCalls, 2);
  assert.deepEqual(scheduler.pending(), []);
});

test("批量结果按本地 upsert → outbox enqueue → onUpdate 顺序处理", async () => {
  const calls = [];
  const db = {
    STORE_CASES: "cases",
    STORE_ENFORCEMENT: "enforcementCases",
    async getByUid() {
      calls.push("get");
      return null;
    },
    async upsert(storeName, record) {
      calls.push(["upsert", storeName]);
      return { ...record, updatedAt: Date.now() };
    },
  };
  const outbox = {
    async enqueue(event) {
      calls.push("enqueue");
      assert.equal(event.type, "case.sync");
      assert.equal(event.payload.password, undefined);
      assert.equal(event.payload.image, undefined);
      return event;
    },
  };

  await runBatch({
    cases: [{ uid: "uid-order", account: "masked-account", kind: "li" }],
    pageOps: {
      async queryCase() { return { statusText: "待审核", caseType: "民事一审案件" }; },
      async capture() { return null; },
    },
    persistence: { db, outbox },
    onUpdate: async () => { calls.push("onUpdate"); },
    timing: { delay: () => Promise.resolve() },
  });

  assert.deepEqual(calls, ["get", ["upsert", "cases"], "enqueue", "onUpdate"]);
});

test("SYNC_* 消息和面板同步区只展示白名单、脱敏账号与安全冲突摘要", () => {
  const response = handleMessage({
    type: "SYNC_STATUS",
    payload: {
      status: "offline",
      cursor: 7,
      pendingCount: 2,
      lastSyncAt: "2026-08-05T00:00:00.000Z",
      maskedAccount: "a***f",
      conflicts: [{ id: "outbox-1", code: "CONFLICT" }],
      password: "must-not-message",
      screenshot: new Blob(["secret-image"]),
    },
  });
  assert.equal(response.type, "SYNC_STATUS_ACK");
  assert.deepEqual(response.payload, {
    status: "offline",
    cursor: 7,
    pendingCount: 2,
    lastSyncAt: "2026-08-05T00:00:00.000Z",
    maskedAccount: "a***f",
    conflicts: [{ id: "outbox-1", code: "CONFLICT" }],
  });
  assert.equal(JSON.stringify(response).includes("must-not-message"), false);
  assert.equal(JSON.stringify(response).includes("secret-image"), false);

  const dom = makeDocument();
  let retries = 0;
  const panel = createCourtPanel({
    document: dom.window.document,
    shadowMode: "open",
    handlers: { onSyncRetry: () => { retries += 1; } },
  });
  panel.setSyncStatus(response.payload);
  const shadow = panel.host.shadowRoot;
  assert.ok(shadow.querySelector(".sync-pending").textContent.includes("2"));
  assert.ok(shadow.querySelector(".sync-last").textContent.includes("2026-08-05"));
  assert.ok(shadow.querySelector(".sync-conflicts").textContent.includes("CONFLICT"));
  assert.ok(shadow.querySelector(".sync-unavailable").textContent.includes("服务器不可达"));
  shadow.querySelector(".btn-sync-retry").click();
  assert.equal(retries, 1);
});
