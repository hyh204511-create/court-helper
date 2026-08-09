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
        stored = { ...stored, status: "sent", sentAt: Date.now() };
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

  assert.deepEqual(response, { ok: true, status: "sent", clientMutationId: "case-event-1" });
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

test("case sync bridge returns existing sent events without writing them twice", async () => {
  let retries = 0;
  const bridge = createCaseSyncBridge({
    ensureCoordinator: async () => ({ async retry() { retries += 1; } }),
    outbox: {
      async enqueue(input) {
        return { id: "outbox-sent", status: "sent", ...input };
      },
      async retry() {
        retries += 1;
      },
      async getOutbox() {
        throw new Error("already-sent event must not be re-read");
      },
    },
  });

  assert.deepEqual(
    await bridge.handle({ type: CASE_SYNC_ENQUEUE, event: caseEvent() }, courtSender),
    { ok: true, status: "sent", clientMutationId: "case-event-1" },
  );
  assert.equal(retries, 0);
});

test("runtime case outbox sends a serializable event and requires the database acknowledgement", async () => {
  const sent = [];
  const outbox = createRuntimeCaseOutbox({
    async sendMessage(message) {
      sent.push(message);
      return { ok: true, status: "sent", clientMutationId: message.event.clientMutationId };
    },
  });

  const queued = await outbox.enqueue({
    ...caseEvent(),
    blobRef: { storeName: "cases", uid: "client-case-1", field: "successImage" },
  });

  assert.deepEqual(queued, { status: "sent", clientMutationId: "case-event-1" });
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
