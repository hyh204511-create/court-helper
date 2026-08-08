// Structured court API transport and evidence guards.
// Runs in the content-script page so the browser's logged-in same-origin
// session is inherited; no credentials leave the page.

const MANUAL = (code, error = code) => ({ ok: false, status: "UNKNOWN", needsHuman: true, code, error });

export function createMainWorldFetch(sendMessage = globalThis.chrome?.runtime?.sendMessage) {
  if (typeof sendMessage !== "function") return null;
  return async (url, init = {}) => {
    let parsed;
    try {
      parsed = new URL(url, "https://zxfw.court.gov.cn");
    } catch {
      return { bridgeResult: MANUAL("API_ENDPOINT_INVALID") };
    }
    const method = String(init.method ?? "GET").toUpperCase();
    let body;
    if (method === "POST") {
      try {
        body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      } catch {
        return { bridgeResult: MANUAL("API_PARAMS_INVALID") };
      }
    }
    let result;
    try {
      result = await sendMessage({
        type: "QUERY_API_REQUEST",
        method,
        path: `${parsed.pathname}${parsed.search}`,
        ...(method === "POST" ? { body } : {}),
      });
    } catch {
      return { bridgeResult: MANUAL("BRIDGE_UNAVAILABLE") };
    }
    if (!result?.ok) return { bridgeResult: result ?? MANUAL("BRIDGE_PROTOCOL_ERROR") };
    if (!Number.isInteger(result.status) || result.status < 200 || result.status >= 300) {
      return { bridgeResult: MANUAL("BRIDGE_PROTOCOL_ERROR") };
    }
    return {
      status: Number(result.status),
      url: parsed.href,
      redirected: false,
      headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "application/json" : null },
      async json() { return result.data; },
    };
  };
}

function isJsonResponse(response) {
  const type = response?.headers?.get?.("content-type") ?? "";
  return /(^|\s|;)application\/json(?:\s*;|$)/i.test(type);
}

export async function fetchStructuredJson(url, { fetchImpl = globalThis.fetch?.bind(globalThis), init = {} } = {}) {
  if (typeof fetchImpl !== "function") return MANUAL("FETCH_UNAVAILABLE");
  let parsed;
  try {
    parsed = new URL(url, globalThis.location?.href ?? "https://court.invalid/");
    const origin = globalThis.location?.origin;
    if (origin && parsed.origin !== origin) return MANUAL("API_ORIGIN_MISMATCH");
    if (!/^\/yzw\/yzw-zxfw-(?:lafw|ajfw)\/api\//.test(parsed.pathname)) return MANUAL("API_ENDPOINT_UNSUPPORTED");
  } catch {
    return MANUAL("API_ENDPOINT_INVALID");
  }
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      credentials: "include",
      redirect: "manual",
      headers: { Accept: "application/json", ...(init.headers || {}) },
    });
  } catch {
    return MANUAL("API_REQUEST_FAILED");
  }
  if (response?.bridgeResult) return response.bridgeResult;
  const responseUrl = String(response?.url ?? "");
  if ([401, 403].includes(Number(response?.status))) return MANUAL("AUTH_REQUIRED");
  if (response?.redirected || /(?:^|\/)login(?:[/?#]|$)/i.test(responseUrl)) return MANUAL("LOGIN_REDIRECT");
  if (!response || Number(response.status) < 200 || Number(response.status) >= 300) return MANUAL("API_HTTP_ERROR");
  if (!isJsonResponse(response)) return MANUAL("API_NON_JSON");
  try {
    return { ok: true, data: await response.json(), status: Number(response.status) };
  } catch {
    return MANUAL("API_INVALID_JSON");
  }
}

export function assertPaginationConservation({ total, pages } = {}) {
  if (!Number.isInteger(total) || total < 0 || !Array.isArray(pages)) return MANUAL("PAGINATION_INVALID");
  if (total > 50) return MANUAL("BATCH_LIMIT_EXCEEDED");
  const count = pages.reduce((n, page) => n + (Array.isArray(page) ? page.length : -1), 0);
  if (count !== total) return MANUAL("PAGINATION_TOTAL_MISMATCH");
  return { ok: true, total };
}

export function validateFieldSignature(value, expected = []) {
  if (!value || !Array.isArray(expected) || expected.length === 0) return MANUAL("FIELD_SIGNATURE_INVALID");
  if (expected.some((key) => !Object.hasOwn(value, key)
    || typeof value[key] !== "string"
    || !value[key].trim())) return MANUAL("FIELD_SIGNATURE_DRIFT");
  return { ok: true, value };
}

const identity = (row) => ["caseName", "applicant", "respondent", "cause", "applicationDate"]
  .map((key) => String(row?.[key] ?? "").trim()).join("\u001f");

export function matchApiDomRows(apiRows = [], domRows = []) {
  if (!Array.isArray(apiRows) || !Array.isArray(domRows) || apiRows.length !== domRows.length) return MANUAL("API_DOM_MISMATCH");
  const apiKeys = apiRows.map(identity);
  const domKeys = domRows.map(identity);
  if (apiKeys.some((key) => key.split("\u001f").some((part) => !part))
    || new Set(apiKeys).size !== apiKeys.length || new Set(domKeys).size !== domKeys.length
    || apiKeys.some((key, index) => domKeys[index] !== key)) return MANUAL("API_DOM_MISMATCH");
  return { ok: true, matches: apiRows.map((row) => domRows.findIndex((candidate) => identity(candidate) === identity(row))) };
}

export async function takeoverCaseSpaceTab({ originalTabId, tabsBefore = [], tabsAfter = [], isDetail = (tab) => /detail|layyxq/i.test(String(tab?.url ?? "")) } = {}) {
  const before = new Set((Array.isArray(tabsBefore) ? tabsBefore : []).map((tab) => tab?.id));
  const candidate = (Array.isArray(tabsAfter) ? tabsAfter : []).find((tab) => tab?.id !== originalTabId && !before.has(tab?.id) && isDetail(tab));
  return candidate ? { ok: true, tabId: candidate.id, originalTabId } : MANUAL("CASE_SPACE_TAB_UNAVAILABLE");
}

export function selectLatestAudit(records = []) {
  if (!Array.isArray(records) || !records.length) return MANUAL("AUDIT_EVIDENCE_INCOMPLETE");
  const normalized = records.map((record) => ({ record, time: Date.parse(record?.shsj ?? "") }));
  if (normalized.some(({ time, record }) => !Number.isFinite(time)
    || !String(record?.shjg ?? "").trim()
    || !String(record?.cshjg ?? "").trim()
    || !String(record?.shyj ?? "").trim()
    || !String(record?.shsj ?? "").trim())) return MANUAL("AUDIT_EVIDENCE_INCOMPLETE");
  const latestTime = Math.max(...normalized.map(({ time }) => time));
  const latest = normalized.filter(({ time }) => time === latestTime);
  if (latest.length !== 1) return MANUAL("AUDIT_EVIDENCE_AMBIGUOUS");
  return { ok: true, record: latest[0].record };
}

function responseRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.data?.data)) return data.data.data;
  if (Array.isArray(data?.rows)) return data.rows;
  return null;
}

function responseTotal(data) {
  let value;
  if (data?.data && !Array.isArray(data.data) && Object.hasOwn(data.data, "total")) {
    value = data.data.total;
  } else if (data && !Array.isArray(data) && Object.hasOwn(data, "total")) {
    value = data.total;
  } else if (typeof data?.data === "number" || typeof data?.data === "string") {
    value = data.data;
  } else {
    return Number.NaN;
  }
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
  return Number.NaN;
}

function myCaseResponseTotal(data) {
  if (!data?.data || Array.isArray(data.data) || !Object.hasOwn(data.data, "total")) {
    return Number.NaN;
  }
  const value = data.data.total;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
  return Number.NaN;
}

/** Fetch the documented 我的立案列表/count pair page by page. */
export async function fetchLayyDataset({ params = {}, limit = 50, fetchImpl } = {}) {
  const query = new URLSearchParams({ ...params, ajlb: params.ajlb ?? "sp", limit: String(limit) });
  const countResult = await fetchStructuredJson(`/yzw/yzw-zxfw-lafw/api/v3/layy/count?${query}`, { fetchImpl });
  if (!countResult.ok) return countResult;
  const total = responseTotal(countResult.data);
  if (!Number.isInteger(total) || total < 0) return MANUAL("PAGINATION_INVALID");
  if (total > 50) return MANUAL("BATCH_LIMIT_EXCEEDED");
  const pages = [];
  const pageCount = Math.max(1, Math.ceil(total / limit));
  for (let page = 1; page <= pageCount; page += 1) {
    const pageQuery = new URLSearchParams(query);
    pageQuery.set("page", String(page));
    const result = await fetchStructuredJson(`/yzw/yzw-zxfw-lafw/api/v3/layy?${pageQuery}`, { fetchImpl });
    if (!result.ok) return result;
    const rows = responseRows(result.data);
    if (!rows) return MANUAL("API_SCHEMA_DRIFT");
    pages.push(rows);
  }
  const conservation = assertPaginationConservation({ total, pages });
  return conservation.ok ? { ok: true, total, rows: pages.flat(), pages } : conservation;
}

const LAYY_STATUS = new Map([
  ["11800007-1", "待审核"],
  ["11800007-2", "审核通过"],
  ["11800007-4", "已立案"],
  ["11800007-3", "审核不通过"],
  ["11800007-5", "不予立案"],
  ["11800007-6", "待补充材料"],
  ["11800007-31", "待补正"],
]);
export const LAYY_REQUIRED_FIELDS = ["id", "zt", "ajmc", "dsrMc"];

function parseLayyParticipants(value, kind = "li") {
  const text = String(value ?? "").trim();
  const match = kind === "qz"
    ? /^申请执行人：([^；]+)；被执行人：([^；]+)$/.exec(text)
    : /^原告：([^；]+)；被告：([^；]+)$/.exec(text);
  if (!match) return null;
  const applicant = match[1].trim();
  const respondent = match[2].trim();
  return applicant && respondent ? { applicant, respondent } : null;
}

function normalizeLayyDate(value) {
  const text = String(value ?? "").trim();
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/.exec(text);
  return match?.[1] ?? "";
}

/** Public collector used by QUERY_LI/QUERY_QZ. */
export async function fetchLayyPages({ kind = "li", filters = {}, pageSize = 50, expectedFields = LAYY_REQUIRED_FIELDS, fetchImpl } = {}) {
  const result = await fetchLayyDataset({
    params: { ...filters, ajlb: filters.ajlb ?? (kind === "qz" ? "zx" : "sp") },
    limit: pageSize,
    fetchImpl,
  });
  if (!result.ok) return result;
  const rows = [];
  for (const raw of result.rows) {
    const signature = validateFieldSignature(raw, expectedFields);
    if (!signature.ok) return signature;
    const statusText = LAYY_STATUS.get(String(raw.zt));
    if (!statusText) return MANUAL("UNKNOWN_STATUS");
    const participants = parseLayyParticipants(raw.dsrMc, kind);
    const applicationDate = normalizeLayyDate(raw.tjsj || raw.createTime);
    if (raw.laay != null && typeof raw.laay !== "string") return MANUAL("FIELD_SIGNATURE_DRIFT");
    const cause = String(raw.laay ?? "").trim() || (kind === "qz" ? "暂无" : "");
    if (!participants || !applicationDate || !cause) return MANUAL("FIELD_SIGNATURE_DRIFT");
    rows.push({
      ...raw,
      statusText,
      caseName: String(raw.ajmc ?? "").trim(),
      ...participants,
      cause,
      applicationDate,
    });
  }
  return { ok: true, total: result.total, rows, pages: result.pages };
}

/** Fetch 我的案件 using the documented POST contract. */
export async function fetchMyCases({ body = {}, pageSize = 50, fetchImpl } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) return MANUAL("PAGINATION_INVALID");
  const baseBody = { ...body, pageSize };
  delete baseBody.pageNum;
  const pages = [];
  let total = null;
  let page = 1;
  do {
    const result = await fetchStructuredJson("/yzw/yzw-zxfw-ajfw/api/v1/ajlist", {
      fetchImpl,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...baseBody, pageNum: page }),
      },
    });
    if (!result.ok) return result;
    const rows = responseRows(result.data);
    const responsePageTotal = myCaseResponseTotal(result.data);
    if (!rows || !Number.isInteger(responsePageTotal) || responsePageTotal < 0) return MANUAL("API_SCHEMA_DRIFT");
    if (total === null) {
      total = responsePageTotal;
      if (total > 50) return MANUAL("BATCH_LIMIT_EXCEEDED");
    } else if (responsePageTotal !== total) {
      return MANUAL("PAGINATION_TOTAL_MISMATCH");
    }
    pages.push(rows);
    page += 1;
  } while ((page - 1) * pageSize < total);
  const conservation = assertPaginationConservation({ total, pages });
  return conservation.ok ? { ok: true, total, rows: pages.flat(), pages } : conservation;
}
