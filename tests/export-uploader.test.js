import assert from "node:assert/strict";
import { test } from "node:test";

import { exportWorkbookToServer } from "../extension/data/export-uploader.js";

function makeCrypto(digestBytes = [0xde, 0xad, 0xbe, 0xef]) {
  const calls = [];
  return {
    calls,
    subtle: {
      async digest(algorithm, data) {
        calls.push({ algorithm, data: new Uint8Array(data) });
        return Uint8Array.from(digestBytes).buffer;
      },
    },
  };
}

function makeChrome(response) {
  const messages = [];
  return {
    messages,
    runtime: {
      sendMessage: async (message) => {
        messages.push(message);
        return response;
      },
    },
  };
}

test("导出上传助手计算 SHA-256，发送 Blob，并归一化成功回执", async () => {
  const cryptoImpl = makeCrypto([0, 1, 15, 255]);
  const chromeApi = makeChrome({ ok: true, exportId: "export-1" });
  const buffer = Uint8Array.from([1, 2, 3]).buffer;

  const result = await exportWorkbookToServer({
    buffer,
    fileName: "report.xlsx",
    chromeApi,
    cryptoImpl,
  });

  assert.deepEqual(result, { status: "uploaded", exportId: "export-1" });
  assert.deepEqual(cryptoImpl.calls, [{
    algorithm: "SHA-256",
    data: Uint8Array.from([1, 2, 3]),
  }]);
  assert.equal(chromeApi.messages.length, 1);
  assert.deepEqual({
    type: chromeApi.messages[0].type,
    fileName: chromeApi.messages[0].fileName,
    sha256: chromeApi.messages[0].sha256,
  }, {
    type: "EXPORT_UPLOAD",
    fileName: "report.xlsx",
    sha256: "00010fff",
  });
  assert.ok(chromeApi.messages[0].blob instanceof Blob);
  assert.deepEqual(new Uint8Array(await chromeApi.messages[0].blob.arrayBuffer()), Uint8Array.from([1, 2, 3]));
});

test("未配置服务器回执归一化为 not_configured", async () => {
  const result = await exportWorkbookToServer({
    blob: new Blob(["xlsx"]),
    fileName: "report.xlsx",
    chromeApi: makeChrome({ ok: false, code: "NOT_CONFIGURED" }),
    cryptoImpl: makeCrypto(),
  });

  assert.deepEqual(result, { status: "not_configured", code: "NOT_CONFIGURED" });
});

test("远端失败回执归一化为 failed 且不抛出", async () => {
  const result = await exportWorkbookToServer({
    blob: new Blob(["xlsx"]),
    fileName: "report.xlsx",
    chromeApi: makeChrome({ ok: false, code: "NETWORK_UNAVAILABLE" }),
    cryptoImpl: makeCrypto(),
  });

  assert.deepEqual(result, { status: "failed", code: "NETWORK_UNAVAILABLE" });
});

test("哈希或消息异常也只返回 failed，不阻塞本地导出", async () => {
  const result = await exportWorkbookToServer({
    buffer: new Uint8Array([1]).buffer,
    fileName: "report.xlsx",
    chromeApi: { runtime: { sendMessage: async () => { throw Object.assign(new Error("down"), { code: "NETWORK_UNAVAILABLE" }); } } },
    cryptoImpl: { subtle: { digest: async () => { throw Object.assign(new Error("crypto"), { code: "CRYPTO_FAILED" }); } } },
  });

  assert.deepEqual(result, { status: "failed", code: "CRYPTO_FAILED" });
});

test("缺少 buffer/blob 也只返回失败回执", async () => {
  const result = await exportWorkbookToServer({
    fileName: "report.xlsx",
    chromeApi: makeChrome({ ok: true, exportId: "should-not-send" }),
    cryptoImpl: makeCrypto(),
  });

  assert.deepEqual(result, { status: "failed", code: "EXPORT_BUFFER_REQUIRED" });
});
