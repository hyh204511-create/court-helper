import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

import * as db from "../extension/data/db.js";

let importSequence = 0;

function makeChrome() {
  const listeners = [];
  let pendingDetail = null;
  return {
    listeners,
    setPendingDetail(value) { pendingDetail = value; },
    runtime: {
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
      sendMessage: async (message) => {
        if (message?.type === "CASE_DETAIL_PENDING_GET") return { ok: true, pendingDetail };
        if (message?.type === "CASE_DETAIL_PENDING_CLEAR") {
          pendingDetail = null;
          return { ok: true };
        }
        if (message?.type === "CASE_SPACE_OPEN") {
          pendingDetail = { uid: message.uid, kind: message.kind };
          return { ok: true, phase: "opening", tabId: 17 };
        }
        if (message?.type === "CASE_SPACE_ADOPTED") return { ok: true, phase: "adopted", tabId: 18 };
        return undefined;
      },
    },
    storage: {
      session: {
        get: async () => { throw new Error("Access to storage is not allowed from this context."); },
        set: async () => { throw new Error("Access to storage is not allowed from this context."); },
      },
    },
  };
}

function setRect(element, rect) {
  element.getBoundingClientRect = () => ({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
  });
}

function prepareLoginClickTargets(document) {
  setRect(document.querySelector("#submit"), { left: 10, top: 20, width: 100, height: 40 });
  const image = document.querySelector("img");
  if (image) setRect(image, { left: 200, top: 60, width: 100, height: 40 });
}

async function loadContent({ hash, html = "<main></main>" }) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: `https://zxfw.court.gov.cn/zxfw/${hash}`,
  });
  const chrome = makeChrome();
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.chrome = chrome;
  const module = await import(`../extension/content/court-content.js?auto-login-test=${importSequence++}`);
  assert.equal(typeof module.observePanelLogin, "function");
  return { dom, chrome, listener: chrome.listeners.at(-1), module };
}

async function dispatch(listener, message) {
  let response;
  const returnValue = listener(message, {}, (value) => { response = value; });
  if (returnValue === true) {
    const deadline = Date.now() + 1000;
    while (response === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return { returnValue, response };
}

function cleanup(dom) {
  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.location;
  delete globalThis.chrome;
  delete globalThis.fetch;
}

function batchListHtml(caseType = "民事案件") {
  return `
    <div class="fd-header-operate"><div class="fd-user-name">demo-account</div></div>
    <div class="fd-case-item">
      <div class="fd-header-status">待审核</div>
      <div class="fd-header-ajmc">原告测试案件</div>
      <div class="fd-header-ajlx">${caseType}</div>
      <div class="fd-field-item"><span class="fd-field-lable">案号</span><span class="fd-field-value">case-1</span></div>
      <div class="fd-field-item"><span class="fd-field-lable">立案日期</span><span class="fd-field-value">2026-08-06</span></div>
    </div>`;
}

test("AUTO_LOGIN 非登录路由先拒绝，不触碰 DOM/fetch，且不回传 payload", async () => {
  const { dom, listener } = await loadContent({ hash: "#/pagesWsla/pc/home" });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("must not fetch");
  };
  const result = await dispatch(listener, {
    type: "AUTO_LOGIN",
    account: "demo-account",
    password: "demo-password",
    serviceUrl: "http://127.0.0.1:8765",
  });
  assert.equal(result.returnValue, false);
  assert.deepEqual(result.response, { ok: false, error: "NOT_LOGIN_ROUTE" });
  assert.equal(fetchCalls, 0);
  assert.equal(JSON.stringify(result.response).includes("demo-password"), false);
  cleanup(dom);
});

test("EXPORT_REPORT 在非允许列表路由先拒绝，不下载或上传", async () => {
  const { dom, chrome, listener } = await loadContent({ hash: "#/pagesWsla/pc/history/list/index" });
  let sent = 0;
  chrome.runtime.sendMessage = async () => { sent += 1; return { ok: true }; };
  try {
    const result = await dispatch(listener, {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "EXPORT_REPORT",
    });
    assert.equal(result.returnValue, true);
    assert.deepEqual(result.response, { ok: false, error: "PAGE_NOT_LIST" });
    assert.equal(sent, 0);
  } finally {
    cleanup(dom);
  }
});

test("EXPORT_REPORT 仅导出当前登录链路绑定的 platformAccountId 记录", async () => {
  await db.resetDb();
  const targetPlatformAccountId = "00000000-0000-4000-8000-000000000402";
  const otherPlatformAccountId = "00000000-0000-4000-8000-000000000401";
  await db.upsert(db.STORE_CASES, {
    account: "demo-account",
    platformAccountId: targetPlatformAccountId,
    plaintiff: "TARGET PLAINTIFF",
    defendant: "TARGET DEFENDANT",
    kind: "li",
    status: "审核中",
  });
  await db.upsert(db.STORE_CASES, {
    account: "demo-account",
    platformAccountId: otherPlatformAccountId,
    plaintiff: "OTHER PLAINTIFF",
    defendant: "OTHER DEFENDANT",
    kind: "li",
    status: "审核中",
  });
  const { dom, chrome, listener } = await loadContent({
    hash: "#/pagesWsla/pc/list/index",
    html: batchListHtml(),
  });
  const anchorClick = dom.window.HTMLAnchorElement.prototype.click;
  const uploads = [];
  dom.window.HTMLAnchorElement.prototype.click = () => undefined;
  chrome.runtime.sendMessage = async (message) => {
    if (message?.type === "EXPORT_UPLOAD") uploads.push(message);
    return { ok: true, exportId: "synthetic-export" };
  };
  try {
    const result = await dispatch(listener, {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "EXPORT_REPORT",
      platformAccountId: targetPlatformAccountId,
    });
    assert.deepEqual(result.response, { status: "uploaded", exportId: "synthetic-export" });
    assert.equal(uploads.length, 1);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(uploads[0].base64, "base64"));
    const worksheet = workbook.getWorksheet("Sheet1");
    assert.equal(worksheet.getCell("A2").value, "TARGET PLAINTIFF");
    assert.equal(worksheet.getCell("A3").value, null);
  } finally {
    dom.window.HTMLAnchorElement.prototype.click = anchorClick;
    cleanup(dom);
    await db.resetDb();
  }
});

test("EXPORT_REPORT 两表零行时返回 REPORT_EMPTY 且不下载不上传", async () => {
  await db.resetDb();
  const platformAccountId = "00000000-0000-4000-8000-000000000403";
  const { dom, chrome, listener } = await loadContent({
    hash: "#/pagesWsla/pc/list/index",
    html: batchListHtml(),
  });
  const anchorClick = dom.window.HTMLAnchorElement.prototype.click;
  let downloads = 0;
  let uploads = 0;
  dom.window.HTMLAnchorElement.prototype.click = () => { downloads += 1; };
  chrome.runtime.sendMessage = async (message) => {
    if (message?.type === "EXPORT_UPLOAD") uploads += 1;
    return { ok: true };
  };
  try {
    const result = await dispatch(listener, {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "EXPORT_REPORT",
      platformAccountId,
    });
    assert.deepEqual(result.response, { ok: false, error: "REPORT_EMPTY" });
    assert.equal(downloads, 0);
    assert.equal(uploads, 0);
  } finally {
    dom.window.HTMLAnchorElement.prototype.click = anchorClick;
    cleanup(dom);
    await db.resetDb();
  }
});

test("AUTO_LOGIN 登录路由异步响应成功，并只执行页面表单操作", async () => {
  const { dom, chrome, listener } = await loadContent({
    hash: "#/pagesGrxx/pc/login/index",
    html: `
      <view id="password-tab">密码登录</view>
      <input type="text" class="uni-input-input">
      <input type="password" class="uni-input-input">
      <input type="text" class="uni-input-input">
      <img src="data:image/jpeg;base64,amJzZG9t">
      <view id="submit">登录</view>
    `,
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => ({ ok: true, text: "A7x2" }) };
  };
  prepareLoginClickTargets(dom.window.document);
  const clickRequests = [];
  chrome.runtime.sendMessage = async (message) => {
    if (message?.type === "CLICK_REQUEST") {
      clickRequests.push(message);
      dom.window.location.hash = "#/pagesWsla/pc/list/index";
    }
    return { ok: true };
  };

  const result = await dispatch(listener, {
    type: "AUTO_LOGIN",
    account: "demo-account",
    password: "demo-password",
    serviceUrl: "http://127.0.0.1:8765",
  });
  assert.equal(result.returnValue, true);
  assert.deepEqual(result.response, { ok: true });
  assert.equal(fetchCalls, 1);
  assert.deepEqual(clickRequests, [{ type: "CLICK_REQUEST", x: 60, y: 40 }]);
  assert.equal(chrome.listeners.length, 1);
  cleanup(dom);
});

test("AUTO_LOGIN 缺少账号或密码只返回 FORM_NOT_READY，不使用敏感字段", async () => {
  const { dom, listener } = await loadContent({ hash: "#/pagesGrxx/pc/login/index" });
  for (const payload of [
    { type: "AUTO_LOGIN", password: "demo-password", serviceUrl: "http://127.0.0.1:8765" },
    { type: "AUTO_LOGIN", account: "demo-account", serviceUrl: "http://127.0.0.1:8765" },
  ]) {
    const result = await dispatch(listener, payload);
    assert.deepEqual(result.response, { ok: false, error: "FORM_NOT_READY" });
    assert.equal(JSON.stringify(result.response).includes("demo-password"), false);
  }
  cleanup(dom);
});

test("连续 AUTO_LOGIN 消息共享单飞流程，不并行提交", async () => {
  const { dom, listener } = await loadContent({
    hash: "#/pagesGrxx/pc/login/index",
    html: `
      <input type="text" class="uni-input-input">
      <input type="password" class="uni-input-input">
      <input type="text" class="uni-input-input">
      <img src="data:image/jpeg;base64,amJzZG9t">
      <view id="submit">登录</view>
    `,
  });
  let releaseFetch;
  let fetchCalls = 0;
  let clickRequests = 0;
  const fetchReady = new Promise((resolve) => { releaseFetch = resolve; });
  globalThis.fetch = async () => {
    fetchCalls += 1;
    await fetchReady;
    return { ok: true, json: async () => ({ ok: true, text: "A7x2" }) };
  };
  prepareLoginClickTargets(dom.window.document);
  chrome.runtime.sendMessage = async (message) => {
    if (message?.type === "CLICK_REQUEST") {
      clickRequests += 1;
      dom.window.location.hash = "#/pagesWsla/pc/list/index";
    }
    return { ok: true };
  };

  const payload = { type: "AUTO_LOGIN", account: "demo-account", password: "demo-password", serviceUrl: "http://127.0.0.1:8765" };
  const first = dispatch(listener, payload);
  const second = dispatch(listener, payload);
  releaseFetch();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult.response, { ok: true });
  assert.deepEqual(secondResult.response, { ok: true });
  assert.equal(fetchCalls, 1);
  assert.equal(clickRequests, 1);
  cleanup(dom);
});

test("START_BATCH qz：民事 tab 无执行类行时返回 EXECUTION_TAB_REQUIRED", async () => {
  const { dom, listener } = await loadContent({
    hash: "#/pages/pc/case-list/index",
    html: batchListHtml("民事案件"),
  });
  try {
    const result = await dispatch(listener, { type: "START_BATCH", kind: "qz" });
    assert.deepEqual(result.response, { ok: false, error: "EXECUTION_TAB_REQUIRED" });
  } finally {
    cleanup(dom);
  }
});

test("START_BATCH qz：执行类 UNKNOWN 行完成批次但必须转人工", async () => {
  await db.resetDb();
  await db.upsert(db.STORE_ENFORCEMENT, {
    account: "demo-account",
    plaintiff: "原告测试",
    defendant: "被告测试",
    caseNumber: "case-1",
    kind: "qz",
    status: "UNKNOWN",
  });
  const { dom, listener } = await loadContent({
    hash: "#/pages/pc/case-list/index",
    html: batchListHtml("执行类案件"),
  });
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    return nativeSetTimeout(callback, delay >= 3000 ? 0 : delay, ...args);
  };
  try {
    const result = await dispatch(listener, { type: "START_BATCH", kind: "qz" });
    assert.equal(result.response?.ok, false);
    assert.equal(result.response?.error, "NEEDS_HUMAN");
    assert.equal(result.response?.stats?.total, 1);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    cleanup(dom);
    await db.resetDb();
  }
});

test("START_BATCH 驳回行使用真实 DOM 按钮触发详情取证", async () => {
  await db.resetDb();
  const uid = "synthetic-reject-row";
  const sourceCaseName = "SYNTHETIC REJECTED CASE";
  await db.upsertByUid(db.STORE_CASES, uid, {
    uid,
    account: "demo-account",
    plaintiff: "synthetic plaintiff",
    defendant: "synthetic defendant",
    sourceCaseName,
    kind: "li",
    status: "UNKNOWN",
  });
  const { dom, listener } = await loadContent({
    hash: "#/pagesWsla/pc/list/index",
    html: `
      <div class="fd-header-operate"><div class="fd-user-name">demo-account</div></div>
      <div class="fd-case-item">
        <div class="fd-header-status">审核不通过</div>
        <div class="fd-header-ajmc">${sourceCaseName}</div>
        <div class="fd-header-ajlx">民事一审案件</div>
        <div class="fd-field-item"><span class="fd-field-lable">审核意见</span><span class="fd-field-value">synthetic current opinion</span></div>
        <button class="fd-case-space-btn">案件空间</button>
      </div>`,
  });
  let clicks = 0;
  dom.window.document.querySelector(".fd-case-space-btn").addEventListener("click", async () => {
    clicks += 1;
    const current = await db.getByUid(db.STORE_CASES, uid);
    await db.upsertByUid(db.STORE_CASES, uid, {
      ...current,
      rejectTime: "2026-08-07",
      rejectReason: "synthetic current opinion",
      rejectImage: new Blob(["synthetic-reject-image"], { type: "image/jpeg" }),
      needsHuman: false,
      errorCode: null,
    });
  });
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 1000 ? 0 : delay, ...args);
  try {
    const result = await dispatch(listener, { type: "START_BATCH", kind: "li" });
    assert.equal(clicks, 1);
    assert.equal(result.response?.ok, true);
    const stored = await db.getByUid(db.STORE_CASES, uid);
    assert.equal(stored.rejectTime, "2026-08-07");
    assert.equal(stored.rejectReason, "synthetic current opinion");
    assert.equal(stored.needsHuman, false);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    cleanup(dom);
    await db.resetDb();
  }
});

test("START_BATCH 强执待补充材料沿已驳回链路写入驳回证据", async () => {
  await db.resetDb();
  const uid = "synthetic-qz-reject-row";
  const sourceCaseName = "SYNTHETIC REJECTED ENFORCEMENT CASE";
  await db.upsertByUid(db.STORE_ENFORCEMENT, uid, {
    uid,
    account: "demo-account",
    plaintiff: "synthetic applicant",
    defendant: "synthetic respondent",
    sourceCaseName,
    kind: "qz",
    status: "UNKNOWN",
  });
  const { dom, listener } = await loadContent({
    hash: "#/pagesWsla/pc/list/index",
    html: `
      <div class="fd-header-operate"><div class="fd-user-name">demo-account</div></div>
      <div class="fd-case-item">
        <div class="fd-header-status">待补充材料</div>
        <div class="fd-header-ajmc">${sourceCaseName}</div>
        <div class="fd-header-ajlx">首次执行案件</div>
        <div class="fd-field-item"><span class="fd-field-lable">审核意见</span><span class="fd-field-value">synthetic qz opinion</span></div>
        <button class="fd-case-space-btn">案件空间</button>
      </div>`,
  });
  dom.window.document.querySelector(".fd-case-space-btn").addEventListener("click", async () => {
    const current = await db.getByUid(db.STORE_ENFORCEMENT, uid);
    await db.upsertByUid(db.STORE_ENFORCEMENT, uid, {
      ...current,
      rejectTime: "2026-08-07",
      rejectReason: "synthetic qz opinion",
      rejectImage: new Blob(["synthetic-qz-reject-image"], { type: "image/jpeg" }),
      needsHuman: false,
      errorCode: null,
    });
  });
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 1000 ? 0 : delay, ...args);
  try {
    const result = await dispatch(listener, { type: "START_BATCH", kind: "qz" });
    assert.equal(result.response?.ok, true);
    const stored = await db.getByUid(db.STORE_ENFORCEMENT, uid);
    assert.equal(stored.status, "已驳回");
    assert.equal(stored.rejectTime, "2026-08-07");
    assert.equal(stored.rejectReason, "synthetic qz opinion");
    assert.ok(stored.rejectImage instanceof Blob);
    assert.equal(stored.successImage, null);
    assert.equal(stored.needsHuman, false);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    cleanup(dom);
    await db.resetDb();
  }
});

test("详情页最新审核记录不完整时不回退历史记录或截图", async () => {
  await db.resetDb();
  const uid = "synthetic-reject-recapture";
  await db.upsertByUid(db.STORE_CASES, uid, {
    uid,
    account: "demo-account",
    plaintiff: "synthetic plaintiff",
    defendant: "synthetic defendant",
    kind: "li",
    status: "已驳回",
    rejectTime: "2026-08-07",
    rejectReason: "synthetic stale reason",
    needsHuman: true,
    errorCode: "SCREENSHOT_CAPTURE_FAILED",
  });
  const { dom, chrome, module } = await loadContent({
    hash: "#/pagesWsla/common/wsla/detail/index",
    html: `
      <div class="fd-header-operate"><div class="fd-user-name">demo-account</div></div>
      <div class="uni-forms-item"><span>审核结果</span><span>审核不通过</span></div>
      <div class="uni-forms-item"><span>审核时间</span><span>2026-08-07 09:30:00</span></div>
      <div class="uni-forms-item"><span>审核结果</span><span>审核不通过</span></div>
      <div class="uni-forms-item"><span>审核时间</span><span>2026-08-01 10:00:00</span></div>
      <div class="uni-forms-item"><span>审核意见</span><span>synthetic complete opinion</span></div>`,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  chrome.setPendingDetail({ uid, kind: "li" });
  try {
    let captures = 0;
    const ok = await module.runDetailCapture({
      capture: async () => {
        captures += 1;
        return new Blob(["synthetic-recaptured-image"], { type: "image/jpeg" });
      },
    });
    assert.equal(ok, true);
    const stored = await db.getByUid(db.STORE_CASES, uid);
    assert.equal(captures, 0);
    assert.equal(stored.needsHuman, true);
    assert.equal(stored.errorCode, "AUDIT_EVIDENCE_INCOMPLETE");
    assert.equal(stored.rejectTime, "2026-08-07");
    assert.equal(stored.rejectReason, "synthetic stale reason");

    const incompleteUid = "synthetic-incomplete-audit";
    await db.upsertByUid(db.STORE_CASES, incompleteUid, {
      uid: incompleteUid,
      account: "demo-account",
      plaintiff: "synthetic plaintiff 2",
      defendant: "synthetic defendant 2",
      kind: "li",
      status: "已驳回",
      needsHuman: false,
      errorCode: null,
    });
    dom.window.document.body.innerHTML = `
      <div class="fd-header-operate"><div class="fd-user-name">demo-account</div></div>
      <div class="uni-forms-item"><span>审核结果</span><span>审核不通过</span></div>
      <div class="uni-forms-item"><span>审核时间</span><span>2026-08-07 09:30:00</span></div>`;
    chrome.setPendingDetail({ uid: incompleteUid, kind: "li" });
    let incompleteCaptures = 0;
    assert.equal(await module.runDetailCapture({ capture: async () => { incompleteCaptures += 1; } }), true);
    const incomplete = await db.getByUid(db.STORE_CASES, incompleteUid);
    assert.equal(incompleteCaptures, 0);
    assert.equal(incomplete.rejectTime, undefined);
    assert.equal(incomplete.rejectReason, undefined);
    assert.equal(incomplete.needsHuman, true);
    assert.equal(incomplete.errorCode, "AUDIT_EVIDENCE_INCOMPLETE");
  } finally {
    cleanup(dom);
    await db.resetDb();
  }
});
