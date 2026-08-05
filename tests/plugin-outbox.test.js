import "fake-indexeddb/auto";

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  STORE_OUTBOX,
  clearOutbox,
  drain,
  enqueue,
  getOutbox,
  listOutbox,
  markNeedsHuman,
  retry,
} from "../extension/data/outbox.js";
import { resetDb } from "../extension/data/db.js";

beforeEach(async () => {
  await resetDb();
});

test("enqueue 持久化完整事件并剔除 payload 中的 password/图片字段", async () => {
  const event = await enqueue({
    type: "case.sync",
    clientMutationId: "mutation-1",
    payload: {
      clientUid: "uid-1",
      password: "must-not-persist",
      successImage: new Blob(["secret-image"]),
    },
    blobRef: { storeName: "cases", uid: "uid-1", field: "successImage" },
  });

  assert.equal(event.type, "case.sync");
  assert.equal(event.status, "pending");
  assert.equal(event.attempts, 0);
  assert.equal(event.clientMutationId, "mutation-1");
  assert.equal(typeof event.id, "string");
  assert.equal(event.nextRetryAt, 0);
  assert.equal(event.payload.password, undefined);
  assert.equal(event.payload.successImage, undefined);

  const stored = await getOutbox(event.id);
  assert.deepEqual(stored, event);
  assert.equal((await listOutbox({ status: "pending" })).length, 1);
  assert.equal(STORE_OUTBOX, "outbox");
});

test("同一 clientMutationId 幂等入队，成功 drain 后标记 sent", async () => {
  const first = await enqueue({ type: "case.sync", clientMutationId: "same", payload: { n: 1 } });
  const second = await enqueue({ type: "case.sync", clientMutationId: "same", payload: { n: 1 } });
  assert.equal(second.id, first.id);

  const calls = [];
  const result = await drain({
    now: () => 1000,
    send: async (event, context) => {
      calls.push({ event, context });
      return { accepted: [{ clientUid: "uid-1" }], conflicts: [], cursor: 2 };
    },
  });

  assert.equal(result.sent, 1);
  assert.equal(calls[0].context.idempotencyKey, "same");
  assert.equal((await getOutbox(first.id)).status, "sent");
});

test("大量终态事件不占满 drain 切片，少量到期 pending 仍会发送", async () => {
  for (let index = 0; index < 60; index += 1) {
    const terminal = await enqueue({
      id: `terminal-${String(index).padStart(2, "0")}`,
      type: "case.sync",
      payload: { clientUid: `terminal-${index}` },
    });
    await markNeedsHuman(terminal.id, { reason: "CONFLICT" });
  }
  const pending = await enqueue({
    id: "zz-pending-last",
    type: "case.sync",
    payload: { clientUid: "pending-client" },
  });
  const sent = [];

  const summary = await drain({
    now: () => 1000,
    limit: 50,
    send: async (event) => {
      sent.push(event.id);
      return { accepted: [{ clientUid: "pending-client" }], conflicts: [] };
    },
  });

  assert.deepEqual(sent, [pending.id]);
  assert.equal(summary.sent, 1);
  assert.equal((await getOutbox(pending.id)).status, "sent");
});

test("失败使用指数退避，达到单条上限后进入 needs_human", async () => {
  let now = 1000;
  const event = await enqueue({ type: "case.sync", payload: { n: 1 } });
  const send = async () => { throw new Error("NETWORK_ERROR"); };

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await retry(event.id);
    await drain({ now: () => now, send, baseDelayMs: 100 });
    const current = await getOutbox(event.id);
    assert.equal(current.attempts, attempt);
    if (attempt < 5) {
      assert.equal(current.status, "pending");
      assert.equal(current.nextRetryAt, now + (100 * (2 ** (attempt - 1))));
      now = current.nextRetryAt;
    } else {
      assert.equal(current.status, "needs_human");
    }
  }
});

test("409/冲突可标记 needs_human，手动 retry 回到 pending", async () => {
  const event = await enqueue({ type: "case.sync", payload: { n: 1 } });
  await markNeedsHuman(event.id, { reason: "CONFLICT" });
  assert.equal((await getOutbox(event.id)).status, "needs_human");
  await retry(event.id);
  const retried = await getOutbox(event.id);
  assert.equal(retried.status, "pending");
  assert.equal(retried.nextRetryAt, 0);
  await clearOutbox();
  assert.equal((await listOutbox()).length, 0);
});
