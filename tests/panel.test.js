// panel-module 测试：网页浮动面板（规格 docs/specs/panel-module.md）
// - 挂载/折叠交互/登录三态/脱敏/操作区回调/进度渲染/暂停继续
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { maskAccount, createCourtPanel } from "../extension/content/court-panel.js";

const EXECUTION_TAB_MESSAGE = "\u8bf7\u5148\u5728\u9875\u9762\u9876\u90e8\u5207\u6362\u5230\u6267\u884c tab";

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

test("面板挂载：宿主存在，Shadow DOM 内结构完整（头部/操作区/进度区/底部）", () => {
  const { document, panel } = setup();
  const host = document.getElementById("court-helper-panel-root");
  assert.ok(host, "宿主元素应挂载到页面");
  assert.ok(host.shadowRoot, "应使用 Shadow DOM");
  const text = host.shadowRoot.textContent;
  assert.ok(text.includes("法院立案/强执查询助手"), "头部标题");
  assert.ok(text.includes("导入模板"), "操作区：导入");
  assert.ok(text.includes("开始查询"), "操作区：查询");
  assert.ok(text.includes("导出报表"), "操作区：导出");
  assert.ok(text.includes("待处理"), "进度区");
  assert.ok(text.includes("登录全人工"), "底部说明");
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

test("操作区按钮触发回调：导入/开始查询/导出", () => {
  const { document, panel, calls } = setup();
  const host = document.getElementById("court-helper-panel-root");
  click(host.shadowRoot.querySelector(".btn-import"));
  assert.equal(calls.import, 1);
  click(host.shadowRoot.querySelector(".btn-query"));
  assert.equal(calls.query, 1);
  assert.deepEqual(calls.queryKinds, ["li"]);
  click(host.shadowRoot.querySelector(".btn-export"));
  assert.equal(calls.export, 1);
});

test("面板查询类型选择：强执传递 qz 并显示执行 tab 提示", () => {
  const { document, calls } = setup();
  const host = document.getElementById("court-helper-panel-root");
  const select = host.shadowRoot.querySelector(".query-kind");
  assert.ok(select);
  assert.deepEqual([...select.options].map((option) => [option.value, option.textContent]), [
    ["li", "立案"],
    ["qz", "强执"],
  ]);
  select.value = "qz";
  select.dispatchEvent(new select.ownerDocument.defaultView.Event("change", { bubbles: true }));
  assert.ok(host.shadowRoot.querySelector(".query-kind-hint").textContent.includes("执行 tab"));
  click(host.shadowRoot.querySelector(".btn-query"));
  assert.deepEqual(calls.queryKinds, ["qz"]);
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

test("暂停/继续按钮触发回调", () => {
  const { document, panel, calls } = setup();
  const host = document.getElementById("court-helper-panel-root");
  click(host.shadowRoot.querySelector(".btn-pause"));
  assert.equal(calls.pause, 1);
  click(host.shadowRoot.querySelector(".btn-resume"));
  assert.equal(calls.resume, 1);
});

test("采集器未就绪：setReady(false) 显示提示，不猜测状态", () => {
  const { document, panel } = setup();
  const host = document.getElementById("court-helper-panel-root");
  panel.setReady(false);
  assert.ok(host.shadowRoot.textContent.includes("采集器未就绪"), "未就绪提示");
});
test("面板收到 EXECUTION_TAB_REQUIRED 时显示固定执行 tab 文案", async () => {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
  const { document } = dom.window;
  createCourtPanel({
    document,
    shadowMode: "open",
    handlers: {
      onQuery: () => Promise.reject(new Error("EXECUTION_TAB_REQUIRED")),
    },
  });
  const host = document.getElementById("court-helper-panel-root");
  const select = host.shadowRoot.querySelector(".query-kind");
  select.value = "qz";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  click(host.shadowRoot.querySelector(".btn-query"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(host.shadowRoot.querySelector(".notice").textContent, EXECUTION_TAB_MESSAGE);
  dom.window.close();
});
