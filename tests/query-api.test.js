import test from "node:test";
import assert from "node:assert/strict";

import {
  createMainWorldFetch,
  fetchStructuredJson,
  assertPaginationConservation,
  validateFieldSignature,
  matchApiDomRows,
  takeoverCaseSpaceTab,
  selectLatestAudit,
  fetchLayyPages,
  fetchMyCases,
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
  assert.equal(validateFieldSignature({ cajmc: "x", cajlbTranslateText: "民事", cah: "1", clarq: "2026-01-01", metadata: { ignored: true } }, expected).ok, true);
  const result = validateFieldSignature({ cajmc: "x", cah: "1", clarq: "2026-01-01", unexpected: "drift" }, expected);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.needsHuman, true);
  const typeDrift = validateFieldSignature({ cajmc: 123, cajlbTranslateText: "民事", cah: "1", clarq: "2026-01-01" }, expected);
  assert.equal(typeDrift.code, "FIELD_SIGNATURE_DRIFT");
});

test("createMainWorldFetch 不发送 header/token 并保留桥返回状态", async () => {
  let message;
  const fetchImpl = createMainWorldFetch(async (value) => {
    message = value;
    return { ok: true, status: 206, data: { data: [] } };
  });
  const response = await fetchImpl("/yzw/yzw-zxfw-ajfw/api/v1/ajlist", {
    method: "POST",
    headers: { Authorization: "MUST-NOT-PASS", Cookie: "MUST-NOT-PASS" },
    token: "MUST-NOT-PASS",
    body: JSON.stringify({ pageNum: 1, pageSize: 10 }),
  });
  assert.equal(response.status, 206);
  assert.equal(/header|cookie|authorization|token|MUST-NOT-PASS/i.test(JSON.stringify(message)), false);
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
    { id: "SYNTHETIC-ID-1", zt: "11800007-4", ajmc: "SYNTHETIC CASE 1", dsrMc: "原告：A；被告：B", laay: "CAUSE 1", laayMz: "NOT THE DOM CAUSE", tjsj: "2026-01-01T10:00:00Z", metadata: "allowed" },
    { id: "SYNTHETIC-ID-2", zt: "11800007-3", ajmc: "SYNTHETIC CASE 2", dsrMc: "原告：C；被告：D", laay: "CAUSE 2", laayMz: "NOT THE DOM CAUSE", tjsj: "2026-01-02", metadata: "allowed" },
    { id: "SYNTHETIC-ID-3", zt: "11800007-4", ajmc: "SYNTHETIC CASE 3", dsrMc: "原告：E；被告：F", laay: "CAUSE 3", laayMz: "NOT THE DOM CAUSE", tjsj: "2026-01-03", metadata: "allowed" },
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
    expectedFields: ["id", "zt", "ajmc", "dsrMc", "laay", "tjsj"],
    filters: { cxtj: "synthetic", kssj: "2026-01-01", jssj: "2026-01-31", zt: "", sfid: "SYNTHETIC-SF", sqrsf: "1" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.total, 3);
  assert.deepEqual(result.rows.map((row) => row.statusText), ["已立案", "审核不通过", "已立案"]);
  assert.deepEqual(
    result.rows.map(({ applicant, respondent, cause, applicationDate }) => ({ applicant, respondent, cause, applicationDate })),
    [
      { applicant: "A", respondent: "B", cause: "CAUSE 1", applicationDate: "2026-01-01" },
      { applicant: "C", respondent: "D", cause: "CAUSE 2", applicationDate: "2026-01-02" },
      { applicant: "E", respondent: "F", cause: "CAUSE 3", applicationDate: "2026-01-03" },
    ],
  );
  assert.equal(calls.length, 3);
  for (const { parsed, init } of calls) {
    assert.equal(init.credentials, "include");
    assert.equal(parsed.searchParams.get("ajlb"), "sp");
    for (const key of ["cxtj", "kssj", "jssj", "zt", "sfid", "sqrsf"]) assert.equal(parsed.searchParams.has(key), true, key);
  }
  assert.deepEqual(calls.slice(1).map(({ parsed }) => parsed.searchParams.get("page")), ["1", "2"]);
  assert.deepEqual(calls.slice(1).map(({ parsed }) => parsed.searchParams.get("limit")), ["2", "2"]);
});

test("fetchLayyPages 强执模式使用执行类别并解析申请执行人和审核通过", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url, "https://court.invalid");
    calls.push(parsed);
    return parsed.pathname.endsWith("/count")
      ? jsonResponse({ data: 1 })
      : jsonResponse({ data: [{
        id: "SYNTHETIC-QZ-ID",
        zt: "11800007-2",
        ajmc: "SYNTHETIC ENFORCEMENT CASE",
        dsrMc: "申请执行人：A；被执行人：B",
        laay: "SYNTHETIC ENFORCEMENT CAUSE",
        tjsj: "2026-08-08T08:00:00Z",
      }] });
  };
  const result = await fetchLayyPages({ kind: "qz", fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].statusText, "审核通过");
  assert.equal(result.rows[0].applicant, "A");
  assert.equal(result.rows[0].respondent, "B");
  assert.equal(calls.every((url) => url.searchParams.get("ajlb") === "zx"), true);
});

test("fetchLayyPages 强执使用 createTime 作为缺失 tjsj 的申请日期", async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url, "https://court.invalid");
    return parsed.pathname.endsWith("/count")
      ? jsonResponse({ data: 1 })
      : jsonResponse({ data: [{
        id: "SYNTHETIC-QZ-CREATED-ID",
        zt: "11800007-2",
        ajmc: "SYNTHETIC ENFORCEMENT CREATED CASE",
        dsrMc: "申请执行人：A；被执行人：B",
        laay: "SYNTHETIC ENFORCEMENT CAUSE",
        createTime: "2026-08-08T08:00:00Z",
      }] });
  };

  const result = await fetchLayyPages({ kind: "qz", fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.rows[0].applicationDate, "2026-08-08");
});

test("fetchLayyPages 强执缺少 tjsj 与 createTime 时仍按字段漂移失败", async () => {
  const result = await fetchLayyPages({
    kind: "qz",
    fetchImpl: async (url) => String(url).includes("/count")
      ? jsonResponse({ data: 1 })
      : jsonResponse({ data: [{
        id: "SYNTHETIC-QZ-NO-DATE-ID",
        zt: "11800007-2",
        ajmc: "SYNTHETIC ENFORCEMENT NO DATE CASE",
        dsrMc: "申请执行人：A；被执行人：B",
        laay: "SYNTHETIC ENFORCEMENT CAUSE",
      }] }),
  });

  assert.equal(result.code, "FIELD_SIGNATURE_DRIFT");
  assert.equal(result.needsHuman, true);
});

test("fetchLayyPages 对 total 不守恒和字段签名漂移统一转人工", async () => {
  const run = async (listBody) => fetchLayyPages({
    pageSize: 2,
    expectedFields: ["id", "zt", "ajmc", "dsrMc", "laay", "tjsj"],
    fetchImpl: async (url) => String(url).includes("/count")
      ? jsonResponse({ data: 2 })
      : jsonResponse({ data: listBody }),
  });
  const shortPage = await run([{ id: "SYNTHETIC-ID-1", zt: "11800007-4", ajmc: "A", dsrMc: "原告：A；被告：B", laay: "CAUSE", tjsj: "2026-01-01" }]);
  assert.equal(shortPage.code, "PAGINATION_TOTAL_MISMATCH");
  assert.equal(shortPage.needsHuman, true);
  const drift = await run([
    { id: "SYNTHETIC-ID-1", zt: "11800007-4", ajmc: "A", dsrMc: "原告：A；被告：B", laay: "CAUSE", tjsj: "2026-01-01" },
    { id: "SYNTHETIC-ID-2", zt: "11800007-4", ajmc: "B", dsrMc: "原告：C；被告：D", laay: "CAUSE", renamedDate: "2026-01-02" },
  ]);
  assert.equal(drift.code, "FIELD_SIGNATURE_DRIFT");
  assert.equal(drift.status, "UNKNOWN");
});

test("fetchMyCases 按 data.total 分页守恒并保留固定查询体", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return jsonResponse({
      data: {
        total: 3,
        data: body.pageNum === 1 ? [{ cajmc: "A" }, { cajmc: "B" }] : [{ cajmc: "C" }],
      },
    });
  };
  const result = await fetchMyCases({
    fetchImpl,
    pageSize: 2,
    body: { ajlb: "SYNTHETIC-CATEGORY", searchtext: "SYNTHETIC PLAINTIFF", ajzt: "", sfid: "", sort: "" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.total, 3);
  assert.deepEqual(result.rows.map((row) => row.cajmc), ["A", "B", "C"]);
  assert.deepEqual(calls.map(({ pageNum, pageSize }) => ({ pageNum, pageSize })), [
    { pageNum: 1, pageSize: 2 },
    { pageNum: 2, pageSize: 2 },
  ]);
  assert.equal(calls.every((body) => body.searchtext === "SYNTHETIC PLAINTIFF"), true);
});

test("fetchMyCases 缺失或伪造 total 时按字段签名漂移转人工", async () => {
  for (const payload of [
    { data: [] },
    { total: 0, data: [] },
    { data: { data: [] } },
    { data: { total: null, data: [] } },
    { data: { total: [], data: [] } },
  ]) {
    const result = await fetchMyCases({
      fetchImpl: async () => jsonResponse(payload),
      body: { ajlb: "SYNTHETIC-CATEGORY", searchtext: "SYNTHETIC PLAINTIFF" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "API_SCHEMA_DRIFT");
    assert.equal(result.needsHuman, true);
  }
});
