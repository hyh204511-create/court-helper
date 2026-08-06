import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import {
  EXTENSION_PAIRING_REQUEST,
  EXTENSION_PAIRING_STATUS_REQUEST,
} from "../extension/sw/extension-pairing.js";
import { createSetupController } from "../extension/options/setup.js";

function makeDom() {
  return new JSDOM(`<!doctype html><html><body>
    <form id="setup-form">
      <input id="server-url" type="url">
      <button id="request-authorization" type="submit">请求后台授权</button>
    </form>
    <output id="verification-code"></output>
    <p id="authorization-status"></p>
  </body></html>`);
}

test("Options/Setup 页面只包含服务地址、六位核对码与授权状态", async () => {
  const html = await readFile(new URL("../extension/options/setup.html", import.meta.url), "utf8");
  assert.match(html, /id="server-url"/);
  assert.match(html, /id="request-authorization"/);
  assert.match(html, /id="verification-code"/);
  assert.match(html, /id="authorization-status"/);
  assert.doesNotMatch(html, /一键登录|导入模板|开始立案查询|开始强执查询|导出报表|平台密码/);
});

test("Options/Setup 从 SW 恢复配对状态并展示六位核对码", async () => {
  const dom = makeDom();
  const messages = [];
  const controller = createSetupController({
    document: dom.window.document,
    chromeApi: {
      storage: { local: { get: async () => ({ serverUrl: "http://127.0.0.1:3000" }) } },
      runtime: { sendMessage: async (message) => {
        messages.push(message);
        return { ok: true, status: "awaiting_approval", verificationCode: "123456" };
      } },
    },
  });

  await controller.init();

  assert.deepEqual(messages, [{ type: EXTENSION_PAIRING_STATUS_REQUEST }]);
  assert.equal(dom.window.document.querySelector("#server-url").value, "http://127.0.0.1:3000");
  assert.equal(dom.window.document.querySelector("#verification-code").textContent, "123456");
  assert.match(dom.window.document.querySelector("#authorization-status").textContent, /等待管理员批准/);
  controller.destroy();
  dom.window.close();
});

test("Options/Setup 仅以规范化 loopback 地址请求配对", async () => {
  const dom = makeDom();
  const messages = [];
  const controller = createSetupController({
    document: dom.window.document,
    chromeApi: {
      storage: { local: { get: async () => ({ serverUrl: "" }) } },
      runtime: { sendMessage: async (message) => {
        messages.push(message);
        if (message.type === EXTENSION_PAIRING_STATUS_REQUEST) return { ok: true, status: "not_configured" };
        return { ok: true, status: "awaiting_approval", verificationCode: "654321" };
      } },
    },
  });
  await controller.init();
  const input = dom.window.document.querySelector("#server-url");

  input.value = "http://localhost:3000/admin/browser-control";
  dom.window.document.querySelector("#setup-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(messages, [{ type: EXTENSION_PAIRING_STATUS_REQUEST }]);
  assert.match(dom.window.document.querySelector("#authorization-status").textContent, /127\.0\.0\.1:3000/);

  input.value = "http://127.0.0.1:3000/";
  dom.window.document.querySelector("#setup-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(messages.at(-1), {
    type: EXTENSION_PAIRING_REQUEST,
    serverUrl: "http://127.0.0.1:3000",
  });
  assert.equal(dom.window.document.querySelector("#verification-code").textContent, "654321");
  controller.destroy();
  dom.window.close();
});
