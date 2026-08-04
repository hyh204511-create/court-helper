import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function installGlobals(dom) {
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;
  globalThis.chrome = { runtime: { onMessage: { addListener() {} } } };
}

function removeUserArea(document) {
  document.querySelector(".fd-header-operate")?.remove();
}

test("用户区新增和删除分别触发登录状态刷新", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://zxfw.court.gov.cn/zxfw/#/not-panel",
  });
  installGlobals(dom);

  try {
    const { observePanelLogin } = await import("../extension/content/court-content.js");
    let refreshCount = 0;
    const stop = observePanelLogin({
      root: dom.window.document,
      view: dom.window,
      refresh: () => { refreshCount += 1; },
    });

    const userArea = dom.window.document.createElement("div");
    userArea.className = "fd-header-operate";
    userArea.innerHTML = '<span class="fd-user-name">账号A</span>';
    dom.window.document.body.append(userArea);
    await wait(350);
    assert.equal(refreshCount, 1, "用户区新增后应刷新一次");

    removeUserArea(dom.window.document);
    await wait(350);
    assert.equal(refreshCount, 2, "用户区删除后应再次刷新");

    stop();
  } finally {
    dom.window.close();
    delete globalThis.chrome;
    delete globalThis.location;
    delete globalThis.window;
    delete globalThis.document;
  }
});

test("body 尚不存在（document_start 时序）时不抛错，body 出现后正常监听", async () => {
  // 模拟 content script 在 document_start 注入：html 有但 body 还没有
  const dom = new JSDOM("<!doctype html><html></html>", {
    url: "https://zxfw.court.gov.cn/zxfw/#/not-panel",
  });
  installGlobals(dom);
  // jsdom 默认会补 body，先移除以模拟 document_start 时序
  dom.window.document.body?.remove();
  dom.window.document.documentElement.innerHTML = "<head></head>";

  try {
    const { observePanelLogin } = await import("../extension/content/court-content.js");
    let refreshCount = 0;
    let stop;
    assert.doesNotThrow(() => {
      stop = observePanelLogin({
        root: dom.window.document,
        view: dom.window,
        refresh: () => { refreshCount += 1; },
      });
    }, "body 缺失时 observe 不应抛 TypeError");

    // body 稍后出现（SPA 渲染）→ 观察器应生效
    const body = dom.window.document.createElement("body");
    dom.window.document.documentElement.appendChild(body);
    await wait(50);
    const userArea = dom.window.document.createElement("div");
    userArea.className = "fd-header-operate";
    userArea.innerHTML = '<span class="fd-user-name">账号A</span>';
    body.append(userArea);
    await wait(400);
    assert.equal(refreshCount, 1, "body 出现后用户区新增应触发刷新");

    stop?.();
  } finally {
    dom.window.close();
    delete globalThis.chrome;
    delete globalThis.location;
    delete globalThis.window;
    delete globalThis.document;
  }
});
