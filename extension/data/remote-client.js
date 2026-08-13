// remote-client.js — 远端 REST 客户端
// 远端逻辑没有模块级网络副作用；baseUrl/token 缺失时 createRemoteClient 返回 null，
// 让默认安装保持离线。token 只存在调用方内存中，不写 IndexedDB、不进入消息路由。

export const API_PREFIX = "/api/v1";
export const DEFAULT_TIMEOUT_MS = 10_000;

const RETRYABLE_CODES = new Set([
  "DEPENDENCY_UNAVAILABLE",
  "NETWORK_UNAVAILABLE",
  "REQUEST_TIMEOUT",
  "RATE_LIMITED",
]);

export class RemoteError extends Error {
  constructor({ status = 0, code = "REMOTE_ERROR", message = "远端请求失败", retryable, requestId = null, details = [], cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "RemoteError";
    this.status = status;
    this.code = code;
    this.retryable = retryable ?? (RETRYABLE_CODES.has(code) || status >= 500 || status === 429);
    this.requestId = requestId;
    this.details = Array.isArray(details) ? details : [];
  }
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function normalizeBaseUrl(baseUrl, apiPrefix = API_PREFIX) {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") return null;
  const raw = trimTrailingSlash(baseUrl.trim());
  const suffix = trimTrailingSlash(apiPrefix || "");
  const hasPrefix = suffix && (raw === suffix || raw.endsWith(suffix));
  const normalized = hasPrefix || !suffix ? raw : `${raw}${suffix}`;
  if (/^https?:\/\//i.test(normalized)) {
    const parsed = new URL(normalized);
    if (!/^https?:$/.test(parsed.protocol)) throw new TypeError("INVALID_BASE_URL");
  }
  return normalized;
}

function pathPart(value) {
  return encodeURIComponent(String(value));
}

function isFormData(value) {
  return typeof FormData !== "undefined" && value instanceof FormData;
}

async function readBody(response) {
  if (response.status === 204) return undefined;
  try {
    return await response.json();
  } catch {
    try {
      const text = await response.text();
      return text ? { message: text } : null;
    } catch {
      return null;
    }
  }
}

function errorParts(status, body) {
  const error = body?.error && typeof body.error === "object" ? body.error : body;
  const code = typeof error?.code === "string"
    ? error.code
    : status === 401 ? "AUTH_REQUIRED"
      : status === 403 ? "FORBIDDEN"
        : status === 404 ? "NOT_FOUND"
          : status === 409 ? "CONFLICT"
            : status === 413 ? "PAYLOAD_TOO_LARGE"
              : status === 429 ? "RATE_LIMITED"
                : status >= 500 ? "DEPENDENCY_UNAVAILABLE"
                  : "REMOTE_ERROR";
  const retryable = typeof error?.retryable === "boolean"
    ? error.retryable
    : RETRYABLE_CODES.has(code) || status >= 500 || status === 429;
  return {
    code,
    retryable,
    message: typeof error?.message === "string" && error.message.length <= 256
      ? error.message
      : `远端请求失败（${status || "网络"}）`,
    requestId: typeof error?.requestId === "string" ? error.requestId : null,
    details: Array.isArray(error?.details) ? error.details : [],
  };
}

function combineSignal(externalSignal, controller) {
  if (!externalSignal) return undefined;
  if (externalSignal.aborted) {
    controller.abort(externalSignal.reason);
    return undefined;
  }
  const abort = () => controller.abort(externalSignal.reason);
  externalSignal.addEventListener("abort", abort, { once: true });
  return () => externalSignal.removeEventListener("abort", abort);
}

function makeTimeoutError(timeoutMs) {
  return new RemoteError({
    code: "REQUEST_TIMEOUT",
    message: `远端请求超时（${timeoutMs}ms）`,
    retryable: true,
  });
}

/**
 * @param {{baseUrl?: string, token?: string, timeoutMs?: number, fetchImpl?: Function, apiPrefix?: string}} options
 * @returns {object|null}
 */
export function createRemoteClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl, options.apiPrefix ?? API_PREFIX);
  if (!baseUrl) return null;

  const token = typeof options.token === "string" ? options.token.trim() : "";
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const defaultTimeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const defaultHeaders = typeof options.defaultHeaders === "function" ? options.defaultHeaders : () => ({});

  async function request(path, {
    method = "GET",
    body,
    headers: extraHeaders = {},
    idempotencyKey,
    timeoutMs = defaultTimeoutMs,
    signal,
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new RemoteError({ code: "NETWORK_UNAVAILABLE", message: "当前环境不支持网络请求", retryable: true });
    }
    const headers = {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...defaultHeaders(),
      ...extraHeaders,
    };
    let requestBody = body;
    if (body !== undefined && !isFormData(body)) {
      headers["Content-Type"] ??= "application/json";
      requestBody = typeof body === "string" ? body : JSON.stringify(body);
    }
    if (idempotencyKey) headers["Idempotency-Key"] = String(idempotencyKey);

    const controller = new AbortController();
    const detach = combineSignal(signal, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort("timeout");
    }, timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: requestBody,
        signal: controller.signal,
      });
      const responseBody = await readBody(response);
      if (!response.ok) {
        const parts = errorParts(response.status, responseBody);
        throw new RemoteError({ status: response.status, ...parts });
      }
      return responseBody;
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      if (timedOut) throw makeTimeoutError(timeoutMs);
      throw new RemoteError({
        code: "NETWORK_UNAVAILABLE",
        message: "服务器不可达，请重试",
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      detach?.();
    }
  }

  async function syncCases(payload, { idempotencyKey } = {}) {
    if (!payload || typeof payload !== "object" || typeof payload.batchId !== "string") {
      throw new TypeError("batchId required");
    }
    return request("/sync/cases", {
      method: "POST",
      body: payload,
      idempotencyKey: idempotencyKey ?? payload.batchId,
    });
  }

  async function uploadScreenshot(caseId, input, { idempotencyKey } = {}) {
    const blob = input?.blob ?? input?.file;
    if (!blob) throw new TypeError("screenshot blob required");
    const form = new FormData();
    form.set("eventId", String(input.eventId));
    form.set("type", String(input.type));
    form.set("capturedAt", String(input.capturedAt));
    form.set("sha256", String(input.sha256));
    form.set("file", blob, input.filename ?? "screenshot.jpg");
    return request(`/cases/${pathPart(caseId)}/screenshots`, {
      method: "POST",
      body: form,
      idempotencyKey,
    });
  }

  async function uploadReportExport({ blob, fileName, sha256, platformAccountId } = {}) {
    if (!blob) throw new TypeError("report export blob required");
    const form = new FormData();
    form.set("sha256", String(sha256 ?? ""));
    form.set("platformAccountId", String(platformAccountId ?? ""));
    form.set("file", blob, String(fileName || "report.xlsx"));
    return request("/report-exports", {
      method: "POST",
      body: form,
    });
  }

  async function pullChanges(after = 0, limit = 200) {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });
    return request(`/sync/changes?${query.toString()}`);
  }

  const client = {
    baseUrl,
    configured: true,
    request,
    health: () => request("/health"),
    healthCheck: () => request("/health"),
    me: () => request("/auth/me"),
    getMe: () => request("/auth/me"),
    listPlatformAccounts: () => request("/platform-accounts"),
    getPlatformAccounts: () => request("/platform-accounts"),
    getCredential: (id) => request(`/platform-accounts/${pathPart(id)}/credential`, { method: "POST" }),
    getPlatformCredential: (id) => request(`/platform-accounts/${pathPart(id)}/credential`, { method: "POST" }),
    syncCases,
    sync: syncCases,
    pullChanges,
    changes: pullChanges,
    uploadScreenshot,
    uploadReportExport,
    listScreenshots: (caseId) => request(`/cases/${pathPart(caseId)}/screenshots`),
    getScreenshotContent: (id, { download = false } = {}) => request(
      `/screenshots/${pathPart(id)}/content?download=${download ? "1" : "0"}`,
    ),
  };
  return client;
}

export function isRemoteConfigured(config = {}) {
  return Boolean(normalizeBaseUrl(config.baseUrl, config.apiPrefix ?? API_PREFIX));
}
