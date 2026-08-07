import { createRemoteClient } from "../data/remote-client.js";
import { isCourtListRoute, isLoginRoute } from "../content/login-detector.js";

export const BROWSER_COMMAND_ALARM_NAME = "browser-command-poll";
export const BROWSER_COMMAND_ALARM_PERIOD_MINUTES = 1;
const COURT_URL_PATTERN = "https://zxfw.court.gov.cn/*";
const POLL_INTERVAL_MS = 3000;
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
  "CASE_MATCH_AMBIGUOUS",
  "ACCOUNT_MISMATCH",
  "TEMPLATE_NOT_EMPTY",
  "PLATFORM_ACCOUNT_UNAVAILABLE",
]);

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function path(value) {
  return encodeURIComponent(String(value));
}

function courtTab(tabs, commandType) {
  return (Array.isArray(tabs) ? tabs : []).find((tab) => {
    if (typeof tab?.id !== "number" || typeof tab.url !== "string") return false;
    try {
      const url = new URL(tab.url);
      if (url.hostname !== "zxfw.court.gov.cn") return false;
      return commandType === "LOGIN" ? isLoginRoute(url.hash) : isCourtListRoute(url.hash);
    } catch {
      return false;
    }
  }) ?? null;
}

function resultFor(response) {
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
} = {}) {
  let intervalId = null;
  let inFlight = false;
  let configurationGeneration = 0;
  let activeRequestController = null;
  let activePlatformAccountId = null;

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

  async function writeResult(client, commandId, claimToken, deviceId, response, signal) {
    return client.request(`/browser-commands/${path(commandId)}/result`, {
      method: "POST",
      body: { deviceId, claimToken, ...resultFor(response), progress: response?.progress ?? null },
      signal,
    });
  }

  async function execute(client, command, claimToken, deviceId, { generation, signal } = {}) {
    if (!isCurrentGeneration(generation)) return { ok: false, error: "CONFIG_CHANGED" };
    const tabs = await chromeApi.tabs.query({ url: COURT_URL_PATTERN });
    if (!isCurrentGeneration(generation)) return { ok: false, error: "CONFIG_CHANGED" };
    const tab = courtTab(tabs, command.type);
    if (!tab) return { ok: false, error: "NO_COURT_TAB" };
    let message = { type: "BROWSER_COMMAND_EXECUTE", commandType: command.type };
    if (command.type === "LOGIN") {
      let credential;
      try {
        credential = await client.request(`/platform-accounts/${path(command.platformAccountId)}/credential`, { method: "POST", signal });
      } catch {
        return { ok: false, error: "CREDENTIAL_FETCH_FAILED" };
      }
      if (!isCurrentGeneration(generation)) return { ok: false, error: "CONFIG_CHANGED" };
      message = { ...message, account: credential?.account, password: credential?.password, serviceUrl: "http://127.0.0.1:8765" };
    } else if (command.type === "QUERY_LI" || command.type === "QUERY_QZ") {
      if (activePlatformAccountId !== null && activePlatformAccountId !== command.platformAccountId) {
        return { ok: false, error: "ACCOUNT_MISMATCH" };
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
      if (activePlatformAccountId === null) return { ok: false, error: "PLATFORM_ACCOUNT_UNAVAILABLE" };
      message = { ...message, platformAccountId: activePlatformAccountId };
    }
    try {
      if (!isCurrentGeneration(generation)) return { ok: false, error: "CONFIG_CHANGED" };
      const response = await chromeApi.tabs.sendMessage(tab.id, message);
      if (command.type === "LOGIN" && response?.ok === true) {
        activePlatformAccountId = command.platformAccountId;
      }
      return response;
    } catch {
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
      const response = await execute(runtime.client, claim.command, claim.claimToken, runtime.deviceId, { generation, signal: controller.signal });
      if (!isCurrentGeneration(generation)) return configurationChanged();
      await writeResult(runtime.client, claim.command.id, claim.claimToken, runtime.deviceId, response, controller.signal);
      if (!isCurrentGeneration(generation)) return configurationChanged();
      return { ...response, commandId: claim.command.id };
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
