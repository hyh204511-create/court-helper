import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

import * as db from "../extension/data/db.js";

let importSequence = 0;

function makeChrome(sendMessage) {
  const listeners = [];
  const sentMessages = [];
  return {
    listeners,
    sentMessages,
    runtime: {
      id: typeof sendMessage === "function" ? "synthetic-extension-id" : undefined,
      onMessage: { addListener(listener) { listeners.push(listener); } },
      sendMessage: async (message) => {
        sentMessages.push(message);
        return typeof sendMessage === "function" ? sendMessage(message) : undefined;
      },
    },
    storage: {
      session: {
        get: async () => ({}),
        set: async () => undefined,
      },
    },
  };
}

function fields(values) {
  return Object.entries(values)
    .map(([label, value]) => `<div class="fd-field-item"><span class="fd-field-lable">${label}</span><span class="fd-field-value">${value}</span></div>`)
    .join("");
}

function caseRow({ status, name, type, values }) {
  return `<div class="fd-case-item">
    <div class="fd-header-status">${status}</div>
    <div class="fd-header-ajmc">${name}</div>
    <div class="fd-header-ajlx">${type}</div>
    ${fields(values)}
  </div>`;
}

function myCasePage({ rows, placeholderSearch = false }) {
  return `<div class="fd-header-operate"><div class="fd-user-name">PLATFORM-ACCOUNT</div></div>
    <div class="fd-com-list-container">${rows}</div>
    <div class="fd-com-search">${placeholderSearch ? '<div class="uni-searchbar__box"><span>请输入案号、案件名称、法院查询</span></div>' : '<input type="text">'}</div>
    <button class="fd-com-search-btn">查询</button>`;
}

function wslaPage(rows) {
  return `<div class="fd-header-operate"><div class="fd-user-name">PLATFORM-ACCOUNT</div></div>${rows}`;
}

async function loadContent({ placeholderSearch = false, runtimeSendMessage } = {}) {
  const initialRows = caseRow({
    status: "已立案",
    name: "SYNTHETIC SOURCE TITLE",
    type: "民事一审案件",
    values: {
      参与人: "原告：SYNTHETIC PLAINTIFF；被告：SYNTHETIC DEFENDANT",
      案由: "SYNTHETIC CAUSE",
      申请日期: "2026-08-01",
    },
  });
  const dom = new JSDOM(`<!doctype html><html><body>${wslaPage(initialRows)}</body></html>`, {
    url: "https://zxfw.court.gov.cn/zxfw/#/pagesWsla/pc/list/index",
  });
  const chrome = makeChrome(runtimeSendMessage);
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.chrome = chrome;

  let searchValue = null;
  dom.window.addEventListener("hashchange", () => {
    if (dom.window.location.hash !== "#/pages/pc/case-list/index") return;
    const beforeSearchRows = caseRow({
      status: "未知状态",
      name: "BEFORE PLATFORM SEARCH",
      type: "民事一审案件",
      values: { 案号: "SYNTHETIC-IGNORE", 立案日期: "2026-08-06" },
    });
    dom.window.document.body.innerHTML = myCasePage({ rows: beforeSearchRows, placeholderSearch });
    if (placeholderSearch) {
      dom.window.document.querySelector(".uni-searchbar__box").addEventListener("click", () => {
        dom.window.setTimeout(() => {
          dom.window.document.querySelector(".fd-com-search").innerHTML = '<input type="text">';
        }, 0);
      });
    }
    dom.window.document.querySelector(".fd-com-search-btn").addEventListener("click", () => {
      searchValue = dom.window.document.querySelector(".fd-com-search input").value;
      const matchedRow = caseRow({
        status: "审理中",
        name: "SYNTHETIC SOURCE TITLE",
        type: "民事一审案件",
        values: { 案号: "SYNTHETIC-LI-001", 立案日期: "2026-08-07" },
      });
      dom.window.document.querySelector(".fd-com-list-container").innerHTML = matchedRow;
    });
  });

  await import(`../extension/content/court-content.js?platform-discovery-test=${importSequence++}`);
  return { dom, chrome, readSearchValue: () => searchValue };
}

async function loadDuplicateCivilContent() {
  const title = "SYNTHETIC DUPLICATE TITLE";
  const identity = {
    参与人: "原告：SYNTHETIC PLAINTIFF；被告：SYNTHETIC DEFENDANT",
    案由: "SYNTHETIC CAUSE",
  };
  const initialRows = [
    caseRow({
      status: "审核不通过",
      name: title,
      type: "民事一审案件",
      values: { ...identity, 申请日期: "2026-08-01" },
    }),
    caseRow({
      status: "审核通过",
      name: title,
      type: "民事一审案件",
      values: { ...identity, 申请日期: "2026-08-07" },
    }),
  ].join("");
  const dom = new JSDOM(`<!doctype html><html><body>${wslaPage(initialRows)}</body></html>`, {
    url: "https://zxfw.court.gov.cn/zxfw/#/pagesWsla/pc/list/index",
  });
  const chrome = makeChrome();
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.chrome = chrome;

  dom.window.addEventListener("hashchange", () => {
    if (dom.window.location.hash !== "#/pages/pc/case-list/index") return;
    dom.window.document.body.innerHTML = myCasePage({ rows: caseRow({
      status: "未知状态",
      name: "BEFORE PLATFORM SEARCH",
      type: "民事一审案件",
      values: { 案号: "SYNTHETIC-IGNORE", 立案日期: "2026-08-06" },
    }) });
    dom.window.document.querySelector(".fd-com-search-btn").addEventListener("click", () => {
      const results = [
        caseRow({
          status: "审理中",
          name: title,
          type: "民事一审案件",
          values: { 案号: "SYNTHETIC-LI-OLD", 立案日期: "2026-08-02" },
        }),
        caseRow({
          status: "审理中",
          name: title,
          type: "民事一审案件",
          values: { 案号: "SYNTHETIC-LI-LATEST", 立案日期: "2026-08-09" },
        }),
      ].join("");
      dom.window.document.querySelector(".fd-com-list-container").innerHTML = results;
    });
  });

  await import(`../extension/content/court-content.js?platform-duplicate-test=${importSequence++}`);
  return { dom, chrome };
}

async function loadEnforcementList({ status = "已立案", myCase = false, keepSearchResult = false } = {}) {
  const title = "SYNTHETIC ENFORCEMENT TITLE";
  const executionRow = caseRow({
    status,
    name: title,
    type: "首次执行案件",
    values: {
      参与人: "申请执行人：SYNTHETIC APPLICANT；被执行人：SYNTHETIC RESPONDENT",
      案由: "SYNTHETIC ENFORCEMENT CAUSE",
      申请日期: "2026-08-01",
      案号: "SYNTHETIC-QZ-001",
      立案日期: "2026-08-07",
    },
  });
  const dom = new JSDOM(`<!doctype html><html><body>${myCase ? myCasePage({ rows: executionRow }) : wslaPage(executionRow)}</body></html>`, {
    url: `https://zxfw.court.gov.cn/zxfw/#/${myCase ? "pages/pc/case-list/index" : "pagesWsla/pc/list/index"}`,
  });
  const chrome = makeChrome();
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.chrome = chrome;
  if (myCase) {
    dom.window.document.querySelector(".fd-com-search-btn").addEventListener("click", () => {
      if (!keepSearchResult) throw new Error("test setup must replace the synthetic search result");
      dom.window.document.querySelector(".fd-com-list-container").innerHTML = executionRow;
    });
  }
  await import(`../extension/content/court-content.js?platform-discovery-qz-test=${importSequence++}`);
  return { dom, chrome, title, executionRow };
}

async function dispatch(listener, message) {
  let response;
  const keepAlive = listener(message, {}, (value) => { response = value; });
  assert.equal(keepAlive, true);
  const deadline = Date.now() + 5000;
  while (response === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.notEqual(response, undefined, "content command should reply");
  return response;
}

test("QUERY_LI 优先调用结构化 layy API；API 与 DOM 签名不一致时转人工", async () => {
  await db.resetDb();
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 250 ? 0 : delay, ...args);
  const { dom, chrome } = await loadContent({
    runtimeSendMessage: async (message) => {
      if (message?.type !== "QUERY_API_REQUEST") return undefined;
      if (message.path.includes("/ajlist")) {
        return {
          ok: true,
          status: 200,
          data: {
            data: {
              total: 1,
              data: [{
                csfid: "SYNTHETIC-ACCOUNT-ID",
                nfydm: "SYNTHETIC-COURT-ID",
                cywlx: "SYNTHETIC-TYPE-ID",
                claay: "SYNTHETIC CAUSE",
                clarq: "2026-08-07",
                cajmc: "SYNTHETIC PLAINTIFF与SYNTHETIC EXTRA,SYNTHETIC DEFENDANTSYNTHETIC CAUSE一案",
                cah: "SYNTHETIC-LI-API-001",
              }],
            },
          },
        };
      }
      return message.path.includes("/count")
        ? { ok: true, status: 200, data: { data: 1 } }
        : { ok: true, status: 200, data: { data: [{ id: "SYNTHETIC-API-ID", zt: "11800007-4", ajmc: "DIFFERENT API TITLE", dsrMc: "原告：SYNTHETIC PLAINTIFF；被告：SYNTHETIC DEFENDANT", laay: "SYNTHETIC CAUSE", tjsj: "2026-08-01" }] } };
    },
  });
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_LI",
      queryMode: "platform_discovery",
      platformAccountId: "00000000-0000-4000-8000-000000000099",
    });
    const bridgeCalls = chrome.sentMessages.filter(({ type }) => type === "QUERY_API_REQUEST");
    assert.ok(bridgeCalls.length >= 1, "QUERY_LI must call the MAIN-world query bridge before DOM fallback");
    assert.ok(bridgeCalls.some(({ path }) => path.includes("/layy")));
    assert.equal(response.ok, false);
    assert.equal(response.error === "UNKNOWN" || response.error === "API_DOM_MISMATCH", true);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    cleanup(dom);
    await db.resetDb();
  }
});

test("QUERY_LI 仅在 API 与 DOM 五字段双向唯一匹配后继续采集", async () => {
  await db.resetDb();
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeWarn = console.warn;
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 250 ? 0 : delay, ...args);
  console.warn = (...args) => {
    if (args[0] === "[court-helper] 行截图失败") return;
    nativeWarn(...args);
  };
  const { dom, chrome } = await loadContent({
    runtimeSendMessage: async (message) => {
      if (message?.type !== "QUERY_API_REQUEST") return undefined;
      if (message.path.includes("/ajlist")) {
        return {
          ok: true,
          status: 200,
          data: {
            data: {
              total: 1,
              data: [{
                csfid: "SYNTHETIC-ACCOUNT-ID",
                nfydm: "SYNTHETIC-COURT-ID",
                cywlx: "SYNTHETIC-TYPE-ID",
                claay: "SYNTHETIC CAUSE",
                clarq: "2026-08-07",
                cajmc: "SYNTHETIC PLAINTIFF与SYNTHETIC EXTRA,SYNTHETIC DEFENDANTSYNTHETIC CAUSE一案",
                cah: "SYNTHETIC-LI-API-001",
              }],
            },
          },
        };
      }
      return message.path.includes("/count")
        ? { ok: true, status: 200, data: { data: 1 } }
        : {
          ok: true,
          status: 200,
          data: {
            data: [{
              id: "SYNTHETIC-API-ID",
              zt: "11800007-4",
              ajmc: "SYNTHETIC SOURCE TITLE",
              dsrMc: "原告：SYNTHETIC PLAINTIFF；被告：SYNTHETIC DEFENDANT",
              laay: "SYNTHETIC CAUSE",
              laayMz: "NOT THE DOM CAUSE",
              tjsj: "2026-08-01T08:00:00Z",
              sfBh: "SYNTHETIC-ACCOUNT-ID",
              fyid: "SYNTHETIC-COURT-ID",
              ajlx: "SYNTHETIC-TYPE-ID",
              updateTime: "2026-08-07T09:00:00Z",
              platformMetadata: "allowed",
            }],
          },
        };
    },
  });
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_LI",
      queryMode: "platform_discovery",
      platformAccountId: "00000000-0000-4000-8000-000000000098",
    });
    assert.notEqual(response.error, "API_DOM_MISMATCH");
    const records = await db.query(db.STORE_CASES, {
      account: "PLATFORM-ACCOUNT",
      platformAccountId: "00000000-0000-4000-8000-000000000098",
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].caseNumber, "SYNTHETIC-LI-API-001");
    assert.equal(dom.window.location.hash, "#/pagesWsla/pc/list/index");
  } finally {
    console.warn = nativeWarn;
    globalThis.setTimeout = nativeSetTimeout;
    cleanup(dom);
    await db.resetDb();
  }
});

test("QUERY_LI 在我的案件路由失败关闭且不调用接口或页面搜索", async () => {
  await db.resetDb();
  const { dom, chrome, readSearchValue } = await loadContent({
    runtimeSendMessage: async (message) => {
      if (message?.type === "QUERY_API_REQUEST") {
        throw new Error("QUERY_LI must not request APIs from the my-case route");
      }
      return undefined;
    },
  });
  try {
    dom.window.location.hash = "#/pages/pc/case-list/index";
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_LI",
      queryMode: "platform_discovery",
      platformAccountId: "00000000-0000-4000-8000-000000000097",
    });

    assert.equal(response.ok, false);
    assert.equal(response.error, "ONLINE_FILING_PAGE_REQUIRED");
    assert.equal(dom.window.location.hash, "#/pages/pc/case-list/index");
    assert.equal(readSearchValue(), null);
    assert.equal(chrome.sentMessages.filter(({ type }) => type === "QUERY_API_REQUEST").length, 0);
  } finally {
    cleanup(dom);
    await db.resetDb();
  }
});

function cleanup(dom) {
  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.location;
  delete globalThis.chrome;
}

test("QUERY_LI 缺少结构化接口桥时失败关闭且不跳转我的案件", async () => {
  await db.resetDb();
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeWarn = console.warn;
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 250 ? 0 : delay, ...args);
  console.warn = (...args) => {
    if (args[0] === "[court-helper] 行截图失败") return;
    nativeWarn(...args);
  };
  const { dom, chrome, readSearchValue } = await loadContent({ placeholderSearch: true });
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_LI",
      queryMode: "platform_discovery",
      platformAccountId: "00000000-0000-4000-8000-000000000010",
    });

    assert.equal(readSearchValue(), null);
    assert.equal(response.error, "BRIDGE_UNAVAILABLE");
    assert.equal(dom.window.location.hash, "#/pagesWsla/pc/list/index");
    const records = await db.query(db.STORE_CASES, {
      account: "PLATFORM-ACCOUNT",
      platformAccountId: "00000000-0000-4000-8000-000000000010",
    });
    assert.equal(records.length, 0);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    console.warn = nativeWarn;
    cleanup(dom);
    await db.resetDb();
  }
});

test("QUERY_LI 不以 DOM 同标题重传结果代替结构化接口", async () => {
  await db.resetDb();
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeWarn = console.warn;
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 250 ? 0 : delay, ...args);
  console.warn = (...args) => {
    if (args[0] === "[court-helper] 行截图失败") return;
    nativeWarn(...args);
  };
  const { dom, chrome } = await loadDuplicateCivilContent();
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_LI",
      queryMode: "platform_discovery",
      platformAccountId: "00000000-0000-4000-8000-000000000030",
    });
    assert.equal(response.error, "BRIDGE_UNAVAILABLE");
    assert.equal(dom.window.location.hash, "#/pagesWsla/pc/list/index");
    const records = await db.query(db.STORE_CASES, {
      account: "PLATFORM-ACCOUNT",
      platformAccountId: "00000000-0000-4000-8000-000000000030",
    });
    assert.equal(records.length, 0);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    console.warn = nativeWarn;
    cleanup(dom);
    await db.resetDb();
  }
});

test("my-case evidence phase rejects the discovery route without changing its baseline", async () => {
  await db.resetDb();
  const platformAccountId = "00000000-0000-4000-8000-000000000027";
  const { dom, chrome } = await loadEnforcementList();
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_LI",
      queryMode: "platform_discovery",
      queryPhase: "mycase_evidence",
      platformAccountId,
    });

    assert.equal(response.ok, false);
    assert.equal(response.error, "MYCASE_PAGE_REQUIRED");
    assert.equal((await db.query(db.STORE_CASES, { account: "PLATFORM-ACCOUNT", platformAccountId })).length, 0);
  } finally {
    cleanup(dom);
    await db.resetDb();
  }
});

test("my-case evidence preserves an existing UNKNOWN baseline as manual required", async () => {
  await db.resetDb();
  const platformAccountId = "00000000-0000-4000-8000-000000000026";
  await db.upsertByUid(db.STORE_ENFORCEMENT, "qz-existing-unknown", {
    uid: "qz-existing-unknown",
    account: "PLATFORM-ACCOUNT",
    platformAccountId,
    kind: "qz",
    plaintiff: "SYNTHETIC APPLICANT",
    defendant: "SYNTHETIC RESPONDENT",
    sourceCaseName: "UNKNOWN SOURCE TITLE",
    status: "UNKNOWN",
    needsHuman: true,
    errorCode: "UNKNOWN",
  });
  const { dom, chrome } = await loadEnforcementList({ myCase: true, keepSearchResult: true });
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_QZ",
      queryMode: "platform_discovery",
      platformAccountId,
    });

    assert.equal(response.ok, false);
    assert.equal(response.error, "UNKNOWN");
    assert.equal((await db.getByUid(db.STORE_ENFORCEMENT, "qz-existing-unknown"))?.needsHuman, true);
  } finally {
    cleanup(dom);
    await db.resetDb();
  }
});

test("my-case evidence retains a prior screenshot failure after successful F/G completion", async () => {
  await db.resetDb();
  const platformAccountId = "00000000-0000-4000-8000-000000000028";
  const uid = "qz-existing-screenshot-failure";
  await db.upsertByUid(db.STORE_ENFORCEMENT, uid, {
    uid,
    account: "PLATFORM-ACCOUNT",
    platformAccountId,
    kind: "qz",
    plaintiff: "SYNTHETIC APPLICANT",
    defendant: "SYNTHETIC RESPONDENT",
    sourceCaseName: "SYNTHETIC ENFORCEMENT TITLE",
    status: "强执成功",
    needsHuman: true,
    errorCode: "SCREENSHOT_CAPTURE_FAILED",
  });
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 250 ? 0 : delay, ...args);
  const { dom, chrome } = await loadEnforcementList({ status: "已结案", myCase: true, keepSearchResult: true });
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_QZ",
      queryMode: "platform_discovery",
      platformAccountId,
    });

    const record = await db.getByUid(db.STORE_ENFORCEMENT, uid);
    assert.equal(response.ok, false);
    assert.equal(response.error, "SCREENSHOT_CAPTURE_FAILED");
    assert.equal(record.caseNumber, "SYNTHETIC-QZ-001");
    assert.equal(record.filedTime, "2026-08-07");
    assert.equal(record.needsHuman, true);
    assert.equal(record.errorCode, "SCREENSHOT_CAPTURE_FAILED");
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    cleanup(dom);
    await db.resetDb();
  }
});

test("my-case evidence failure retains a prior screenshot failure instead of replacing its code", async () => {
  await db.resetDb();
  const platformAccountId = "00000000-0000-4000-8000-000000000029";
  const uid = "qz-existing-screenshot-failure-no-match";
  await db.upsertByUid(db.STORE_ENFORCEMENT, uid, {
    uid,
    account: "PLATFORM-ACCOUNT",
    platformAccountId,
    kind: "qz",
    plaintiff: "SYNTHETIC APPLICANT",
    defendant: "SYNTHETIC RESPONDENT",
    sourceCaseName: "SYNTHETIC TITLE THAT MUST NOT MATCH",
    status: "强执成功",
    needsHuman: true,
    errorCode: "SCREENSHOT_CAPTURE_FAILED",
  });
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 250 ? 0 : delay, ...args);
  const { dom, chrome } = await loadEnforcementList({ status: "已结案", myCase: true, keepSearchResult: true });
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_QZ",
      queryMode: "platform_discovery",
      platformAccountId,
    });

    const record = await db.getByUid(db.STORE_ENFORCEMENT, uid);
    assert.equal(response.ok, false);
    assert.equal(response.error, "SCREENSHOT_CAPTURE_FAILED");
    assert.equal(record.caseNumber, undefined);
    assert.equal(record.filedTime, undefined);
    assert.equal(record.needsHuman, true);
    assert.equal(record.errorCode, "SCREENSHOT_CAPTURE_FAILED");
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    cleanup(dom);
    await db.resetDb();
  }
});

test("强执平台发现：执行列表首轮有待补 F/G 的成功记录时，提示进入我的案件而不是误报执行 tab", async () => {
  await db.resetDb();
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeWarn = console.warn;
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 250 ? 0 : delay, ...args);
  console.warn = (...args) => {
    if (args[0] === "[court-helper] 行截图失败") return;
    nativeWarn(...args);
  };
  const { dom, chrome } = await loadEnforcementList();
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_QZ",
      queryMode: "platform_discovery",
      platformAccountId: "00000000-0000-4000-8000-000000000020",
    });

    assert.equal(response.ok, false);
    assert.equal(response.error, "SCREENSHOT_CAPTURE_FAILED");
    assert.notEqual(response.error, "EXECUTION_TAB_REQUIRED");
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    console.warn = nativeWarn;
    cleanup(dom);
    await db.resetDb();
  }
});

test("强执平台发现：UNKNOWN 即使没有待补 F/G 也必须转人工", async () => {
  await db.resetDb();
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 250 ? 0 : delay, ...args);
  const { dom, chrome } = await loadEnforcementList({ status: "未知状态" });
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_QZ",
      queryMode: "platform_discovery",
      platformAccountId: "00000000-0000-4000-8000-000000000021",
    });

    assert.equal(response.ok, false);
    assert.equal(response.error, "NEEDS_HUMAN");
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    cleanup(dom);
    await db.resetDb();
  }
});

test("我的案件页没有本地发现基线时不得把零补证回写成功", async () => {
  await db.resetDb();
  const platformAccountId = "00000000-0000-4000-8000-000000000024";
  const { dom, chrome } = await loadEnforcementList({ myCase: true, keepSearchResult: true });
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_QZ",
      queryMode: "platform_discovery",
      platformAccountId,
    });
    assert.equal(response.ok, false);
    assert.equal(response.error, "DISCOVERY_BASELINE_MISSING");
  } finally {
    cleanup(dom);
    await db.resetDb();
  }
});

test("网上立案页零可见行时不清空旧记录且不得回写成功", async () => {
  await db.resetDb();
  const platformAccountId = "00000000-0000-4000-8000-000000000025";
  const uid = "preserved-visible-baseline";
  await db.upsertByUid(db.STORE_CASES, uid, {
    uid,
    account: "PLATFORM-ACCOUNT",
    platformAccountId,
    kind: "li",
    plaintiff: "SYNTHETIC PLAINTIFF",
    defendant: "SYNTHETIC DEFENDANT",
    status: "审核中",
  });
  const dom = new JSDOM("<!doctype html><html><body><div class=\"fd-header-operate\"><div class=\"fd-user-name\">PLATFORM-ACCOUNT</div></div></body></html>", {
    url: "https://zxfw.court.gov.cn/zxfw/#/pagesWsla/pc/list/index",
  });
  const chrome = makeChrome();
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.chrome = chrome;
  await import(`../extension/content/court-content.js?platform-discovery-empty-test=${importSequence++}`);
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_LI",
      queryMode: "platform_discovery",
      platformAccountId,
    });
    assert.equal(response.ok, false);
    assert.equal(response.error, "NO_VISIBLE_CASES");
    assert.equal((await db.getByUid(db.STORE_CASES, uid))?.status, "审核中");
  } finally {
    cleanup(dom);
    await db.resetDb();
  }
});

test("我的案件执行 tab：第二次强执任务只补 F/G，搜索结果前后相同也不重建发现记录", async () => {
  await db.resetDb();
  const platformAccountId = "00000000-0000-4000-8000-000000000022";
  const targetUid = "qz-existing-target";
  const unrelatedUid = "qz-existing-unrelated";
  await db.upsertByUid(db.STORE_ENFORCEMENT, targetUid, {
    uid: targetUid,
    account: "PLATFORM-ACCOUNT",
    platformAccountId,
    kind: "qz",
    plaintiff: "SYNTHETIC APPLICANT",
    defendant: "SYNTHETIC RESPONDENT",
    sourceCaseName: "SYNTHETIC ENFORCEMENT TITLE",
    status: "强执成功",
    needsHuman: false,
    successImage: "data:image/png;base64,synthetic",
  });
  await db.upsertByUid(db.STORE_ENFORCEMENT, unrelatedUid, {
    uid: unrelatedUid,
    account: "PLATFORM-ACCOUNT",
    platformAccountId,
    kind: "qz",
    plaintiff: "UNCHANGED APPLICANT",
    defendant: "UNCHANGED RESPONDENT",
    sourceCaseName: "UNRELATED TITLE",
    status: "已驳回",
  });
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 250 ? 0 : delay, ...args);
  const { dom, chrome } = await loadEnforcementList({ status: "已结案", myCase: true, keepSearchResult: true });
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_QZ",
      queryMode: "platform_discovery",
      platformAccountId,
    });

    assert.equal(response.ok, true);
    assert.equal(response.evidence.completed, 1);
    const records = await db.query(db.STORE_ENFORCEMENT, { account: "PLATFORM-ACCOUNT", platformAccountId });
    assert.equal(records.length, 2);
    assert.match(records.find((record) => record.uid === targetUid)?.successImage ?? "", /^data:image\/png/);
    assert.equal(records.find((record) => record.uid === targetUid)?.caseNumber, "SYNTHETIC-QZ-001");
    assert.equal(records.find((record) => record.uid === targetUid)?.filedTime, "2026-08-07");
    assert.equal(records.find((record) => record.uid === targetUid)?.needsHuman, false);
    assert.equal(records.find((record) => record.uid === unrelatedUid)?.plaintiff, "UNCHANGED APPLICANT");
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    cleanup(dom);
    await db.resetDb();
  }
});

test("我的案件执行 tab：异步搜索变为多条结果时，不得使用搜索前的旧行补 F/G", async () => {
  await db.resetDb();
  const platformAccountId = "00000000-0000-4000-8000-000000000023";
  const targetUid = "qz-stale-search-target";
  await db.upsertByUid(db.STORE_ENFORCEMENT, targetUid, {
    uid: targetUid,
    account: "PLATFORM-ACCOUNT",
    platformAccountId,
    kind: "qz",
    plaintiff: "SYNTHETIC APPLICANT",
    defendant: "SYNTHETIC RESPONDENT",
    sourceCaseName: "SYNTHETIC ENFORCEMENT TITLE",
    status: "强执成功",
    needsHuman: false,
    successImage: "data:image/png;base64,synthetic",
  });
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 250 ? 0 : delay, ...args);
  const { dom, chrome, executionRow } = await loadEnforcementList({ status: "已结案", myCase: true, keepSearchResult: true });
  dom.window.document.querySelector(".fd-com-search-btn").addEventListener("click", () => {
    dom.window.document.querySelector(".fd-com-list-container").innerHTML = `${executionRow}${executionRow}`;
  });
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_QZ",
      queryMode: "platform_discovery",
      platformAccountId,
    });

    assert.equal(response.ok, false);
    assert.equal(response.error, "MYCASE_EVIDENCE_AMBIGUOUS");
    const record = await db.getByUid(db.STORE_ENFORCEMENT, targetUid);
    assert.equal(record.caseNumber, undefined);
    assert.equal(record.filedTime, undefined);
    assert.equal(record.errorCode, "MYCASE_EVIDENCE_AMBIGUOUS");
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    cleanup(dom);
    await db.resetDb();
  }
});
