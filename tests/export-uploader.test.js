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
        messages.push(JSON.parse(JSON.stringify(message)));
        return response;
      },
    },
  };
}

test("导出上传助手计算 SHA-256，发送 base64 消息，并归一化成功回执", async () => {
  const cryptoImpl = makeCrypto([0, 1, 15, 255]);
  const chromeApi = makeChrome({ ok: true, exportId: "export-1" });
  const buffer = Uint8Array.from([1, 2, 3]).buffer;

  const result = await exportWorkbookToServer({
    buffer,
    fileName: "report.xlsx",
    platformAccountId: "00000000-0000-0000-0000-000000000010",
    chromeApi,
    cryptoImpl,
    btoaImpl: (binary) => Buffer.from(binary, "binary").toString("base64"),
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
    base64: chromeApi.messages[0].base64,
    mime: chromeApi.messages[0].mime,
    platformAccountId: chromeApi.messages[0].platformAccountId,
  }, {
    type: "EXPORT_UPLOAD",
    fileName: "report.xlsx",
    sha256: "00010fff",
    base64: "AQID",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    platformAccountId: "00000000-0000-0000-0000-000000000010",
  });
  assert.equal(Object.hasOwn(chromeApi.messages[0], "blob"), false);
  assert.deepEqual(Uint8Array.from(Buffer.from(chromeApi.messages[0].base64, "base64")), Uint8Array.from([1, 2, 3]));
});

test("base64 缂栫爜鎸夊潡澶勭悊澶у瓧鑺傚簭鍒楄€屼笉鎶涚栈婧㈠嚭", async () => {
  const bytes = Uint8Array.from({ length: 0x8001 }, (_, index) => index % 251);
  const chromeApi = makeChrome({ ok: true });

  await exportWorkbookToServer({
    buffer: bytes,
    fileName: "large-report.xlsx",
    chromeApi,
    cryptoImpl: makeCrypto(),
    btoaImpl: (binary) => Buffer.from(binary, "binary").toString("base64"),
  });

  assert.deepEqual(Uint8Array.from(Buffer.from(chromeApi.messages[0].base64, "base64")), bytes);
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
