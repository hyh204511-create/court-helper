import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

let importSequence = 0;
const EXECUTION_TAB_MESSAGE = "\u8bf7\u5148\u5728\u9875\u9762\u9876\u90e8\u5207\u6362\u5230\u6267\u884c tab";

test("popup 提供立案/强执查询类型选择", async () => {
  const html = await readFile(new URL("../extension/popup/popup.html", import.meta.url), "utf8");
  assert.match(html, /id="query-kind"/);
  assert.match(html, /<option value="li">立案<\/option>/);
  assert.match(html, /<option value="qz">强执<\/option>/);
});

test("popup 收到 EXECUTION_TAB_REQUIRED 时显示固定执行 tab 文案", async () => {
  const dom = new JSDOM(`<!doctype html><html><body><span id="progress-text"></span></body></html>`);
  const previous = { document: globalThis.document, chrome: globalThis.chrome };
  const messages = [];
  globalThis.document = dom.window.document;
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 9 }],
      sendMessage: async (_tabId, message) => {
        messages.push(message);
        return message.type === "PING"
          ? { state: "logged-in", route: "#/pages/pc/case-list/index" }
          : { ok: false, error: "EXECUTION_TAB_REQUIRED" };
      },
    },
  };
  try {
    const popup = await import(`../extension/popup/popup.js?popup-error-test=${importSequence++}`);
    await popup.handleQuery("qz");
    assert.equal(dom.window.document.querySelector("#progress-text").textContent, EXECUTION_TAB_MESSAGE);
    assert.deepEqual(messages.at(-1), { type: "START_BATCH", kind: "qz" });
  } finally {
    dom.window.close();
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
    if (previous.chrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous.chrome;
  }
});

test("popup 选择强执时发送 START_BATCH kind=qz", async () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <select id="query-kind"><option value="li">立案</option><option value="qz" selected>强执</option></select>
    <button id="btn-query"></button><span id="progress-text"></span>
    <table><tbody id="results-body"></tbody></table>
  </body></html>`);
  const messages = [];
  const previous = { document: globalThis.document, chrome: globalThis.chrome, fetch: globalThis.fetch };
  globalThis.document = dom.window.document;
  globalThis.fetch = async () => ({ ok: false });
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
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    dom.window.document.querySelector("#btn-query").click();
    for (let i = 0; i < 20 && !messages.some((message) => message.type === "START_BATCH"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.deepEqual(messages.filter((message) => message.type === "START_BATCH"), [
      { type: "START_BATCH", kind: "qz" },
    ]);
  } finally {
    dom.window.close();
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
    if (previous.chrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous.chrome;
    if (previous.fetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous.fetch;
  }
});

test("popup 初始化以 StorageArea 上下文读取登录状态", async () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <button id="btn-import"></button><button id="btn-export"></button><button id="btn-query"></button>
    <select id="query-kind"><option value="li">立案</option></select>
    <span id="progress-text"></span><span id="query-kind-hint"></span>
    <input id="search-input"><button id="btn-search"></button>
    <select id="status-filter"></select><table><tbody id="results-body"></tbody></table>
  </body></html>`);
  const previous = { document: globalThis.document, chrome: globalThis.chrome, fetch: globalThis.fetch };
  const storageArea = {
    get() {
      assert.equal(this, storageArea, "StorageArea.get 必须保留调用上下文");
      return Promise.resolve({ state: "logged-in", maskedAccount: "a***n" });
    },
    onChanged: { addListener() {} },
  };
  globalThis.document = dom.window.document;
  globalThis.fetch = async () => ({ ok: false });
  globalThis.chrome = {
    storage: { local: storageArea, onChanged: storageArea.onChanged },
    tabs: { query: async () => [], sendMessage: async () => ({}) },
    runtime: {},
  };
  try {
    await import(`../extension/popup/popup.js?popup-storage-context-test=${importSequence++}`);
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    dom.window.close();
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
    if (previous.chrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous.chrome;
    if (previous.fetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previous.fetch;
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
