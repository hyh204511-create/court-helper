export const QUERY_API_REQUEST = "QUERY_API_REQUEST";

const MANUAL = (code) => ({ ok: false, status: "UNKNOWN", needsHuman: true, code });
const COURT_ORIGIN = "https://zxfw.court.gov.cn";

const GET_PATHS = [
  /^\/yzw\/yzw-zxfw-lafw\/api\/v3\/layy$/,
  /^\/yzw\/yzw-zxfw-lafw\/api\/v3\/layy\/count$/,
  /^\/yzw\/yzw-zxfw-lafw\/api\/v3\/layy\/layyxq\/[^/]+\/0$/,
  /^\/yzw\/yzw-zxfw-lafw\/api\/v3\/pz\/layymb\/[^/]+\/[^/]+$/,
];
const POST_PATHS = [/^\/yzw\/yzw-zxfw-ajfw\/api\/v1\/ajlist$/];
const AJLIST_KEYS = new Set(["pageNum", "pageSize", "ajlb", "searchtext", "ajzt", "sfid", "sort"]);
const LAYY_QUERY_KEYS = new Set(["cxtj", "kssj", "jssj", "zt", "limit", "page", "ajlb", "sfid", "sqrsf"]);
const MY_CASE_CATEGORIES = new Set([
  "1501_000001-0100;1501_000001-0200;1501_000001-0300;1501_000001-0400;1501_000001-0500",
  "1501_000001-1000",
]);
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

function courtSenderTab(sender) {
  if (!Number.isInteger(sender?.tab?.id) || typeof sender?.tab?.url !== "string") return null;
  try {
    const url = new URL(sender.tab.url);
    return url.origin === COURT_ORIGIN ? sender.tab : null;
  } catch {
    return null;
  }
}

function safeRequest(message) {
  const method = String(message?.method ?? "GET").toUpperCase();
  if (typeof message?.path !== "string" || message.path.length > 4096) return null;
  if (/%(?:2e|2f|5c)/i.test(message.path)) return null;
  let url;
  try {
    url = new URL(message.path, COURT_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== COURT_ORIGIN || url.hash || !message.path.startsWith("/")) return null;
  const allowed = method === "GET"
    ? GET_PATHS.some((pattern) => pattern.test(url.pathname))
    : method === "POST" && POST_PATHS.some((pattern) => pattern.test(url.pathname));
  if (!allowed) return null;
  const queryKeys = [...url.searchParams.keys()];
  if (new Set(queryKeys).size !== queryKeys.length) return null;
  if (method === "GET") {
    if (url.pathname.endsWith("/layy") || url.pathname.endsWith("/layy/count")) {
      if ([...url.searchParams.keys()].some((key) => !LAYY_QUERY_KEYS.has(key))) return null;
      if (url.searchParams.has("ajlb") && url.searchParams.get("ajlb") !== "sp") return null;
      const limit = url.searchParams.get("limit");
      const page = url.searchParams.get("page");
      if (limit !== null && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 50)) return null;
      if (page !== null && (!/^\d+$/.test(page) || Number(page) < 1)) return null;
    } else {
      if (url.search) return null;
      const parts = url.pathname.split("/").filter(Boolean);
      const pathParams = url.pathname.includes("/layyxq/") ? parts.slice(-2, -1) : parts.slice(-2);
      if (!pathParams.length || pathParams.some((part) => !SAFE_PATH_SEGMENT.test(part))) return null;
    }
    return { method, path: `${url.pathname}${url.search}` };
  }
  if (url.search) return null;
  const body = message?.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.some((key) => !AJLIST_KEYS.has(key)) || JSON.stringify(body).length > 16_384) return null;
  if (body.pageNum !== undefined && (!Number.isInteger(body.pageNum) || body.pageNum < 1)) return null;
  if (body.pageSize !== undefined && (!Number.isInteger(body.pageSize) || body.pageSize < 1 || body.pageSize > 50)) return null;
  if (body.ajlb !== undefined && !MY_CASE_CATEGORIES.has(body.ajlb)) return null;
  if (["searchtext", "ajzt", "sfid", "sort"].some((key) => body[key] !== undefined && typeof body[key] !== "string")) return null;
  return { method, path: url.pathname, body };
}

// Serialized by chrome.scripting.executeScript and run in the page MAIN world.
// It intentionally accepts no caller-provided URL origin, headers or tokens.
export async function executeMainWorldQuery(request) {
  const manual = (code) => ({ ok: false, status: "UNKNOWN", needsHuman: true, code });
  const finishJson = (data, status) => {
    let serialized;
    try {
      serialized = JSON.stringify(data);
    } catch {
      return manual("API_INVALID_JSON");
    }
    if (serialized.length > 10 * 1024 * 1024) return manual("API_RESPONSE_TOO_LARGE");
    const containsSensitiveKey = (value, seen = new Set()) => {
      if (!value || typeof value !== "object" || seen.has(value)) return false;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
        if (normalizedKey === "authorization"
          || normalizedKey === "setcookie"
          || normalizedKey === "cookie"
          || normalizedKey === "token"
          || normalizedKey === "accesstoken"
          || normalizedKey === "refreshtoken"
          || normalizedKey === "authtoken"
          || normalizedKey === "sessiontoken"
          || normalizedKey === "credential"
          || normalizedKey === "secret") return true;
        if (containsSensitiveKey(child, seen)) return true;
      }
      return false;
    };
    if (containsSensitiveKey(data)) return manual("API_SENSITIVE_RESPONSE");
    const authCode = String(data?.code ?? data?.errorCode ?? "").toUpperCase();
    if (["401", "403", "AUTH_REQUIRED", "UNAUTHORIZED", "FORBIDDEN"].includes(authCode)) {
      return manual("AUTH_REQUIRED");
    }
    return { ok: true, data, status };
  };
  const findPageRequestAdapter = () => {
    const chunks = globalThis.webpackJsonp;
    if (!Array.isArray(chunks) || typeof chunks.push !== "function") return null;
    let webpackRequire;
    const probeId = `court_helper_query_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const modules = {
      [probeId](module, exports, requireModule) {
        webpackRequire = requireModule;
      },
    };
    try {
      chunks.push([[probeId], modules, [[probeId]]]);
      const matches = Object.entries(webpackRequire?.m ?? {}).filter(([, factory]) => {
        const source = Function.prototype.toString.call(factory);
        return source.includes("zxfwtoken") && source.includes("Authorization") && source.includes("uni.request");
      });
      if (matches.length !== 1) return null;
      const candidate = webpackRequire(matches[0][0]);
      return typeof candidate?.default === "function" ? candidate.default : null;
    } catch {
      return null;
    }
  };
  let response;
  try {
    response = await fetch(request.path, {
      method: request.method,
      credentials: "include",
      redirect: "manual",
      headers: request.method === "POST"
        ? { Accept: "application/json", "Content-Type": "application/json" }
        : { Accept: "application/json" },
      body: request.method === "POST" ? JSON.stringify(request.body) : undefined,
    });
  } catch {
    return manual("API_REQUEST_FAILED");
  }
  const responseUrl = String(response?.url ?? "");
  if ([401, 403].includes(Number(response?.status))) {
    const pageRequest = findPageRequestAdapter();
    if (!pageRequest) return manual("AUTH_REQUIRED");
    try {
      const data = await pageRequest(
        request.path.replace(/^\/yzw(?=\/)/, ""),
        request.method.toLowerCase(),
        request.method === "POST" ? request.body : {},
        { hideLoading: true, timeout: 15_000 },
      );
      return finishJson(data, 200);
    } catch {
      return /(?:^|\/)login(?:[/?#]|$)/i.test(String(globalThis.location?.href ?? ""))
        ? manual("AUTH_REQUIRED")
        : manual("API_REQUEST_FAILED");
    }
  }
  if (response?.type === "opaqueredirect" || Number(response?.status) === 0
    || (Number(response?.status) >= 300 && Number(response?.status) < 400)
    || response?.redirected || /(?:^|\/)login(?:[/?#]|$)/i.test(responseUrl)) {
    return manual("LOGIN_REDIRECT");
  }
  if (!response || Number(response.status) < 200 || Number(response.status) >= 300) return manual("API_HTTP_ERROR");
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!/application\/json/i.test(contentType)) return manual("API_NON_JSON");
  let data;
  try {
    data = await response.json();
  } catch {
    return manual("API_INVALID_JSON");
  }
  return finishJson(data, Number(response.status));
}

export async function handleMainWorldQueryRequest({ message, sender, chromeApi = globalThis.chrome } = {}) {
  if (message?.type !== QUERY_API_REQUEST) return MANUAL("QUERY_API_NOT_ALLOWED");
  const tab = courtSenderTab(sender);
  if (!tab) return MANUAL("QUERY_API_SENDER_REJECTED");
  const request = safeRequest(message);
  if (!request) return MANUAL("QUERY_API_NOT_ALLOWED");
  if (typeof chromeApi?.scripting?.executeScript !== "function") return MANUAL("BRIDGE_UNAVAILABLE");
  try {
    const results = await chromeApi.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: executeMainWorldQuery,
      args: [request],
    });
    const result = results?.[0]?.result;
    return result && typeof result === "object" ? result : MANUAL("BRIDGE_PROTOCOL_ERROR");
  } catch {
    return MANUAL("BRIDGE_UNAVAILABLE");
  }
}
