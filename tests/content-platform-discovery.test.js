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
        const response = typeof sendMessage === "function" ? await sendMessage(message) : undefined;
        if (response !== undefined) return response;
        if (message?.type === "CASE_SYNC_ENQUEUE") {
          return {
            ok: true,
            status: "sent",
            clientMutationId: message.event?.clientMutationId,
          };
        }
        return undefined;
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
  return `<div class="fd-header-operate"><div class="fd-user-name">PLATFORM-ACCOUNT</div></div><div class="fd-com-list-container">${rows}</div>`;
}

async function loadContent({ placeholderSearch = false, runtimeSendMessage, initialRows: suppliedRows = null } = {}) {
  const initialRows = suppliedRows ?? caseRow({
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

async function loadEnforcementList({ status = "已立案", myCase = false, keepSearchResult = false, runtimeSendMessage } = {}) {
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
  const chrome = makeChrome(runtimeSendMessage);
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

async function dispatch(listener, message, timeoutMs = 5000) {
  let response;
  const keepAlive = listener(message, {}, (value) => { response = value; });
  assert.equal(keepAlive, true);
  const deadline = Date.now() + timeoutMs;
  while (response === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.notEqual(response, undefined, "content command should reply");
  return response;
}

test("PING only reports browser command readiness after the panel and list controls are mounted", async () => {
  const { dom, chrome } = await loadContent();
  const listener = chrome.listeners.at(-1);
  let response;
  listener({ type: "PING" }, {}, (value) => { response = value; });
  assert.equal(response?.ok, true);
  assert.equal(response?.ready, false);

  dom.window.document.body.insertAdjacentHTML("beforeend", `<div class="fd-com-tab"><span>${"\u5ba1\u5224"}</span><span>${"\u6267\u884c"}</span></div><button class="fd-com-search-btn">${"\u67e5\u8be2"}</button>`);
  const searchButton = dom.window.document.querySelector(".fd-com-search-btn");
  searchButton.hidden = true;
  listener({ type: "PING" }, {}, (value) => { response = value; });
  assert.equal(response?.ready, false);
  searchButton.hidden = false;
  searchButton.setAttribute("aria-disabled", "true");
  listener({ type: "PING" }, {}, (value) => { response = value; });
  assert.equal(response?.ready, false);
  searchButton.removeAttribute("aria-disabled");
  dom.window.document.querySelector(".fd-com-tab span:last-child").remove();
  listener({ type: "PING" }, {}, (value) => { response = value; });
  assert.equal(response?.ready, false);
  dom.window.document.querySelector(".fd-com-tab").insertAdjacentHTML("beforeend", `<span>${"\u6267\u884c"}</span>`);
  dom.window.location.hash = "#/pagesWsla/pc/list/index?case=synthetic";
  listener({ type: "PING" }, {}, (value) => { response = value; });
  assert.equal(response?.ready, true);
  assert.equal(response?.route, "#/pagesWsla/pc/list/index");
  await db.resetDb();
});

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
                nfydm: "SYNTHETIC-TARGET-COURT-CODE",
                cfydmTranslateText: "SYNTHETIC COURT",
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

test("QUERY_LI 首次 API-DOM 不一致时等待 SPA 二次渲染并复核新快照", async () => {
  await db.resetDb();
  let domRef;
  let listReads = 0;
  const stableRow = caseRow({
    status: "待审核",
    name: "SYNTHETIC STABLE TITLE",
    type: "民事一审案件",
    values: {
      参与人: "原告：SYNTHETIC PLAINTIFF；被告：SYNTHETIC DEFENDANT",
      案由: "SYNTHETIC CAUSE",
      申请日期: "2026-08-09",
    },
  });
  const { dom, chrome } = await loadContent({
    runtimeSendMessage: async (message) => {
      if (message?.type !== "QUERY_API_REQUEST") return undefined;
      if (message.path.includes("/count")) return { ok: true, status: 200, data: { data: 1 } };
      if (message.path.includes("/layy")) {
        listReads += 1;
        if (listReads === 1) {
          domRef.window.setTimeout(() => {
            domRef.window.document.querySelector(".fd-com-list-container").innerHTML = stableRow;
          }, 50);
        }
        return {
          ok: true,
          status: 200,
          data: { data: [{
            id: "SYNTHETIC-STABLE-ID",
            zt: "11800007-1",
            ajmc: "SYNTHETIC STABLE TITLE",
            dsrMc: "原告：SYNTHETIC PLAINTIFF；被告：SYNTHETIC DEFENDANT",
            laay: "SYNTHETIC CAUSE",
            tjsj: "2026-08-09T08:00:00Z",
          }] },
        };
      }
      return undefined;
    },
  });
  domRef = dom;
  const nativeRandom = Math.random;
  Math.random = () => 0;
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_LI",
      queryMode: "platform_discovery",
      platformAccountId: "00000000-0000-4000-8000-000000000096",
    }, 12_000);
    assert.notEqual(response.error, "API_DOM_MISMATCH");
    assert.equal(listReads, 2);
  } finally {
    Math.random = nativeRandom;
    cleanup(dom);
    await db.resetDb();
  }
});

test("QUERY_QZ 对残留审判卡片先执行结构化复核而非提前报执行分类错误", async () => {
  await db.resetDb();
  const { dom, chrome } = await loadContent({
    runtimeSendMessage: async (message) => {
      if (message?.type !== "QUERY_API_REQUEST") return undefined;
      return message.path.includes("/count")
        ? { ok: true, status: 200, data: { data: 1 } }
        : { ok: true, status: 200, data: { data: [{
          id: "SYNTHETIC-QZ-TRANSITION-ID",
          zt: "11800007-1",
          ajmc: "SYNTHETIC EXECUTION TITLE",
          dsrMc: "申请执行人：SYNTHETIC APPLICANT；被执行人：SYNTHETIC RESPONDENT",
          laay: "SYNTHETIC EXECUTION CAUSE",
          tjsj: "2026-08-09",
        }] } };
    },
  });
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_QZ",
      queryMode: "platform_discovery",
      platformAccountId: "00000000-0000-4000-8000-000000000095",
    });
    assert.equal(response.error, "API_DOM_MISMATCH");
  } finally {
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
                nfydm: "SYNTHETIC-TARGET-COURT-CODE",
                cfydmTranslateText: "SYNTHETIC COURT",
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
              fyid: "SYNTHETIC-SOURCE-COURT-ID",
              fymc: "SYNTHETIC COURT",
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

test("QUERY_LI 混合列表跳过未批准状态且只建档批准状态行", async () => {
  await db.resetDb();
  const platformAccountId = "00000000-0000-4000-8000-000000000041";
  const initialRows = [
    caseRow({
      status: "待提交",
      name: "名称暂无",
      type: "民事一审案件",
      values: { 参与人: "", 案由: "", 申请日期: "" },
    }),
    caseRow({
      status: "待审核",
      name: "SYNTHETIC APPROVED TITLE",
      type: "民事一审案件",
      values: {
        参与人: "原告：SYNTHETIC PLAINTIFF；被告：SYNTHETIC DEFENDANT",
        案由: "SYNTHETIC CAUSE",
        申请日期: "2026-08-11",
      },
    }),
  ].join("");
  const { dom, chrome } = await loadContent({
    initialRows,
    runtimeSendMessage: async (message) => {
      if (message?.type !== "QUERY_API_REQUEST") return undefined;
      return message.path.includes("/count")
        ? { ok: true, status: 200, data: { data: 2 } }
        : { ok: true, status: 200, data: { data: [
          { zt: "11800007-100" },
          {
            id: "SYNTHETIC-APPROVED-ID",
            zt: "11800007-1",
            ajmc: "SYNTHETIC APPROVED TITLE",
            dsrMc: "原告：SYNTHETIC PLAINTIFF；被告：SYNTHETIC DEFENDANT",
            laay: "SYNTHETIC CAUSE",
            tjsj: "2026-08-11",
          },
        ] } };
    },
  });
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_LI",
      queryMode: "platform_discovery",
      platformAccountId,
    });

    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.stats.total, 1);
    const records = await db.query(db.STORE_CASES, { account: "PLATFORM-ACCOUNT", platformAccountId });
    assert.equal(records.length, 1);
    assert.equal(records[0].sourceCaseName, "SYNTHETIC APPROVED TITLE");
    assert.equal(records[0].status, "审核中");
  } finally {
    cleanup(dom);
    await db.resetDb();
  }
});

test("QUERY_LI 原始列表全为未批准状态时确认零行并清理旧记录", async () => {
  await db.resetDb();
  const platformAccountId = "00000000-0000-4000-8000-000000000042";
  await db.upsertByUid(db.STORE_CASES, "SYNTHETIC-OLD-UID", {
    uid: "SYNTHETIC-OLD-UID",
    account: "PLATFORM-ACCOUNT",
    platformAccountId,
    plaintiff: "SYNTHETIC OLD PLAINTIFF",
    defendant: "SYNTHETIC OLD DEFENDANT",
    status: "审核中",
  });
  const initialRows = caseRow({
    status: "待提交",
    name: "名称暂无",
    type: "民事一审案件",
    values: { 参与人: "", 案由: "", 申请日期: "" },
  });
  const { dom, chrome } = await loadContent({
    initialRows,
    runtimeSendMessage: async (message) => {
      if (message?.type !== "QUERY_API_REQUEST") return undefined;
      return message.path.includes("/count")
        ? { ok: true, status: 200, data: { data: 1 } }
        : { ok: true, status: 200, data: { data: [{ zt: "11800007-100" }] } };
    },
  });
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_LI",
      queryMode: "platform_discovery",
      platformAccountId,
    });

    assert.deepEqual(response, { ok: true, stats: { total: 0, completed: 0, needsHuman: 0 } });
    assert.equal((await db.query(db.STORE_CASES, { account: "PLATFORM-ACCOUNT", platformAccountId })).length, 0);
  } finally {
    cleanup(dom);
    await db.resetDb();
  }
});

test("legacy my-case evidence phase no longer bypasses the normal structured query path", async () => {
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
    assert.equal(response.error, "BRIDGE_UNAVAILABLE");
    assert.equal((await db.query(db.STORE_CASES, { account: "PLATFORM-ACCOUNT", platformAccountId })).length, 0);
  } finally {
    cleanup(dom);
    await db.resetDb();
  }
});

test("我的案件页不得继续处理既有 UNKNOWN 强执基线", async () => {
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
    assert.equal(response.error, "ONLINE_FILING_PAGE_REQUIRED");
    assert.equal((await db.getByUid(db.STORE_ENFORCEMENT, "qz-existing-unknown"))?.needsHuman, true);
  } finally {
    cleanup(dom);
    await db.resetDb();
  }
});

test("我的案件页不得补写既有截图失败强执记录的 F/G", async () => {
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
    assert.equal(response.error, "ONLINE_FILING_PAGE_REQUIRED");
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

test("我的案件页拒绝旧补证请求时保留原截图失败错误", async () => {
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
    assert.equal(response.error, "ONLINE_FILING_PAGE_REQUIRED");
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

test("强执 DOM fixture 的截图失败保留具体错误而不是误报执行 tab", async () => {
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

test("强执平台发现通过 layy 与 ajlist 在网上立案页直接补全 F/G", async () => {
  await db.resetDb();
  const calls = [];
  const throttleDelays = [];
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeRandom = Math.random;
  const nativeWarn = console.warn;
  Math.random = () => 0;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 3000) throttleDelays.push(delay);
    return nativeSetTimeout(callback, delay >= 250 ? 0 : delay, ...args);
  };
  console.warn = (...args) => {
    if (args[0] === "[court-helper] 行截图失败") return;
    nativeWarn(...args);
  };
  const platformAccountId = "00000000-0000-4000-8000-000000000031";
  const { dom, chrome } = await loadEnforcementList({
    status: "审核通过",
    runtimeSendMessage: async (message) => {
      if (message?.type !== "QUERY_API_REQUEST") return undefined;
      calls.push(message);
      if (message.path.includes("/ajlist")) {
        return {
          ok: true,
          status: 200,
          data: { data: { total: 1, data: [{
            csfid: "SYNTHETIC-QZ-ACCOUNT",
            cfydmTranslateText: "SYNTHETIC QZ COURT",
            cywlx: "SYNTHETIC-QZ-TYPE",
            claay: "SYNTHETIC ENFORCEMENT CAUSE",
            clarq: "2026-08-07",
            cajmc: "SYNTHETIC APPLICANT与SYNTHETIC RESPONDENTSYNTHETIC ENFORCEMENT CAUSE一案",
            cah: "SYNTHETIC-QZ-API-001",
          }] } },
        };
      }
      return message.path.includes("/count")
        ? { ok: true, status: 200, data: { data: 1 } }
        : { ok: true, status: 200, data: { data: [{
          id: "SYNTHETIC-QZ-SOURCE-ID",
          zt: "11800007-2",
          ajmc: "SYNTHETIC ENFORCEMENT TITLE",
          dsrMc: "申请执行人：SYNTHETIC APPLICANT；被执行人：SYNTHETIC RESPONDENT",
          laay: "SYNTHETIC ENFORCEMENT CAUSE",
          tjsj: "2026-08-01",
          sfBh: "SYNTHETIC-QZ-ACCOUNT",
          fymc: "SYNTHETIC QZ COURT",
          ajlx: "SYNTHETIC-QZ-TYPE",
          updateTime: "2026-08-07T08:00:00Z",
        }] } };
    },
  });
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_QZ",
      queryMode: "platform_discovery",
      platformAccountId,
    });

    assert.equal(calls.some((message) => message.path.includes("/layy/count") && message.path.includes("ajlb=zx")), true);
    assert.equal(calls.some((message) => message.path.includes("/ajlist") && message.body?.ajlb === "1501_000001-1000"), true);
    assert.notEqual(response.error, "MYCASE_PAGE_REQUIRED");
    const [record] = await db.query(db.STORE_ENFORCEMENT, { account: "PLATFORM-ACCOUNT", platformAccountId });
    assert.equal(record.status, "强执成功");
    assert.equal(record.caseNumber, "SYNTHETIC-QZ-API-001");
    assert.equal(record.filedTime, "2026-08-07");
    const syncEvents = chrome.sentMessages.filter((message) => message.type === "CASE_SYNC_ENQUEUE");
    assert.equal(syncEvents.length, 1, "each finalized case must receive a server ACK");
    assert.equal(syncEvents[0].event.payload.clientUid, record.uid);
    assert.equal(syncEvents[0].event.payload.caseNumber, "SYNTHETIC-QZ-API-001");
    assert.equal(throttleDelays.length, 0, "single case and single evidence candidate must not add trailing delays");
    assert.equal(dom.window.location.hash, "#/pagesWsla/pc/list/index");
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    Math.random = nativeRandom;
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

test("强执平台发现：DOM 状态为空时使用身份匹配后的 layy 状态继续流程", async () => {
  await db.resetDb();
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeWarn = console.warn;
  globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 250 ? 0 : delay, ...args);
  console.warn = (...args) => {
    if (args[0] === "[court-helper] 行截图失败") return;
    nativeWarn(...args);
  };
  const platformAccountId = "00000000-0000-4000-8000-000000000032";
  const { dom, chrome } = await loadEnforcementList({
    status: "",
    runtimeSendMessage: async (message) => {
      if (message?.type !== "QUERY_API_REQUEST") return undefined;
      if (message.path.includes("/ajlist")) {
        return { ok: true, status: 200, data: { data: { total: 0, data: [] } } };
      }
      return message.path.includes("/count")
        ? { ok: true, status: 200, data: { data: 1 } }
        : { ok: true, status: 200, data: { data: [{
          id: "SYNTHETIC-QZ-REJECT-ID",
          zt: "11800007-2",
          ajmc: "SYNTHETIC ENFORCEMENT TITLE",
          dsrMc: "申请执行人：SYNTHETIC APPLICANT；被执行人：SYNTHETIC RESPONDENT",
          laay: "SYNTHETIC ENFORCEMENT CAUSE",
          tjsj: "2026-08-01",
        }] } };
    },
  });
  try {
    const response = await dispatch(chrome.listeners.at(-1), {
      type: "BROWSER_COMMAND_EXECUTE",
      commandType: "QUERY_QZ",
      queryMode: "platform_discovery",
      platformAccountId,
    });

    assert.equal(response.ok, false);
    assert.equal(response.error, "SCREENSHOT_CAPTURE_FAILED");
    const [record] = await db.query(db.STORE_ENFORCEMENT, { account: "PLATFORM-ACCOUNT", platformAccountId });
    assert.equal(record.sourceStatusText, "审核通过");
    assert.equal(record.status, "强执成功");
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    console.warn = nativeWarn;
    cleanup(dom);
    await db.resetDb();
  }
});

test("我的案件页强执查询统一要求返回网上立案页", async () => {
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
    assert.equal(response.error, "ONLINE_FILING_PAGE_REQUIRED");
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

test("我的案件执行 tab 不再通过第二次强执任务补 F/G", async () => {
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

    assert.equal(response.ok, false);
    assert.equal(response.error, "ONLINE_FILING_PAGE_REQUIRED");
    const records = await db.query(db.STORE_ENFORCEMENT, { account: "PLATFORM-ACCOUNT", platformAccountId });
    assert.equal(records.length, 2);
    assert.match(records.find((record) => record.uid === targetUid)?.successImage ?? "", /^data:image\/png/);
    assert.equal(records.find((record) => record.uid === targetUid)?.caseNumber, undefined);
    assert.equal(records.find((record) => record.uid === targetUid)?.filedTime, undefined);
    assert.equal(records.find((record) => record.uid === targetUid)?.needsHuman, false);
    assert.equal(records.find((record) => record.uid === unrelatedUid)?.plaintiff, "UNCHANGED APPLICANT");
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    cleanup(dom);
    await db.resetDb();
  }
});

test("我的案件执行 tab 的旧搜索结果不再参与强执补证", async () => {
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
    assert.equal(response.error, "ONLINE_FILING_PAGE_REQUIRED");
    const record = await db.getByUid(db.STORE_ENFORCEMENT, targetUid);
    assert.equal(record.caseNumber, undefined);
    assert.equal(record.filedTime, undefined);
    assert.equal(record.errorCode, undefined);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    cleanup(dom);
    await db.resetDb();
  }
});
