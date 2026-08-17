import { createRemoteClient } from "../data/remote-client.js";
import { isCourtListRoute, isLoginRoute } from "../content/login-detector.js";
import { CONTENT_PROTOCOL_VERSION } from "../shared/runtime-protocol.js";

export const BROWSER_COMMAND_ALARM_NAME = "browser-command-poll";
export const BROWSER_COMMAND_ALARM_PERIOD_MINUTES = 1;
const COURT_URL_PATTERN = "https://zxfw.court.gov.cn/*";
const POLL_INTERVAL_MS = 3000;
const WSLA_LIST_ROUTE = "#/pagesWsla/pc/list/index";
const CONTENT_ROUTE_PING_TIMEOUT_MS = 2000;
const NAVIGATION_PORT_CLOSURE_MESSAGES = new Set([
  "the message port closed before a response was received.",
  "a listener indicated an asynchronous response by returning true, but the message channel closed before a response was received.",
]);
const CONFIG_KEYS = ["serverUrl", "token", "expiresAt", "browserCommandDeviceId"];
const AUTHORIZATION_KEYS = ["token", "expiresAt", "browserCommandDeviceId"];
const MANUAL_CODES = new Set([
  "NEEDS_HUMAN",
  "SELECTOR_CHANGED",
  "SESSION_EXPIRED",
  "UNKNOWN",
  "EXECUTION_TAB_REQUIRED",
  "MYCASE_EVIDENCE_UNAVAILABLE",
  "MYCASE_EVIDENCE_AMBIGUOUS",
  "MYCASE_PAGE_REQUIRED",
  "MYCASE_PAGE_TIMEOUT",
  "ONLINE_FILING_PAGE_REQUIRED",
  "CASE_MATCH_AMBIGUOUS",
  "ACCOUNT_BINDING_REQUIRED",
  "ACCOUNT_MISMATCH",
  "ACCOUNT_DISABLED",
  "ACCOUNT_LABEL_UNAVAILABLE",
  "ACCOUNT_CONTACTS_UNAVAILABLE",
  "CREDENTIAL_UNAVAILABLE",
  "TEMPLATE_NOT_EMPTY",
  "PLATFORM_ACCOUNT_UNAVAILABLE",
  "DISCOVERY_BASELINE_MISSING",
  "NO_VISIBLE_CASES",
  "REPORT_EMPTY",
  "SCREENSHOT_CAPTURE_FAILED",
  "SOURCE_CASE_NAME_MISMATCH",
  "SOURCE_APPLICANT_MISMATCH",
  "SOURCE_RESPONDENT_MISMATCH",
  "SOURCE_CAUSE_MISMATCH",
  "SOURCE_APPLICATION_DATE_MISMATCH",
  "SOURCE_API_ROW_AMBIGUOUS",
  "MYCASE_RECORD_MISSING",
  "MYCASE_RECORD_UID_MISSING",
  "MYCASE_STATUS_MISMATCH",
  "SOURCE_API_ROW_MISSING",
  "MYCASE_ROWS_INVALID",
  "SOURCE_PLAINTIFF_MISSING",
  "SOURCE_DEFENDANT_MISSING",
  "SOURCE_CAUSE_MISSING",
  "SOURCE_ACCOUNT_MISSING",
  "SOURCE_COURT_MISSING",
  "SOURCE_TYPE_MISSING",
  "SOURCE_DATE_INVALID",
  "MYCASE_ACCOUNT_MISMATCH",
  "MYCASE_COURT_MISMATCH",
  "MYCASE_TYPE_MISMATCH",
  "MYCASE_CAUSE_MISMATCH",
  "MYCASE_DATE_MISMATCH",
  "MYCASE_PARTIES_TITLE_MISMATCH",
  "MYCASE_CASE_NUMBER_MISSING",
  "MYCASE_FILED_DATE_INVALID",
  "AUDIT_EVIDENCE_INCOMPLETE",
  "PARTY_EVIDENCE_INCOMPLETE",
  "API_DOM_MISMATCH",
  "API_SCHEMA_DRIFT",
  "PAGINATION_TOTAL_MISMATCH",
  "BATCH_LIMIT_EXCEEDED",
  "AUTH_REQUIRED",
  "LOGIN_REDIRECT",
  "API_NON_JSON",
  "API_INVALID_JSON",
  "API_REQUEST_FAILED",
  "API_SCHEMA_DRIFT",
  "UNKNOWN_STATUS",
  "QUERY_API_NOT_ALLOWED",
  "QUERY_API_SENDER_REJECTED",
  "BRIDGE_UNAVAILABLE",
  "BRIDGE_PROTOCOL_ERROR",
  "API_RESPONSE_TOO_LARGE",
  "API_SENSITIVE_RESPONSE",
  "COURT_TAB_ACTIVATION_FAILED",
  "QUERY_TAB_TIMEOUT",
  "LOGIN_PAGE_TIMEOUT",
  "LOGIN_CONTENT_UNAVAILABLE",
  "CONTENT_VERSION_MISMATCH",
]);

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function path(value) {
  return encodeURIComponent(String(value));
}

function exportCredentialErrorCode(error) {
  if (error?.status === 401 || error?.code === "AUTH_REQUIRED") throw error;
  if (error?.status === 404 || error?.code === "NOT_FOUND") return "PLATFORM_ACCOUNT_UNAVAILABLE";
  if (error?.code === "ACCOUNT_DISABLED") return "ACCOUNT_DISABLED";
  if (error?.code === "CREDENTIAL_UNAVAILABLE") return "CREDENTIAL_UNAVAILABLE";
  return "CREDENTIAL_FETCH_FAILED";
}

async function resolveExportIdentity(client, platformAccountId, signal, requireContacts = false) {
  let credential;
  try {
    credential = await client.request(`/platform-accounts/${path(platformAccountId)}/credential`, { method: "POST", signal });
  } catch (error) {
    return { ok: false, error: exportCredentialErrorCode(error) };
  }
  if (typeof credential?.account !== "string" || credential.account.length === 0
    || typeof credential?.password !== "string" || credential.password.length === 0) {
    return { ok: false, error: "CREDENTIAL_FETCH_FAILED" };
  }
  const salesperson = trim(credential.salespersonName);
  const assistant = trim(credential.assistantName);
  if (requireContacts && (!salesperson || !assistant)) {
    return { ok: false, error: "ACCOUNT_CONTACTS_UNAVAILABLE" };
  }

  let accountLabel = trim(credential.label);
  if (!accountLabel) {
    let accountList;
    try {
      accountList = await client.request("/platform-accounts", { signal });
    } catch (error) {
      if (error?.status === 401 || error?.code === "AUTH_REQUIRED") throw error;
      return { ok: false, error: "ACCOUNT_LABEL_UNAVAILABLE" };
    }
    const matches = (Array.isArray(accountList?.platformAccounts) ? accountList.platformAccounts : [])
      .filter((account) => account?.id === platformAccountId && trim(account?.label));
    if (matches.length !== 1) return { ok: false, error: "ACCOUNT_LABEL_UNAVAILABLE" };
    accountLabel = trim(matches[0].label);
  }

  return {
    ok: true,
    accountLabel,
    exportCredential: { account: credential.account, password: credential.password },
    ...(requireContacts ? { salesperson, assistant } : {}),
  };
}

function selectCourtTab(tabs, predicate) {
  const candidates = (Array.isArray(tabs) ? tabs : []).filter((tab) => {
    if (typeof tab?.id !== "number" || typeof tab.url !== "string") return false;
    try {
      const url = new URL(tab.url);
      if (url.hostname !== "zxfw.court.gov.cn") return false;
      return predicate(url, tab);
    } catch {
      return false;
    }
  });
  candidates.sort((left, right) => {
    const active = Number(right.active === true) - Number(left.active === true);
    if (active !== 0) return active;
    const recent = (Number.isFinite(right.lastAccessed) ? right.lastAccessed : -1)
      - (Number.isFinite(left.lastAccessed) ? left.lastAccessed : -1);
    if (recent !== 0) return recent;
    return left.id - right.id;
  });
  return candidates[0] ?? null;
}

function courtTab(tabs, commandType) {
  return selectCourtTab(
    tabs,
    (url) => {
      if (commandType === "LOGIN") return isLoginRoute(url.hash);
      if (commandType === "QUERY_LI" || commandType === "QUERY_QZ" || commandType === "QUERY_ALL_EXPORT") {
        return url.hash.split("?", 1)[0] === WSLA_LIST_ROUTE;
      }
      return isCourtListRoute(url.hash);
    },
  );
}

function anyCourtTab(tabs) {
  return selectCourtTab(tabs, () => true);
}

function isNavigationPortClosure(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim().toLowerCase();
  return NAVIGATION_PORT_CLOSURE_MESSAGES.has(normalized)
    || NAVIGATION_PORT_CLOSURE_MESSAGES.has(`${normalized}.`);
}

function isContentReceiverUnavailable(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim().toLowerCase();
  return normalized.includes("could not establish connection. receiving end does not exist")
    || isNavigationPortClosure(error);
}

function schedulerTimers(scheduler) {
  return {
    schedule: typeof scheduler?.setTimeout === "function"
      ? scheduler.setTimeout.bind(scheduler)
      : globalThis.setTimeout,
    cancel: typeof scheduler?.clearTimeout === "function"
      ? scheduler.clearTimeout.bind(scheduler)
      : globalThis.clearTimeout,
  };
}

function withMessageTimeout(chromeApi, tabId, message, scheduler, timeoutMs) {
  const delayMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1;
  const { schedule, cancel } = schedulerTimers(scheduler);
  return new Promise((resolve) => {
    let settled = false;
    let timerId;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      cancel(timerId);
      resolve(outcome);
    };
    timerId = schedule(() => finish({ timedOut: true }), delayMs);
    Promise.resolve()
      .then(() => chromeApi.tabs.sendMessage(tabId, message))
      .then((response) => finish({ response }), (error) => finish({ error }));
  });
}

function waitForContentRoute(scheduler, delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return Promise.resolve();
  const { schedule } = schedulerTimers(scheduler);
  return new Promise((resolve) => schedule(resolve, delayMs));
}

function retryAttempts(value) {
  return Math.max(1, Math.min(20, Number.isInteger(value) ? value : 8));
}

async function waitForLoginRoute(chromeApi, tabId, scheduler, delayMs, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const tabs = await chromeApi.tabs.query({ url: COURT_URL_PATTERN });
      const tab = (Array.isArray(tabs) ? tabs : []).find((candidate) => candidate?.id === tabId);
      if (tab && courtTab([tab], "LOGIN")) return tab;
    } catch {
      // The SPA may be rebuilding the tab while the user-initiated navigation completes.
    }
    if (attempt + 1 < attempts) await waitForContentRoute(scheduler, delayMs);
  }
  return null;
}

async function waitForLoginContent(chromeApi, tabId, scheduler, delayMs, attempts, timeoutMs) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const probeResult = await withMessageTimeout(
        chromeApi,
        tabId,
        { type: "PING" },
        scheduler,
        timeoutMs,
      );
      const route = probeResult.response?.route;
      if (probeResult.response?.ok === true && typeof route === "string" && isLoginRoute(route)) return true;
    } catch {
      // A newly injected content script can still be registering its message listener.
    }
    if (attempt + 1 < attempts) await waitForContentRoute(scheduler, delayMs);
  }
  return false;
}

async function waitForQueryAllExportContent(chromeApi, tabId, scheduler, delayMs, attempts, timeoutMs) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const probeResult = await withMessageTimeout(
        chromeApi,
        tabId,
        { type: "PING" },
        scheduler,
        timeoutMs,
      );
      const route = probeResult.response?.route;
      const routeReady = typeof route === "string" && route.split("?", 1)[0] === WSLA_LIST_ROUTE;
      if (probeResult.response?.ok === true
        && probeResult.response?.protocolVersion === CONTENT_PROTOCOL_VERSION
        && routeReady && probeResult.response?.ready === true) return true;
    } catch {
      // The SPA/content script can still be registering while the list controls render.
    }
    if (attempt + 1 < attempts) await waitForContentRoute(scheduler, delayMs);
  }
  return false;
}

async function ensureQueryContentVersion(chromeApi, tabId, scheduler, delayMs, attempts, timeoutMs) {
  const probe = await withMessageTimeout(chromeApi, tabId, { type: "PING" }, scheduler, timeoutMs);
  if (probe.response?.protocolVersion === CONTENT_PROTOCOL_VERSION) return true;
  if (typeof chromeApi.tabs?.reload !== "function") return false;
  try {
    await chromeApi.tabs.reload(tabId);
  } catch {
    return false;
  }
  return waitForQueryAllExportContent(chromeApi, tabId, scheduler, delayMs, attempts, timeoutMs);
}

function resultFor(response, commandType) {
  if (commandType === "QUERY_ALL_EXPORT"
    && (response?.status === "uploaded" || response?.ok === true)
    && response?.evidenceClosed !== true) {
    return {
      status: "manual_required",
      resultCode: "EVIDENCE_NOT_CLOSED",
      resultSummary: "证据未完成服务器闭环",
    };
  }
  if (response?.status === "uploaded") {
    return { status: "succeeded", resultCode: "SUCCESS", resultSummary: "报表已上传服务器" };
  }
  if (response?.status === "not_configured") {
    return { status: "manual_required", resultCode: "NOT_CONFIGURED", resultSummary: "本地文件已保存，服务器未配置" };
  }
  if (response?.status === "failed") {
    const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(response?.code ?? "") ? response.code : "UPLOAD_FAILED";
    return { status: "manual_required", resultCode: code, resultSummary: "本地文件已保存，上传失败" };
  }
  if (response?.ok === true) {
    return { status: "succeeded", resultCode: "SUCCESS", resultSummary: "任务已完成" };
  }
  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(response?.error ?? "") ? response.error : "NEEDS_HUMAN";
  if (code === "ACCOUNT_BINDING_REQUIRED") {
    return {
      status: "manual_required",
      resultCode: code,
      resultSummary: "请先对同一平台账号执行一键登录",
    };
  }
  return {
    status: MANUAL_CODES.has(code) ? "manual_required" : "failed",
    resultCode: code,
    resultSummary: MANUAL_CODES.has(code) ? "需要人工接管" : "任务执行失败",
  };
}

export function createBrowserCommandPoller({
  chromeApi = globalThis.chrome,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  scheduler = globalThis,
  now = Date.now,
  intervalMs = POLL_INTERVAL_MS,
  contentRouteRetryDelayMs = 500,
  contentRouteRetryAttempts = 8,
  contentRoutePingTimeoutMs = CONTENT_ROUTE_PING_TIMEOUT_MS,
  initialActivePlatformAccountId = null,
  onExecutionStart,
  onExecutionEnd,
} = {}) {
  let intervalId = null;
  let inFlight = false;
  let configurationGeneration = 0;
  let activeRequestController = null;
  let activePlatformAccountId = trim(initialActivePlatformAccountId) || null;

  function isCurrentGeneration(generation) {
    return generation === configurationGeneration;
  }

  function configurationChanged() {
    return { ok: false, reason: "CONFIG_CHANGED" };
  }

  async function config() {
    if (!chromeApi?.storage?.local?.get) return null;
    const stored = await chromeApi.storage.local.get(CONFIG_KEYS);
    const serverUrl = trim(stored.serverUrl);
    const token = trim(stored.token);
    if (!serverUrl || !token || Number(stored.expiresAt) <= now()) return null;
    let deviceId = trim(stored.browserCommandDeviceId);
    if (!deviceId) {
      deviceId = globalThis.crypto?.randomUUID?.() ?? `device-${Math.random().toString(16).slice(2, 18)}`;
      await chromeApi.storage.local.set({ browserCommandDeviceId: deviceId });
    }
    return { client: createRemoteClient({ baseUrl: serverUrl, token, fetchImpl }), deviceId };
  }

  async function writeResult(client, commandId, claimToken, deviceId, response, signal, commandType) {
    return client.request(`/browser-commands/${path(commandId)}/result`, {
      method: "POST",
      body: {
        deviceId,
        claimToken,
        ...resultFor(response, commandType),
        progress: response?.progress ?? null,
        ...(commandType === "QUERY_ALL_EXPORT" ? {
          evidenceClosed: response?.evidenceClosed === true,
          evidenceEventIds: Array.isArray(response?.evidenceEventIds) ? response.evidenceEventIds : [],
        } : {}),
      },
      signal,
    });
  }

  async function execute(client, command, claimToken, deviceId, { generation, signal } = {}) {
    if (!isCurrentGeneration(generation)) return { ok: false, error: "CONFIG_CHANGED" };
    const tabs = await chromeApi.tabs.query({ url: COURT_URL_PATTERN });
    if (!isCurrentGeneration(generation)) return { ok: false, error: "CONFIG_CHANGED" };
    let tab = courtTab(tabs, command.type);
    if (command.type === "LOGIN" && !tab) {
      const selectedTab = anyCourtTab(tabs);
      if (!selectedTab) return { ok: false, error: "NO_COURT_TAB" };
      const attempts = retryAttempts(contentRouteRetryAttempts);
      tab = await waitForLoginRoute(chromeApi, selectedTab.id, scheduler, contentRouteRetryDelayMs, attempts);
      if (!tab) return { ok: false, error: "LOGIN_PAGE_TIMEOUT" };
    }
    if (!tab) {
      const hasCourtTab = Array.isArray(tabs) && tabs.some((candidate) => {
        try {
          return new URL(candidate?.url).hostname === "zxfw.court.gov.cn";
        } catch {
          return false;
        }
      });
      if ((command.type === "QUERY_LI" || command.type === "QUERY_QZ" || command.type === "QUERY_ALL_EXPORT") && hasCourtTab) {
        return { ok: false, error: "ONLINE_FILING_PAGE_REQUIRED" };
      }
      return { ok: false, error: "NO_COURT_TAB" };
    }
    if (typeof chromeApi.tabs.update === "function") {
      try {
        await chromeApi.tabs.update(tab.id, { active: true });
      } catch {
        return { ok: false, error: "COURT_TAB_ACTIVATION_FAILED" };
      }
    }
    if (!isCurrentGeneration(generation)) return { ok: false, error: "CONFIG_CHANGED" };
    let message = { type: "BROWSER_COMMAND_EXECUTE", commandType: command.type };
    if (command.type === "LOGIN") {
      const attempts = retryAttempts(contentRouteRetryAttempts);
      const contentReady = await waitForLoginContent(
        chromeApi,
        tab.id,
        scheduler,
        contentRouteRetryDelayMs,
        attempts,
        contentRoutePingTimeoutMs,
      );
      if (!contentReady) return { ok: false, error: "LOGIN_CONTENT_UNAVAILABLE" };
      if (!isCurrentGeneration(generation)) return { ok: false, error: "CONFIG_CHANGED" };
      let credential;
      try {
        credential = await client.request(`/platform-accounts/${path(command.platformAccountId)}/credential`, { method: "POST", signal });
      } catch {
        return { ok: false, error: "CREDENTIAL_FETCH_FAILED" };
      }
      if (!isCurrentGeneration(generation)) return { ok: false, error: "CONFIG_CHANGED" };
      message = { ...message, account: credential?.account, password: credential?.password, serviceUrl: "http://127.0.0.1:8765" };
    } else if (command.type === "QUERY_LI" || command.type === "QUERY_QZ" || command.type === "QUERY_ALL_EXPORT") {
      if (command.type === "QUERY_ALL_EXPORT" && activePlatformAccountId === null) {
        return { ok: false, error: "ACCOUNT_BINDING_REQUIRED" };
      }
      if (activePlatformAccountId !== null && activePlatformAccountId !== command.platformAccountId) {
        return { ok: false, error: "ACCOUNT_MISMATCH" };
      }
      if (command.type === "QUERY_ALL_EXPORT") {
        const attempts = retryAttempts(contentRouteRetryAttempts);
        const currentContent = await ensureQueryContentVersion(
          chromeApi,
          tab.id,
          scheduler,
          contentRouteRetryDelayMs,
          attempts,
          contentRoutePingTimeoutMs,
        );
        if (!currentContent) return { ok: false, error: "CONTENT_VERSION_MISMATCH" };
        if (!isCurrentGeneration(generation)) return { ok: false, error: "CONFIG_CHANGED" };
      }
      let data;
      try {
        data = await client.request(`/import-batches/${path(command.clientBatchId)}/extension-data`, {
          headers: {
            "x-browser-command-id": command.id,
            "x-browser-command-device": deviceId,
            "x-browser-command-claim": claimToken,
          },
          signal,
        });
      } catch (error) {
        return { ok: false, error: error?.code === "IMPORT_BATCH_EXPIRED" ? "NEEDS_HUMAN" : "BATCH_DATA_UNAVAILABLE" };
      }
      if (!isCurrentGeneration(generation)) return { ok: false, error: "CONFIG_CHANGED" };
      if (data?.queryMode === "platform_discovery") {
        message = { ...message, queryMode: "platform_discovery", platformAccountId: command.platformAccountId };
      } else if (data?.queryMode === "template_not_empty") {
        return { ok: false, error: "TEMPLATE_NOT_EMPTY" };
      } else {
        return { ok: false, error: "TEMPLATE_NOT_EMPTY" };
      }
    } else if (command.type === "EXPORT_REPORT") {
      if (typeof command.platformAccountId !== "string" || !command.platformAccountId) {
        return { ok: false, error: "PLATFORM_ACCOUNT_UNAVAILABLE" };
      }
      message = { ...message, platformAccountId: command.platformAccountId };
    }
    if (command.type === "QUERY_ALL_EXPORT") {
      message = {
        ...message,
        accountBindingVerified: true,
      };
      const attempts = retryAttempts(contentRouteRetryAttempts);
      const contentReady = await waitForQueryAllExportContent(
        chromeApi,
        tab.id,
        scheduler,
        contentRouteRetryDelayMs,
        attempts,
        contentRoutePingTimeoutMs,
      );
      if (!contentReady) return { ok: false, error: "CONTENT_UNAVAILABLE" };
      if (!isCurrentGeneration(generation)) return { ok: false, error: "CONFIG_CHANGED" };
    }
    if (command.type === "QUERY_ALL_EXPORT" || command.type === "EXPORT_REPORT") {
      const exportIdentity = await resolveExportIdentity(client, command.platformAccountId, signal, command.type === "QUERY_ALL_EXPORT");
      if (!isCurrentGeneration(generation)) return { ok: false, error: "CONFIG_CHANGED" };
      if (!exportIdentity.ok) return exportIdentity;
      message = {
        ...message,
        accountLabel: exportIdentity.accountLabel,
        exportCredential: exportIdentity.exportCredential,
        ...(command.type === "QUERY_ALL_EXPORT" ? {
          salesperson: exportIdentity.salesperson,
          assistant: exportIdentity.assistant,
        } : {}),
      };
    }
    try {
      if (!isCurrentGeneration(generation)) return { ok: false, error: "CONFIG_CHANGED" };
      const response = await chromeApi.tabs.sendMessage(tab.id, message);
      if (command.type === "LOGIN" && response?.ok === true) {
        activePlatformAccountId = command.platformAccountId;
      }
      return response;
    } catch (error) {
      if (command.type === "LOGIN" && isContentReceiverUnavailable(error)) {
        const attempts = retryAttempts(contentRouteRetryAttempts);
        const contentReady = await waitForLoginContent(
          chromeApi,
          tab.id,
          scheduler,
          contentRouteRetryDelayMs,
          attempts,
          contentRoutePingTimeoutMs,
        );
        if (!contentReady) return { ok: false, error: "LOGIN_CONTENT_UNAVAILABLE" };
        try {
          const response = await chromeApi.tabs.sendMessage(tab.id, message);
          if (response?.ok === true) activePlatformAccountId = command.platformAccountId;
          return response;
        } catch {
          return { ok: false, error: "LOGIN_CONTENT_UNAVAILABLE" };
        }
      }
      return { ok: false, error: "CONTENT_UNAVAILABLE" };
    }
  }

  async function pollOnce() {
    if (inFlight) return { ok: false, skipped: "IN_FLIGHT" };
    inFlight = true;
    const generation = configurationGeneration;
    const controller = new AbortController();
    activeRequestController = controller;
    try {
      const runtime = await config();
      if (!isCurrentGeneration(generation)) return configurationChanged();
      if (!runtime?.client) return { ok: false, reason: "NOT_CONFIGURED" };
      const next = await runtime.client.request("/browser-commands/next", { signal: controller.signal });
      if (!isCurrentGeneration(generation)) return configurationChanged();
      if (!next?.command) return { ok: true, command: null };
      const claim = await runtime.client.request(`/browser-commands/${path(next.command.id)}/claim`, {
        method: "POST",
        body: { deviceId: runtime.deviceId },
        signal: controller.signal,
      });
      if (!isCurrentGeneration(generation)) return configurationChanged();
      if (!claim?.claimToken) return { ok: false, reason: "CLAIM_TOKEN_UNAVAILABLE" };
      onExecutionStart?.({ commandId: claim.command.id, deviceId: runtime.deviceId, claimToken: claim.claimToken });
      try {
        const response = await execute(runtime.client, claim.command, claim.claimToken, runtime.deviceId, { generation, signal: controller.signal });
        if (!isCurrentGeneration(generation)) return configurationChanged();
        await writeResult(
          runtime.client,
          claim.command.id,
          claim.claimToken,
          runtime.deviceId,
          response,
          controller.signal,
          claim.command.type,
        );
        if (!isCurrentGeneration(generation)) return configurationChanged();
        return { ...response, commandId: claim.command.id };
      } finally {
        onExecutionEnd?.(claim.command.id);
      }
    } catch (error) {
      if (!isCurrentGeneration(generation)) return configurationChanged();
      if (error?.status === 401 || error?.code === "AUTH_REQUIRED") {
        stop({ invalidate: false });
        if (typeof chromeApi?.storage?.local?.remove === "function") {
          await chromeApi.storage.local.remove(AUTHORIZATION_KEYS);
        } else {
          await chromeApi?.storage?.local?.set?.({ token: undefined, expiresAt: undefined, browserCommandDeviceId: undefined });
        }
        return { ok: false, reason: "AUTH_REQUIRED" };
      }
      return { ok: false, reason: error?.code ?? "REMOTE_ERROR" };
    } finally {
      if (activeRequestController === controller) activeRequestController = null;
      inFlight = false;
    }
  }

  function ensureAlarm() {
    chromeApi?.alarms?.create?.(BROWSER_COMMAND_ALARM_NAME, { periodInMinutes: BROWSER_COMMAND_ALARM_PERIOD_MINUTES });
  }

  async function start({ immediate = true } = {}) {
    const generation = configurationGeneration;
    const runtime = await config();
    if (!isCurrentGeneration(generation)) return configurationChanged();
    if (!runtime?.client) return { ok: false, reason: "NOT_CONFIGURED" };
    if (intervalId == null) intervalId = scheduler.setInterval?.(() => { pollOnce().catch(() => {}); }, intervalMs);
    ensureAlarm();
    return immediate ? pollOnce() : { ok: true };
  }

  function stop({ invalidate = true } = {}) {
    if (invalidate) {
      configurationGeneration += 1;
      activeRequestController?.abort("configuration changed");
      activeRequestController = null;
      activePlatformAccountId = null;
    }
    if (intervalId != null) scheduler.clearInterval?.(intervalId);
    intervalId = null;
    chromeApi?.alarms?.clear?.(BROWSER_COMMAND_ALARM_NAME);
  }

  return { pollOnce, start, stop, ensureAlarm, isInFlight: () => inFlight, isRunning: () => intervalId != null };
}
