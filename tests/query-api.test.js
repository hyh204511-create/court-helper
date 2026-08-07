import test from "node:test";
import assert from "node:assert/strict";

import {
  fetchStructuredJson,
  assertPaginationConservation,
  validateFieldSignature,
  matchApiDomRows,
  takeoverCaseSpaceTab,
  selectLatestAudit,
  fetchLayyPages,
} from "../extension/content/query-api.js";

const jsonResponse = (body, status = 200, extra = {}) => ({
  status,
  url: extra.url ?? "https://court.invalid/yzw/yzw-zxfw-lafw/api/v3/layy",
  redirected: Boolean(extra.redirected),
  headers: { get: (name) => name.toLowerCase() === "content-type" ? (extra.contentType ?? "application/json") : null },
  async json() { return body; },
});

test("fetchStructuredJson 主动请求继承当前已登录会话", async () => {
  let init;
  const result = await fetchStructuredJson("/yzw/yzw-zxfw-lafw/api/v3/layy", {
    fetchImpl: async (_url, options) => {
      init = options;
      return jsonResponse({ data: [] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(init.credentials, "include");
});

for (const [label, response] of [
  ["401", jsonResponse({ error: "unauthorized" }, 401)],
  ["403", jsonResponse({ error: "forbidden" }, 403)],
  ["login redirect", jsonResponse("<html>login</html>", 200, { redirected: true, url: "https://court.invalid/login" })],
  ["non JSON", jsonResponse("not-json", 200, { contentType: "text/html" })],
]) {
  test(`fetchStructuredJson ${label} 标记待人工`, async () => {
    const result = await fetchStructuredJson("/api", { fetchImpl: async () => response });
    assert.equal(result.ok, false);
    assert.equal(result.needsHuman, true);
  });
}

test("assertPaginationConservation 拒绝 total 与逐页条数不守恒", () => {
  assert.deepEqual(assertPaginationConservation({ total: 3, pages: [[{}, {}], [{}]] }), { ok: true, total: 3 });
  const bad = assertPaginationConservation({ total: 3, pages: [[{}], [{}]] });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "PAGINATION_TOTAL_MISMATCH");
  assert.equal(bad.needsHuman, true);
});

test("validateFieldSignature 字段签名漂移转 UNKNOWN", () => {
  const expected = ["cajmc", "cajlbTranslateText", "cah", "clarq"];
  assert.equal(validateFieldSignature({ cajmc: "x", cajlbTranslateText: "民事", cah: "1", clarq: "2026-01-01" }, expected).ok, true);
  const result = validateFieldSignature({ cajmc: "x", cah: "1", clarq: "2026-01-01", unexpected: "drift" }, expected);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.needsHuman, true);
});

test("matchApiDomRows 双向唯一匹配，重复签名或 API/DOM 不一致转 UNKNOWN", () => {
  const api = [
    { caseName: "甲案", applicant: "甲", respondent: "乙", cause: "借款", applicationDate: "2026-01-01" },
    { caseName: "乙案", applicant: "丙", respondent: "丁", cause: "侵权", applicationDate: "2026-01-02" },
  ];
  const dom = [...api];
  assert.equal(matchApiDomRows(api, dom).ok, true);
  const duplicate = matchApiDomRows(api, [{ ...dom[0] }, { ...dom[0] }]);
  assert.equal(duplicate.status, "UNKNOWN");
  assert.equal(duplicate.needsHuman, true);
  const mismatch = matchApiDomRows(api, [{ ...dom[0], cause: "侵权" }]);
  assert.equal(mismatch.status, "UNKNOWN");
  assert.equal(mismatch.needsHuman, true);
  const orderMismatch = matchApiDomRows(api, [...dom].reverse());
  assert.equal(orderMismatch.status, "UNKNOWN");
  assert.equal(orderMismatch.needsHuman, true);
});

test("takeoverCaseSpaceTab 接管案件空间新标签，不继续等待原列表标签", async () => {
  const result = await takeoverCaseSpaceTab({
    originalTabId: 10,
    tabsBefore: [{ id: 10, url: "https://court.invalid/list" }],
    tabsAfter: [{ id: 10, url: "https://court.invalid/list" }, { id: 11, url: "https://court.invalid/detail" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.tabId, 11);
});

test("selectLatestAudit 按最新 shsj 选择；并列最新时待人工", () => {
  const records = [
    { shjg: "通过", cshjg: "通过", shyj: "旧", shsj: "2026-01-01T00:00:00Z" },
    { shjg: "不通过", cshjg: "不通过", shyj: "新", shsj: "2026-02-01T00:00:00Z" },
  ];
  assert.equal(selectLatestAudit(records).record.shyj, "新");
  const tie = selectLatestAudit([
    records[1],
    { ...records[1], shyj: "并列" },
  ]);
  assert.equal(tie.status, "UNKNOWN");
  assert.equal(tie.needsHuman, true);
  const incomplete = selectLatestAudit([{ ...records[1], shyj: "" }]);
  assert.equal(incomplete.status, "UNKNOWN");
  assert.equal(incomplete.needsHuman, true);
});

test("fetchLayyPages 先取 count，再携完整筛选参数逐页采集并映射状态", async () => {
  const calls = [];
  const rows = [
    { layyid: "SYNTHETIC-ID-1", zt: "11800007-4", ajmc: "SYNTHETIC CASE 1", sqrsj: "2026-01-01" },
    { layyid: "SYNTHETIC-ID-2", zt: "11800007-3", ajmc: "SYNTHETIC CASE 2", sqrsj: "2026-01-02" },
    { layyid: "SYNTHETIC-ID-3", zt: "11800007-4", ajmc: "SYNTHETIC CASE 3", sqrsj: "2026-01-03" },
  ];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url, "https://court.invalid");
    calls.push({ parsed, init });
    if (parsed.pathname.endsWith("/layy/count")) return jsonResponse({ data: 3 });
    const page = Number(parsed.searchParams.get("page"));
    return jsonResponse({ data: page === 1 ? rows.slice(0, 2) : rows.slice(2) });
  };
  const result = await fetchLayyPages({
    fetchImpl,
    pageSize: 2,
    expectedFields: ["layyid", "zt", "ajmc", "sqrsj"],
    filters: { cxtj: "synthetic", kssj: "2026-01-01", jssj: "2026-01-31", zt: "", sfid: "SYNTHETIC-SF", sqrsf: "1" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.total, 3);
  assert.deepEqual(result.rows.map((row) => row.statusText), ["已立案", "审核不通过", "已立案"]);
  assert.equal(calls.length, 3);
  for (const { parsed, init } of calls) {
    assert.equal(init.credentials, "include");
    assert.equal(parsed.searchParams.get("ajlb"), "sp");
    for (const key of ["cxtj", "kssj", "jssj", "zt", "sfid", "sqrsf"]) assert.equal(parsed.searchParams.has(key), true, key);
  }
  assert.deepEqual(calls.slice(1).map(({ parsed }) => parsed.searchParams.get("page")), ["1", "2"]);
  assert.deepEqual(calls.slice(1).map(({ parsed }) => parsed.searchParams.get("limit")), ["2", "2"]);
});

test("fetchLayyPages 对 total 不守恒和字段签名漂移统一转人工", async () => {
  const run = async (listBody) => fetchLayyPages({
    pageSize: 2,
    expectedFields: ["layyid", "zt", "ajmc", "sqrsj"],
    fetchImpl: async (url) => String(url).includes("/count")
      ? jsonResponse({ data: 2 })
      : jsonResponse({ data: listBody }),
  });
  const shortPage = await run([{ layyid: "SYNTHETIC-ID-1", zt: "11800007-4", ajmc: "A", sqrsj: "2026-01-01" }]);
  assert.equal(shortPage.code, "PAGINATION_TOTAL_MISMATCH");
  assert.equal(shortPage.needsHuman, true);
  const drift = await run([
    { layyid: "SYNTHETIC-ID-1", zt: "11800007-4", ajmc: "A", sqrsj: "2026-01-01" },
    { layyid: "SYNTHETIC-ID-2", zt: "11800007-4", ajmc: "B", renamedDate: "2026-01-02" },
  ]);
  assert.equal(drift.code, "FIELD_SIGNATURE_DRIFT");
  assert.equal(drift.status, "UNKNOWN");
});
