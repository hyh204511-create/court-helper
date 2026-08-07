import assert from "node:assert/strict";
import { test } from "node:test";

import { persistSyncRecord, runBatch } from "../extension/data/batch-runner.js";

/** 页面操作器 mock：记录调用并返回预设结果 */
function makePageOps({ queryResults = {}, captureResult = "img-jpeg", failTimes = {} } = {}) {
  const calls = [];
  return {
    calls,
    async queryCase({ uid, kind }) {
      calls.push(["query", uid, kind]);
      const fail = (failTimes[uid] ?? 0) > 0;
      if (fail) {
        failTimes[uid] -= 1;
        throw new Error("QUERY_TIMEOUT");
      }
      return queryResults[uid] ?? { statusText: "待审核", caseType: "民事一审案件", fields: [] };
    },
    async capture() {
      calls.push(["capture"]);
      return captureResult;
    },
  };
}

const sleep0 = () => Promise.resolve();

test("批量执行：成功案件 → 状态识别 + 截图 + 进度回调", async () => {
  const updated = [];
  const ops = makePageOps({
    queryResults: {
      c1: { statusText: "已立案", caseType: "民事一审案件", caseNumber: "（2026）京0000民初1号", filedTime: "2026-07-22" },
    },
  });
  const stats = await runBatch({
    cases: [{ uid: "c1", account: "A", kind: "li" }],
    pageOps: ops,
    onUpdate: (r) => updated.push(r),
    timing: { delay: sleep0 },
  });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].status, "立案成功");
  assert.equal(updated[0].caseNumber, "（2026）京0000民初1号");
  assert.equal(updated[0].filedTime, "2026-07-22");
  assert.equal(updated[0].image, "img-jpeg");
  assert.equal(updated[0].needsHuman, false);
  assert.equal(stats.total, 1);
  assert.equal(stats.success, 1);
  assert.equal(stats.unknown, 0);
});

test("批量执行：强执案件类型 → 强执成功", async () => {
  const updated = [];
  const ops = makePageOps({
    queryResults: {
      e1: { statusText: "已立案", caseType: "首次执行案件", caseNumber: "（2026）京0000执1号", filedTime: "2026-06-03" },
    },
  });
  await runBatch({ cases: [{ uid: "e1", account: "B", kind: "qz" }], pageOps: ops, onUpdate: (r) => updated.push(r), timing: { delay: sleep0 } });
  assert.equal(updated[0].status, "强执成功");
  assert.equal(updated[0].caseNumber, "（2026）京0000执1号");
  assert.equal(updated[0].filedTime, "2026-06-03");
  assert.equal(updated[0].kind, "qz");
});

test("未知状态 → UNKNOWN + needsHuman，不写状态词", async () => {
  const updated = [];
  const ops = makePageOps({ queryResults: { c2: { statusText: "撤回中", caseType: "民事一审案件" } } });
  await runBatch({ cases: [{ uid: "c2", kind: "li" }], pageOps: ops, onUpdate: (r) => updated.push(r), timing: { delay: sleep0 } });
  assert.equal(updated[0].status, "UNKNOWN");
  assert.equal(updated[0].needsHuman, true);
});

test("驳回结果沿 rejectImage 传播并保留时间和原因", async () => {
  const updated = [];
  const rejectImage = new Blob(["synthetic-reject-image"], { type: "image/jpeg" });
  const ops = makePageOps({
    queryResults: {
      rejected: {
        statusText: "审核不通过",
        caseType: "民事一审案件",
        pageKind: "wsla",
        rejectTime: "2026-08-07",
        rejectReason: "脱敏驳回原因",
        rejectImage,
      },
    },
  });
  await runBatch({
    cases: [{ uid: "rejected", account: "A", kind: "li" }],
    pageOps: ops,
    onUpdate: (record) => updated.push(record),
    timing: { delay: sleep0 },
  });
  assert.equal(updated[0].status, "已驳回");
  assert.equal(updated[0].rejectTime, "2026-08-07");
  assert.equal(updated[0].rejectReason, "脱敏驳回原因");
  assert.equal(updated[0].rejectImage, rejectImage);
  assert.equal(updated[0].successImage, null);
  assert.equal(updated[0].needsHuman, false);
});

test("驳回截图失败只标待人工，不清空已确认文字事实", async () => {
  const updated = [];
  const ops = makePageOps({
    captureResult: null,
    queryResults: {
      rejected: {
        statusText: "审核不通过",
        caseType: "民事一审案件",
        pageKind: "wsla",
        rejectTime: "2026-08-07",
        rejectReason: "脱敏驳回原因",
      },
    },
  });
  await runBatch({
    cases: [{ uid: "rejected", account: "A", kind: "li" }],
    pageOps: ops,
    onUpdate: (record) => updated.push(record),
    timing: { delay: sleep0 },
  });
  assert.equal(updated[0].status, "已驳回");
  assert.equal(updated[0].rejectTime, "2026-08-07");
  assert.equal(updated[0].rejectReason, "脱敏驳回原因");
  assert.equal(updated[0].rejectImage, null);
  assert.equal(updated[0].needsHuman, true);
  assert.equal(updated[0].error, "SCREENSHOT_CAPTURE_FAILED");
});

test("失败重试：第 1 次失败 → 重试成功；持续失败 → UNKNOWN 待人工", async () => {
  const updated = [];
  const ops = makePageOps({
    failTimes: { c3: 1, c4: 99 },
    queryResults: { c3: { statusText: "待审核", caseType: "民事一审案件" } },
  });
  await runBatch({ cases: [{ uid: "c3" }, { uid: "c4" }], pageOps: ops, onUpdate: (r) => updated.push(r), timing: { delay: sleep0 } });
  const byUid = Object.fromEntries(updated.map((r) => [r.uid, r]));
  assert.equal(byUid.c3.status, "审核中"); // 重试成功
  assert.equal(byUid.c3.needsHuman, false);
  assert.equal(byUid.c4.status, "UNKNOWN"); // 重试仍失败
  assert.equal(byUid.c4.needsHuman, true);
  assert.ok(byUid.c4.error);
  // c3 调用了 2 次（1 失败 + 1 成功），c4 调用 2 次
  const qCalls = ops.calls.filter((c) => c[0] === "query");
  assert.equal(qCalls.filter((c) => c[1] === "c3").length, 2);
  assert.equal(qCalls.filter((c) => c[1] === "c4").length, 2);
});

test("单批上限 50：51 条只处理前 50", async () => {
  const cases = Array.from({ length: 51 }, (_, i) => ({ uid: `c${i}` }));
  const updated = [];
  const ops = makePageOps();
  const stats = await runBatch({ cases, pageOps: ops, onUpdate: (r) => updated.push(r), timing: { delay: sleep0 } });
  assert.equal(updated.length, 50);
  assert.equal(stats.total, 50);
});

test("空案件列表 → 空统计不报错", async () => {
  const stats = await runBatch({ cases: [], pageOps: makePageOps(), timing: { delay: sleep0 } });
  assert.deepEqual(stats, { total: 0, success: 0, unknown: 0, needsHuman: 0 });
});

test("syncing an evidence update preserves the original client UID", async () => {
  const records = new Map();
  const uid = "platform-account-id\u0000plaintiff\u0000defendant";
  records.set(uid, {
    uid,
    account: "masked-platform-account",
    platformAccountId: "platform-account-id",
    plaintiff: "synthetic plaintiff",
    defendant: "synthetic defendant",
    kind: "li",
    status: "立案成功",
    caseNumber: null,
  });
  const db = {
    STORE_CASES: "cases",
    STORE_ENFORCEMENT: "enforcementCases",
    async getByUid(_store, key) { return records.get(key); },
    async upsertByUid(_store, key, value) { records.set(key, { ...value, uid: key, updatedAt: 1 }); return records.get(key); },
  };
  const outbox = { async enqueue() {} };

  await persistSyncRecord({
    ...records.get(uid),
    uid,
    caseNumber: "SYNTHETIC-LI-001",
    filedTime: "2026-08-07",
  }, { db, outbox });

  assert.equal(records.size, 1);
  assert.equal(records.get(uid).caseNumber, "SYNTHETIC-LI-001");
});

test("查询失败同步不得用 UNKNOWN/null 覆盖既有驳回证据", async () => {
  const uid = "stable-reject-evidence";
  const rejectImage = new Blob(["synthetic-reject-image"], { type: "image/jpeg" });
  let stored = {
    uid,
    account: "masked-account",
    platformAccountId: "platform-account-id",
    kind: "li",
    plaintiff: "synthetic plaintiff",
    defendant: "synthetic defendant",
    status: "已驳回",
    rejectTime: "2026-08-07",
    rejectReason: "脱敏驳回原因",
    rejectImage,
  };
  let event;
  const db = {
    STORE_CASES: "cases",
    STORE_ENFORCEMENT: "enforcementCases",
    async getByUid() { return stored; },
    async upsertByUid(_store, _uid, value) {
      stored = { ...value, uid, updatedAt: 1 };
      return stored;
    },
  };
  const outbox = { async enqueue(value) { event = value; } };

  await persistSyncRecord({
    uid,
    kind: "li",
    account: "masked-account",
    platformAccountId: "platform-account-id",
    status: "UNKNOWN",
    rejectTime: null,
    rejectReason: null,
    queryTime: "2026-08-07",
    needsHuman: true,
    error: "QUERY_TIMEOUT",
  }, { db, outbox });

  assert.equal(stored.status, "已驳回");
  assert.equal(stored.rejectTime, "2026-08-07");
  assert.equal(stored.rejectReason, "脱敏驳回原因");
  assert.equal(stored.rejectImage, rejectImage);
  assert.equal(stored.needsHuman, true);
  assert.equal(event.payload.status, "已驳回");
  assert.equal(event.payload.rejectReason, "脱敏驳回原因");
});
