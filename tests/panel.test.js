// panel-module 测试：网页浮动面板（规格 docs/specs/panel-module.md）
// - 挂载/折叠交互/登录三态/脱敏/降级状态面板/进度渲染
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { maskAccount, createCourtPanel } from "../extension/content/court-panel.js";

function setup({ hash = "#/pagesWsla/pc/list/index" } = {}) {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: `https://zxfw.court.gov.cn/zxfw/${hash}`,
  });
  const { document } = dom.window;
  const calls = { import: 0, export: 0, query: 0, queryKinds: [], pause: 0, resume: 0 };
  const panel = createCourtPanel({
    document,
    shadowMode: "open",
    handlers: {
      onImport: () => { calls.import += 1; },
      onExport: () => { calls.export += 1; },
      onQuery: (kind) => { calls.query += 1; calls.queryKinds.push(kind); },
      onPause: () => { calls.pause += 1; },
      onResume: () => { calls.resume += 1; },
    },
  });
  return { dom, document, panel, calls };
}

function click(el) {
  el.dispatchEvent(new domEvent(el, "click"));
}

function domEvent(el, type) {
  return new el.ownerDocument.defaultView.MouseEvent(type, { bubbles: true, cancelable: true });
}

test("maskAccount：长账号首尾各 1 位 + ***", () => {
  assert.equal(maskAccount("abcdef"), "a***f");
  assert.equal(maskAccount("账号一二三四五"), "账***五");
});

test("maskAccount：短账号（≤2 位）整体加 * 掩码；空值返回空", () => {
  assert.equal(maskAccount("ab"), "a*");
  assert.equal(maskAccount("a"), "*");
  assert.equal(maskAccount(""), "");
  assert.equal(maskAccount(null), "");
});

test("面板挂载：宿主存在，降级为状态/进度/人工接管提示", () => {
  const { document, panel } = setup();
  const host = document.getElementById("court-helper-panel-root");
  assert.ok(host, "宿主元素应挂载到页面");
  assert.ok(host.shadowRoot, "应使用 Shadow DOM");
  const text = host.shadowRoot.textContent;
  assert.ok(text.includes("法院立案/强执查询助手"), "头部标题");
  assert.ok(text.includes("后台控制台"), "后台唯一入口提示");
  assert.equal(host.shadowRoot.querySelector(".btn-import"), null);
  assert.equal(host.shadowRoot.querySelector(".btn-query"), null);
  assert.equal(host.shadowRoot.querySelector(".btn-export"), null);
  assert.ok(text.includes("待处理"), "进度区");
  assert.ok(text.includes("后台唯一业务入口"), "底部说明");
});

test("初始为折叠悬浮球：面板主体隐藏，点击悬浮球展开，再点收起", () => {
  const { document, panel } = setup();
  const host = document.getElementById("court-helper-panel-root");
  const shell = host.shadowRoot.querySelector(".shell");
  assert.ok(shell.classList.contains("collapsed"), "初始应为收起态");
  // 点击悬浮球 → 展开
  click(host.shadowRoot.querySelector(".fab"));
  assert.ok(!shell.classList.contains("collapsed"), "点击悬浮球应展开");
  // 点「−」→ 收起
  click(host.shadowRoot.querySelector(".collapse"));
  assert.ok(shell.classList.contains("collapsed"), "点收起应折叠");
  // 再点悬浮球 → 展开
  click(host.shadowRoot.querySelector(".fab"));
  assert.ok(!shell.classList.contains("collapsed"), "再次点击应展开");
});

test("登录状态渲染：未登录灰点、已登录绿点+脱敏账号、过期红点", () => {
  const { document, panel } = setup();
  const host = document.getElementById("court-helper-panel-root");
  const statusEl = host.shadowRoot.querySelector(".login-status");

  panel.setLogin({ state: "login", account: null });
  assert.ok(statusEl.textContent.includes("未登录"), "未登录文本");
  assert.ok(statusEl.classList.contains("off"), "未登录灰点");

  panel.setLogin({ state: "logged-in", account: "罗强账号abc" });
  assert.ok(statusEl.textContent.includes("罗***c"), "脱敏账号");
  assert.ok(!statusEl.textContent.includes("罗强账号abc"), "禁止出现完整账号");
  assert.ok(statusEl.classList.contains("ok"), "已登录绿点");

  panel.setLogin({ state: "session-expired", account: null });
  assert.ok(statusEl.textContent.includes("已过期"), "会话失效文本");
  assert.ok(statusEl.classList.contains("bad"), "过期红点");
});

test("进度渲染：done/total 与待处理分组文本", () => {
  const { document, panel } = setup();
  const host = document.getElementById("court-helper-panel-root");
  panel.setProgress({ done: 12, total: 50, groups: [{ account: "账号A", count: 30 }, { account: "账号B", count: 20 }] });
  const text = host.shadowRoot.textContent;
  assert.ok(text.includes("12/50"), "进度数值");
  assert.ok(text.includes("账***A"), "分组脱敏账号");
  assert.ok(text.includes("30"), "分组条数");
});

test("采集器未就绪：setReady(false) 显示提示，不猜测状态", () => {
  const { document, panel } = setup();
  const host = document.getElementById("court-helper-panel-root");
  panel.setReady(false);
  assert.ok(host.shadowRoot.textContent.includes("采集器未就绪"), "未就绪提示");
});
