import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

let importSequence = 0;

test("popup 提供立案/强执查询类型选择", async () => {
  const html = await readFile(new URL("../extension/popup/popup.html", import.meta.url), "utf8");
  assert.match(html, /id="query-kind"/);
  assert.match(html, /<option value="li">立案<\/option>/);
  assert.match(html, /<option value="qz">强执<\/option>/);
});

test("popup 选择强执时发送 START_BATCH kind=qz", async () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <select id="query-kind"><option value="li">立案</option><option value="qz" selected>强执</option></select>
    <button id="btn-query"></button><span id="progress-text"></span>
  </body></html>`);
  const messages = [];
  const previous = { document: globalThis.document, chrome: globalThis.chrome };
  globalThis.document = dom.window.document;
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 9 }],
      sendMessage: async (_tabId, message) => {
        messages.push(message);
        return message.type === "PING"
          ? { state: "logged-in", route: "#/pages/pc/case-list/index" }
          : { ok: true };
      },
    },
  };
  try {
    const popup = await import(`../extension/popup/popup.js?popup-test=${importSequence++}`);
    const response = await popup.handleQuery();
    assert.deepEqual(response, { ok: true });
    assert.deepEqual(messages, [
      { type: "PING" },
      { type: "START_BATCH", kind: "qz" },
    ]);
  } finally {
    dom.window.close();
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
    if (previous.chrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous.chrome;
  }
});

test("popup 导出先本地下载，再显示三种上传回执", async () => {
  const dom = new JSDOM(`<!doctype html><html><body><span id="progress-text"></span></body></html>`);
  const previous = { document: globalThis.document, chrome: globalThis.chrome };
  globalThis.document = dom.window.document;
  globalThis.chrome = {};
  const events = [];
  const originalCreateElement = dom.window.document.createElement.bind(dom.window.document);
  dom.window.document.createElement = (tagName, options) => {
    const element = originalCreateElement(tagName, options);
    if (tagName === "a") element.click = () => events.push("download");
    return element;
  };
  const urlApi = {
    createObjectURL: () => "blob:test",
    revokeObjectURL: () => events.push("revoke"),
  };
  try {
    const popup = await import(`../extension/popup/popup.js?popup-export-test=${importSequence++}`);
    for (const [response, expected] of [
      [{ status: "uploaded", exportId: "export-1" }, "已上传服务器，后台可再次下载"],
      [{ status: "not_configured", code: "NOT_CONFIGURED" }, "未配置服务器，仅本地保存"],
      [{ status: "failed", code: "NETWORK_UNAVAILABLE" }, "上传失败，本地文件已保存"],
    ]) {
      events.length = 0;
      const result = await popup.downloadAndUploadExportBlob({
        blob: new Blob(["xlsx"]),
        fileName: "report.xlsx",
        documentApi: dom.window.document,
        chromeApi: {},
        urlApi,
        uploader: async () => {
          events.push("upload");
          return response;
        },
      });
      assert.deepEqual(result, response);
      assert.deepEqual(events, ["download", "revoke", "upload"]);
      assert.equal(dom.window.document.querySelector("#progress-text").textContent, expected);
    }
  } finally {
    dom.window.close();
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
    if (previous.chrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous.chrome;
  }
});
