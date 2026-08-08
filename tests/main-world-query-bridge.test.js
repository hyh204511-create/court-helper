import test from "node:test";
import assert from "node:assert/strict";

import {
  QUERY_API_REQUEST,
  handleMainWorldQueryRequest,
} from "../extension/sw/main-world-query-bridge.js";

const courtSender = {
  tab: {
    id: 17,
    url: "https://zxfw.court.gov.cn/zxfw/#/pagesWsla/pc/list/index",
  },
};

function jsonResponse(body, status = 200, extra = {}) {
  return {
    status,
    url: extra.url ?? "https://zxfw.court.gov.cn/yzw/yzw-zxfw-lafw/api/v3/layy",
    redirected: Boolean(extra.redirected),
    headers: { get: () => extra.contentType ?? "application/json" },
    async json() { return body; },
  };
}

function chromeHarness(fetchImpl) {
  const injections = [];
  return {
    injections,
    chromeApi: {
      scripting: {
        async executeScript(injection) {
          injections.push(injection);
          const oldFetch = globalThis.fetch;
          globalThis.fetch = fetchImpl;
          try {
            return [{ result: await injection.func(...injection.args) }];
          } finally {
            globalThis.fetch = oldFetch;
          }
        },
      },
    },
  };
}

function installPageRequestAdapter(adapter) {
  const factories = {
    synthetic_auth_module(module, exports) {
      void "zxfwtoken Authorization uni.request";
      exports.default = adapter;
    },
  };
  const cache = {};
  const requireModule = (id) => {
    if (cache[id]) return cache[id].exports;
    const module = { exports: {} };
    cache[id] = module;
    factories[id](module, module.exports, requireModule);
    return module.exports;
  };
  requireModule.m = factories;
  const chunks = [];
  chunks.push = (payload) => {
    Object.assign(factories, payload[1] ?? {});
    for (const entry of payload[2] ?? []) requireModule(entry[0]);
  };
  globalThis.webpackJsonp = chunks;
  return () => { delete globalThis.webpackJsonp; };
}

test("MAIN bridge 只允许已确认 lafw GET 与 ajfw POST 路径", async () => {
  const { chromeApi, injections } = chromeHarness(async () => jsonResponse({ data: [] }));
  for (const request of [
    { method: "GET", path: "/yzw/yzw-zxfw-lafw/api/v3/layy?ajlb=sp&page=1&limit=10" },
    { method: "GET", path: "/yzw/yzw-zxfw-lafw/api/v3/layy/count?ajlb=sp" },
    { method: "GET", path: "/yzw/yzw-zxfw-lafw/api/v3/layy/layyxq/SYNTHETIC-ID/0" },
    { method: "GET", path: "/yzw/yzw-zxfw-lafw/api/v3/pz/layymb/SYNTHETIC-FY/SYNTHETIC-LX" },
    { method: "POST", path: "/yzw/yzw-zxfw-ajfw/api/v1/ajlist", body: { pageNum: 1, pageSize: 10 } },
  ]) {
    const result = await handleMainWorldQueryRequest({
      message: { type: QUERY_API_REQUEST, ...request }, sender: courtSender, chromeApi,
    });
    assert.equal(result.ok, true, request.path);
  }
  assert.equal(injections.every((entry) => entry.world === "MAIN" && entry.target.tabId === 17), true);

  for (const request of [
    { method: "POST", path: "/yzw/yzw-zxfw-lafw/api/v3/layy" },
    { method: "GET", path: "/yzw/yzw-zxfw-ajfw/api/v1/ajlist" },
    { method: "GET", path: "/yzw/unconfirmed/api" },
    { method: "GET", path: "https://example.invalid/steal" },
    { method: "GET", path: "/yzw/yzw-zxfw-lafw/api/v3/layy/../admin" },
    { method: "GET", path: "/yzw/yzw-zxfw-lafw/api/v3/layy?ajlb=evil&limit=10" },
    { method: "GET", path: "/yzw/yzw-zxfw-lafw/api/v3/layy?ajlb=sp&ajlb=evil&limit=10" },
    { method: "GET", path: "/yzw/yzw-zxfw-lafw/api/v3/layy?ajlb=sp&limit=10&limit=999" },
    { method: "GET", path: "/yzw/yzw-zxfw-lafw/api/v3/layy?page=1&page=2" },
    { method: "GET", path: "/yzw/yzw-zxfw-lafw/api/v3/layy/layyxq/%2e%2e%2fadmin/0" },
    { method: "GET", path: "/yzw/yzw-zxfw-lafw/api/v3/layy/layyxq/%5cadmin/0" },
    { method: "GET", path: "/yzw/yzw-zxfw-lafw/api/v3/layy/layyxq/SYNTHETIC-ID/0?redirect=evil" },
    { method: "GET", path: "/yzw/yzw-zxfw-lafw/api/v3/pz/layymb/SYNTHETIC-FY/SYNTHETIC-LX?x=1" },
  ]) {
    const result = await handleMainWorldQueryRequest({
      message: { type: QUERY_API_REQUEST, ...request }, sender: courtSender, chromeApi,
    });
    assert.equal(result.ok, false, request.path);
    assert.equal(result.code, "QUERY_API_NOT_ALLOWED");
  }
});

test("MAIN bridge 允许强执 layy 与 layy/count 使用 ajlb=zx", async () => {
  const { chromeApi, injections } = chromeHarness(async () => jsonResponse({ data: [] }));

  for (const path of [
    "/yzw/yzw-zxfw-lafw/api/v3/layy?ajlb=zx&page=1&limit=50",
    "/yzw/yzw-zxfw-lafw/api/v3/layy/count?ajlb=zx&limit=50",
  ]) {
    const result = await handleMainWorldQueryRequest({
      message: { type: QUERY_API_REQUEST, method: "GET", path },
      sender: courtSender,
      chromeApi,
    });
    assert.equal(result.ok, true, path);
  }

  assert.equal(injections.length, 2);
});

test("MAIN bridge 必须由 zxfw court tab sender 调用", async () => {
  const { chromeApi, injections } = chromeHarness(async () => jsonResponse({ data: [] }));
  for (const sender of [
    {},
    { tab: { id: 17 } },
    { tab: { id: 17, url: "https://example.invalid/" } },
    { tab: { id: 17, url: "chrome-extension://synthetic/page.html" } },
  ]) {
    const result = await handleMainWorldQueryRequest({
      message: { type: QUERY_API_REQUEST, method: "GET", path: "/yzw/yzw-zxfw-lafw/api/v3/layy" },
      sender,
      chromeApi,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "QUERY_API_SENDER_REJECTED");
  }
  assert.equal(injections.length, 0);
});

test("MAIN bridge 不跟随重定向，并保留成功响应 HTTP status", async () => {
  let fetchInit;
  const { chromeApi } = chromeHarness(async (_url, init) => {
    fetchInit = init;
    return jsonResponse({ data: [] }, 207);
  });
  const success = await handleMainWorldQueryRequest({
    message: { type: QUERY_API_REQUEST, method: "GET", path: "/yzw/yzw-zxfw-lafw/api/v3/layy" },
    sender: courtSender,
    chromeApi,
  });
  assert.equal(fetchInit.redirect, "manual");
  assert.equal(success.status, 207);

  let followed = false;
  const redirectHarness = chromeHarness(async (_url, init) => {
    assert.equal(init.redirect, "manual");
    followed = false;
    return jsonResponse({}, 307, { url: "https://zxfw.court.gov.cn/login" });
  });
  const redirected = await handleMainWorldQueryRequest({
    message: {
      type: QUERY_API_REQUEST,
      method: "POST",
      path: "/yzw/yzw-zxfw-ajfw/api/v1/ajlist",
      body: { pageNum: 1, pageSize: 10 },
    },
    sender: courtSender,
    chromeApi: redirectHarness.chromeApi,
  });
  assert.equal(followed, false);
  assert.equal(redirected.code, "LOGIN_REDIRECT");
});

test("主世界 fetch 固定 credentials include，且桥响应不泄露凭据", async () => {
  let fetchInit;
  const { chromeApi } = chromeHarness(async (_url, init) => {
    fetchInit = init;
    return jsonResponse({ data: [{ id: "SYNTHETIC" }] });
  });
  const result = await handleMainWorldQueryRequest({
    message: {
      type: QUERY_API_REQUEST,
      method: "POST",
      path: "/yzw/yzw-zxfw-ajfw/api/v1/ajlist",
      body: { pageNum: 1, pageSize: 10 },
      headers: { Authorization: "Bearer MUST-NOT-PASS", Cookie: "MUST-NOT-PASS" },
      token: "MUST-NOT-PASS",
    },
    sender: courtSender,
    chromeApi,
  });
  assert.equal(result.ok, true);
  assert.equal(fetchInit.credentials, "include");
  assert.equal(JSON.stringify(fetchInit).includes("MUST-NOT-PASS"), false);
  assert.equal(/cookie|authorization|token/i.test(JSON.stringify(result)), false);

  for (const sensitiveKey of ["token", "accessToken", "refreshToken", "authToken", "sessionToken", "setCookie", "Authorization"]) {
    const sensitiveHarness = chromeHarness(async () => jsonResponse({ data: [], [sensitiveKey]: "MUST-NOT-PASS" }));
    const rejected = await handleMainWorldQueryRequest({
      message: { type: QUERY_API_REQUEST, method: "GET", path: "/yzw/yzw-zxfw-lafw/api/v3/layy" },
      sender: courtSender,
      chromeApi: sensitiveHarness.chromeApi,
    });
    assert.equal(rejected.code, "API_SENSITIVE_RESPONSE", sensitiveKey);
    assert.equal(JSON.stringify(rejected).includes("MUST-NOT-PASS"), false, sensitiveKey);
  }
});

for (const [label, response, code] of [
  ["401", jsonResponse({}, 401), "AUTH_REQUIRED"],
  ["403", jsonResponse({}, 403), "AUTH_REQUIRED"],
  ["login redirect", jsonResponse("", 200, { redirected: true, url: "https://zxfw.court.gov.cn/login" }), "LOGIN_REDIRECT"],
  ["non JSON", jsonResponse("<html></html>", 200, { contentType: "text/html" }), "API_NON_JSON"],
]) {
  test(`MAIN bridge ${label} 返回稳定待人工码`, async () => {
    const { chromeApi } = chromeHarness(async () => response);
    const result = await handleMainWorldQueryRequest({
      message: { type: QUERY_API_REQUEST, method: "GET", path: "/yzw/yzw-zxfw-lafw/api/v3/layy" },
      sender: courtSender,
      chromeApi,
    });
    assert.deepEqual(result, { ok: false, status: "UNKNOWN", needsHuman: true, code });
  });
}

test("MAIN 原生 fetch 401 时调用页面请求适配器且不读取鉴权值", async () => {
  const adapterCalls = [];
  const uninstall = installPageRequestAdapter(async (...args) => {
    adapterCalls.push(args);
    return { data: [] };
  });
  try {
    const { chromeApi } = chromeHarness(async () => jsonResponse({}, 401));
    const result = await handleMainWorldQueryRequest({
      message: {
        type: QUERY_API_REQUEST,
        method: "POST",
        path: "/yzw/yzw-zxfw-ajfw/api/v1/ajlist",
        body: { pageNum: 1, pageSize: 10 },
        headers: { Authorization: "MUST-NOT-PASS" },
        token: "MUST-NOT-PASS",
      },
      sender: courtSender,
      chromeApi,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual(adapterCalls, [[
      "/yzw-zxfw-ajfw/api/v1/ajlist",
      "post",
      { pageNum: 1, pageSize: 10 },
      { hideLoading: true, timeout: 15_000 },
    ]]);
    assert.equal(JSON.stringify(adapterCalls).includes("MUST-NOT-PASS"), false);
  } finally {
    uninstall();
  }
});
