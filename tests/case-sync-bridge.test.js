import test from "node:test";
import assert from "node:assert/strict";

import {
  CASE_SYNC_ENQUEUE,
  createCaseSyncBridge,
} from "../extension/sw/case-sync-bridge.js";
import { createRuntimeCaseOutbox } from "../extension/data/runtime-case-outbox.js";

function caseEvent(overrides = {}) {
  return {
    type: "case.sync",
    clientMutationId: "case-event-1",
    payload: {
      clientUid: "client-case-1",
      platformAccountId: "00000000-0000-0000-0000-000000000001",
      kind: "li",
      plaintiff: "synthetic plaintiff",
      defendant: "synthetic defendant",
      status: "审核中",
      filedTime: null,
      caseNumber: null,
      rejectTime: null,
      rejectReason: null,
      queryTime: "2026-08-09T01:02:03.000Z",
      needsHuman: false,
      errorCode: null,
      sourceUpdatedAt: "2026-08-09T01:02:03.000Z",
    },
    ...overrides,
  };
}

const courtSender = {
  tab: { url: "https://zxfw.court.gov.cn/#/pagesWsla/pc/list" },
};

test("case sync bridge waits for the server-backed outbox event to be acknowledged", async () => {
  const calls = [];
  let stored = null;
  const bridge = createCaseSyncBridge({
    ensureCoordinator: async () => ({
      async retry() {
        calls.push("retry-coordinator");
        stored = {
          ...stored,
          status: "sent",
          sentAt: Date.now(),
          receipt: { caseAccepted: true, screenshotStored: false },
        };
        return { status: "online" };
      },
    }),
    outbox: {
      async enqueue(input) {
        calls.push("enqueue");
        stored = { id: "outbox-1", status: "pending", ...input };
        return stored;
      },
      async retry(id) {
        calls.push(`retry-${id}`);
        stored = { ...stored, status: "pending", nextRetryAt: 0 };
        return stored;
      },
      async getOutbox() {
        calls.push("read-result");
        return stored;
      },
    },
  });

  const response = await bridge.handle({ type: CASE_SYNC_ENQUEUE, event: caseEvent() }, courtSender);

  assert.deepEqual(response, {
    ok: true,
    status: "sent",
    clientMutationId: "case-event-1",
    evidenceClosed: true,
  });
  assert.deepEqual(calls, ["enqueue", "retry-outbox-1", "retry-coordinator", "read-result"]);
  assert.equal(stored.blobRef, null);
});

test("case sync bridge rejects non-court senders and reports an unacknowledged write", async () => {
  let coordinatorCalls = 0;
  const bridge = createCaseSyncBridge({
    ensureCoordinator: async () => ({
      async retry() {
        coordinatorCalls += 1;
        return { status: "offline", errorCode: "REMOTE_UNAVAILABLE" };
      },
    }),
    outbox: {
      async enqueue(input) {
        return { id: "outbox-2", status: "pending", ...input };
      },
      async retry(eventId) {
        return { id: eventId, status: "pending" };
      },
      async getOutbox() {
        return { id: "outbox-2", status: "pending", lastErrorCode: "REMOTE_UNAVAILABLE" };
      },
    },
  });

  assert.deepEqual(
    await bridge.handle({ type: CASE_SYNC_ENQUEUE, event: caseEvent() }, { tab: { url: "https://example.test/" } }),
    { ok: false, code: "FORBIDDEN" },
  );
  assert.equal(coordinatorCalls, 0);

  assert.deepEqual(
    await bridge.handle({ type: CASE_SYNC_ENQUEUE, event: caseEvent() }, courtSender),
    { ok: false, code: "REMOTE_UNAVAILABLE", status: "pending" },
  );
});

test("case sync bridge replays legacy sent events without a durable receipt", async () => {
  const calls = [];
  let stored;
  const bridge = createCaseSyncBridge({
    ensureCoordinator: async () => ({
      async retry() {
        calls.push("coordinator-retry");
        stored = {
          ...stored,
          status: "sent",
          receipt: { caseAccepted: true, screenshotStored: false },
        };
      },
    }),
    outbox: {
      async enqueue(input) {
        stored = { id: "outbox-sent", status: "sent", ...input };
        return stored;
      },
      async retry(id) {
        calls.push(`retry-${id}`);
        stored = { ...stored, status: "pending", receipt: null };
      },
      async getOutbox() {
        calls.push("read-result");
        return stored;
      },
    },
  });

  assert.deepEqual(
    await bridge.handle({ type: CASE_SYNC_ENQUEUE, event: caseEvent() }, courtSender),
    { ok: true, status: "sent", clientMutationId: "case-event-1", evidenceClosed: true },
  );
  assert.deepEqual(calls, ["retry-outbox-sent", "coordinator-retry", "read-result"]);
});

test("case sync bridge refuses a terminal sent receipt without screenshot acknowledgement", async () => {
  let stored;
  const bridge = createCaseSyncBridge({
    ensureCoordinator: async () => ({ async retry() {} }),
    outbox: {
      async enqueue(input) {
        stored = {
          id: "outbox-terminal-incomplete",
          status: "sent",
          receipt: { caseAccepted: true, screenshotStored: false },
          ...input,
        };
        return stored;
      },
      async retry() { stored = { ...stored, status: "pending" }; },
      async getOutbox() {
        return {
          ...stored,
          status: "sent",
          receipt: { caseAccepted: true, screenshotStored: false },
        };
      },
    },
    db: {
      STORE_CASES: "cases",
      STORE_ENFORCEMENT: "enforcementCases",
      async getByUid() { return null; },
      async upsertByUid(_storeName, _uid, record) { return record; },
    },
  });
  const payload = { ...caseEvent().payload, status: "立案成功" };
  const response = await bridge.handle({
    type: CASE_SYNC_ENQUEUE,
    event: {
      ...caseEvent({ payload }),
      evidence: {
        field: "successImage",
        mimeType: "image/png",
        base64: Buffer.from("synthetic-terminal-image").toString("base64"),
      },
    },
  }, courtSender);

  assert.deepEqual(response, { ok: false, code: "EVIDENCE_NOT_CLOSED", status: "sent" });
});

test("case sync bridge restores terminal evidence in the worker database before syncing", async () => {
  for (const scenario of [
    { kind: "li", status: "立案成功", storeName: "cases", field: "successImage" },
    { kind: "qz", status: "强执成功", storeName: "enforcementCases", field: "successImage" },
    { kind: "li", status: "已驳回", storeName: "cases", field: "rejectImage" },
  ]) {
    let queued = null;
    let storedEvidence = null;
    const bridge = createCaseSyncBridge({
      ensureCoordinator: async () => ({
      async retry() {
          queued = {
            ...queued,
            status: "sent",
            receipt: { caseAccepted: true, screenshotStored: true },
          };
          return { status: "online" };
        },
      }),
      outbox: {
        async enqueue(input) {
          queued = { id: `outbox-${scenario.kind}-${scenario.field}`, status: "pending", ...input };
          return queued;
        },
        async retry() {},
        async getOutbox() { return queued; },
      },
      db: {
        STORE_CASES: "cases",
        STORE_ENFORCEMENT: "enforcementCases",
        async getByUid() { return null; },
        async upsertByUid(storeName, uid, record) {
          storedEvidence = { storeName, uid, record };
          return record;
        },
      },
    });
    const payload = { ...caseEvent().payload, kind: scenario.kind, status: scenario.status };
    const response = await bridge.handle({
      type: CASE_SYNC_ENQUEUE,
      event: {
        ...caseEvent({ payload }),
        evidence: {
          field: scenario.field,
          mimeType: "image/png",
          base64: Buffer.from(`synthetic-${scenario.status}`).toString("base64"),
        },
      },
    }, courtSender);

    assert.equal(response.ok, true, scenario.status);
    assert.equal(storedEvidence.storeName, scenario.storeName, scenario.status);
    assert.equal(storedEvidence.uid, "client-case-1", scenario.status);
    assert.equal(await storedEvidence.record[scenario.field].text(), `synthetic-${scenario.status}`);
    assert.deepEqual(queued.blobRef, {
      storeName: scenario.storeName,
      uid: "client-case-1",
      field: scenario.field,
    });
  }
});

test("case sync bridge still syncs terminal text when capture failed and no evidence exists", async () => {
  let queued = null;
  const bridge = createCaseSyncBridge({
    ensureCoordinator: async () => ({
      async retry() {
        queued = {
          ...queued,
          status: "sent",
          receipt: { caseAccepted: true, screenshotStored: false },
        };
        return { status: "online" };
      },
    }),
    outbox: {
      async enqueue(input) {
        queued = { id: "outbox-missing-evidence", status: "pending", ...input };
        return queued;
      },
      async retry() {},
      async getOutbox() { return queued; },
    },
  });

  const response = await bridge.handle({
    type: CASE_SYNC_ENQUEUE,
    event: caseEvent({
      payload: { ...caseEvent().payload, status: "立案成功", needsHuman: true, errorCode: "SCREENSHOT_CAPTURE_FAILED" },
    }),
  }, courtSender);

  assert.equal(response.ok, true);
  assert.equal(queued.payload.status, "立案成功");
  assert.equal(queued.blobRef, null);
});

test("runtime case outbox sends a serializable event and requires the database acknowledgement", async () => {
  const sent = [];
  const outbox = createRuntimeCaseOutbox({
    async sendMessage(message) {
      sent.push(message);
      return {
        ok: true,
        status: "sent",
        clientMutationId: message.event.clientMutationId,
        evidenceClosed: true,
      };
    },
  });

  const queued = await outbox.enqueue({
    ...caseEvent(),
  });

  assert.deepEqual(queued, {
    status: "sent",
    clientMutationId: "case-event-1",
    evidenceClosed: true,
  });
  assert.deepEqual(sent, [{
    type: CASE_SYNC_ENQUEUE,
    event: {
      type: "case.sync",
      clientMutationId: "case-event-1",
      payload: caseEvent().payload,
    },
  }]);

  const unavailable = createRuntimeCaseOutbox({
    async sendMessage() {
      return { ok: false, code: "REMOTE_UNAVAILABLE", status: "pending" };
    },
  });
  await assert.rejects(
    unavailable.enqueue(caseEvent()),
    (error) => error.code === "REMOTE_UNAVAILABLE" && error.message === "REMOTE_UNAVAILABLE",
  );
});

test("runtime case outbox transfers terminal success evidence without putting the Blob in the case payload", async () => {
  const successImage = new Blob(["synthetic-success-evidence"], { type: "image/png" });
  const sent = [];
  const outbox = createRuntimeCaseOutbox({
    async sendMessage(message) {
      sent.push(message);
      return {
        ok: true,
        status: "sent",
        clientMutationId: message.event.clientMutationId,
        evidenceClosed: true,
      };
    },
    db: {
      async getByUid(storeName, uid) {
        assert.equal(storeName, "cases");
        assert.equal(uid, "client-case-1");
        return { successImage };
      },
    },
  });

  await outbox.enqueue({
    ...caseEvent({ payload: { ...caseEvent().payload, status: "立案成功" } }),
    blobRef: { storeName: "cases", uid: "client-case-1", field: "successImage" },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].event.payload.successImage, undefined);
  assert.equal(sent[0].event.evidence.field, "successImage");
  assert.equal(sent[0].event.evidence.mimeType, "image/png");
  assert.equal(
    Buffer.from(sent[0].event.evidence.base64, "base64").toString(),
    "synthetic-success-evidence",
  );
});

test("runtime case outbox rejects oversized evidence before reading or messaging it", async () => {
  let reads = 0;
  let sends = 0;
  const outbox = createRuntimeCaseOutbox({
    async sendMessage() { sends += 1; },
    db: {
      async getByUid() {
        return {
          successImage: {
            type: "image/png",
            size: 10 * 1024 * 1024 + 1,
            async arrayBuffer() { reads += 1; return new ArrayBuffer(0); },
          },
        };
      },
    },
  });

  await assert.rejects(
    outbox.enqueue({
      ...caseEvent({ payload: { ...caseEvent().payload, status: "立案成功" } }),
      blobRef: { storeName: "cases", uid: "client-case-1", field: "successImage" },
    }),
    (error) => error.code === "SCREENSHOT_TOO_LARGE",
  );
  assert.equal(reads, 0);
  assert.equal(sends, 0);
});
