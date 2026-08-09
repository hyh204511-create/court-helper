import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RemoteError,
  createRemoteClient,
} from "../extension/data/remote-client.js";

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

test("未配置服务器时创建客户端返回离线值，不触发网络", async () => {
  let calls = 0;
  assert.equal(createRemoteClient({ fetchImpl: async () => { calls += 1; } }), null);
  assert.equal(calls, 0);
});

test("同步请求附加 API 前缀、Bearer 与稳定 Idempotency-Key", async () => {
  const requests = [];
  const client = createRemoteClient({
    baseUrl: "https://sync.example.test",
    token: "opaque-token",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({ accepted: [], conflicts: [], cursor: 7 });
    },
  });

  const result = await client.syncCases(
    { batchId: "batch-1", items: [] },
    { idempotencyKey: "mutation-1" },
  );

  assert.deepEqual(result, { accepted: [], conflicts: [], cursor: 7 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://sync.example.test/api/v1/sync/cases");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, "Bearer opaque-token");
  assert.equal(requests[0].init.headers["Content-Type"], "application/json");
  assert.equal(requests[0].init.headers["Idempotency-Key"], "mutation-1");
  assert.deepEqual(JSON.parse(requests[0].init.body), { batchId: "batch-1", items: [] });
});

test("服务端错误映射为可判定 RemoteError，409 不可重试", async () => {
  const client = createRemoteClient({
    baseUrl: "https://sync.example.test/api/v1",
    token: "opaque-token",
    fetchImpl: async () => jsonResponse({
      error: { code: "CONFLICT", message: "safe conflict", retryable: false, requestId: "req-1" },
    }, { status: 409 }),
  });

  await assert.rejects(
    () => client.syncCases({ batchId: "batch-1", items: [] }, { idempotencyKey: "mutation-1" }),
    (error) => {
      assert.ok(error instanceof RemoteError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "CONFLICT");
      assert.equal(error.retryable, false);
      assert.equal(error.requestId, "req-1");
      return true;
    },
  );
});

test("截图上传使用 multipart 且携带幂等键，不把 Blob 放进 JSON", async () => {
  const requests = [];
  const client = createRemoteClient({
    baseUrl: "https://sync.example.test/api/v1",
    token: "opaque-token",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({ id: "shot-1", sha256: "a".repeat(64) }, { status: 201 });
    },
  });

  const blob = new Blob(["image"], { type: "image/jpeg" });
  const result = await client.uploadScreenshot("case-1", {
    eventId: "event-1",
    type: "success",
    capturedAt: "2026-08-05T00:00:00.000Z",
    sha256: "a".repeat(64),
    blob,
  }, { idempotencyKey: "mutation-shot-1" });

  assert.equal(result.id, "shot-1");
  assert.equal(requests[0].url, "https://sync.example.test/api/v1/cases/case-1/screenshots");
  assert.equal(requests[0].init.headers.Authorization, "Bearer opaque-token");
  assert.equal(requests[0].init.headers["Idempotency-Key"], "mutation-shot-1");
  assert.ok(requests[0].init.body instanceof FormData);
  assert.equal(requests[0].init.body.get("eventId"), "event-1");
  assert.equal(requests[0].init.body.get("file").type, "image/jpeg");
});

test("报表导出上传携带账号关联、sha256 与文件", async () => {
  const requests = [];
  const client = createRemoteClient({
    baseUrl: "https://sync.example.test/api/v1",
    token: "opaque-token",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({
        id: "export-1",
        fileName: "立案与强执查询表-2026-08-06.xlsx",
        byteSize: 7,
        sha256: "a".repeat(64),
        createdAt: "2026-08-06T00:00:00.000Z",
        created: true,
      }, { status: 201 });
    },
  });

  const blob = new Blob(["xlsx"], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const result = await client.uploadReportExport({
    blob,
    fileName: "立案与强执查询表-2026-08-06.xlsx",
    sha256: "a".repeat(64),
    platformAccountId: "00000000-0000-0000-0000-000000000010",
  });

  assert.deepEqual(result, {
    id: "export-1",
    fileName: "立案与强执查询表-2026-08-06.xlsx",
    byteSize: 7,
    sha256: "a".repeat(64),
    createdAt: "2026-08-06T00:00:00.000Z",
    created: true,
  });
  assert.equal(requests[0].url, "https://sync.example.test/api/v1/report-exports");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, "Bearer opaque-token");
  assert.equal(requests[0].init.headers["Idempotency-Key"], undefined);
  assert.ok(requests[0].init.body instanceof FormData);
  assert.equal(requests[0].init.body.get("sha256"), "a".repeat(64));
  assert.equal(requests[0].init.body.get("platformAccountId"), "00000000-0000-0000-0000-000000000010");
  assert.equal(requests[0].init.body.get("clientExportId"), null);
  const file = requests[0].init.body.get("file");
  assert.equal(file.name, "立案与强执查询表-2026-08-06.xlsx");
  assert.equal(file.type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
});
