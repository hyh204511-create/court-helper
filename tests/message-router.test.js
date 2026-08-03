import assert from "node:assert/strict";
import { test } from "node:test";

import { VERSION, handleMessage } from "../extension/shared/message-router.js";

test("PING → PONG", () => {
  const res = handleMessage({ type: "PING" });
  assert.equal(res.type, "PONG");
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.version, VERSION);
});

test("未知类型 → ERROR", () => {
  const res = handleMessage({ type: "WHATEVER" });
  assert.equal(res.type, "ERROR");
  assert.equal(res.payload.code, "UNKNOWN_TYPE");
  assert.equal(res.payload.type, "WHATEVER");
});
