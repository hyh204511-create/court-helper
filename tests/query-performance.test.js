import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchLayyPages, memoizeAsync } from "../extension/content/query-api.js";

const jsonResponse = (body) => ({
  status: 200,
  url: "https://court.invalid/yzw/yzw-zxfw-lafw/api/v3/layy",
  redirected: false,
  headers: { get: () => "application/json" },
  async json() { return body; },
});

test("zero-count layy skips the list request", async () => {
  const calls = [];
  const result = await fetchLayyPages({
    kind: "li",
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("/count")) return jsonResponse({ data: 0 });
      throw new Error("list request must be skipped for total=0");
    },
  });

  assert.deepEqual(result, {
    ok: true,
    rawTotal: 0,
    total: 0,
    skipped: 0,
    reportableMask: [],
    rows: [],
    pages: [],
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/count/);
});

test("async memoizer reuses successful results but does not retain failures", async () => {
  let calls = 0;
  let fail = true;
  const read = memoizeAsync(async (key) => {
    calls += 1;
    if (fail) throw new Error(`temporary-${key}`);
    return { key, calls };
  });

  await assert.rejects(() => read("same"), /temporary-same/);
  fail = false;
  const first = await read("same");
  const second = await read("same");

  assert.deepEqual(first, second);
  assert.equal(calls, 2);
});
