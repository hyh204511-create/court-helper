import { createRemoteClient } from "../data/remote-client.js";
import { isLoginRoute } from "../content/login-detector.js";

export const BROWSER_COMMAND_ALARM_NAME = "browser-command-poll";
export const BROWSER_COMMAND_ALARM_PERIOD_MINUTES = 1;
const COURT_URL_PATTERN = "https://zxfw.court.gov.cn/*";
const POLL_INTERVAL_MS = 3000;
const CONFIG_KEYS = ["serverUrl", "token", "expiresAt", "browserCommandDeviceId"];
const AUTHORIZATION_KEYS = ["token", "expiresAt", "browserCommandDeviceId"];
const MANUAL_CODES = new Set(["NEEDS_HUMAN", "SELECTOR_CHANGED", "SESSION_EXPIRED", "UNKNOWN"]);

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
      return commandType === "LOGIN" ? isLoginRoute(url.hash) : !isLoginRoute(url.hash);
    } catch {
      return false;
    }
  }) ?? null;
}

function resultFor(response) {
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
      message = { ...message, rows: data?.rows ?? [] };
    }
    try {
      if (!isCurrentGeneration(generation)) return { ok: false, error: "CONFIG_CHANGED" };
      return await chromeApi.tabs.sendMessage(tab.id, message);
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
    }
    if (intervalId != null) scheduler.clearInterval?.(intervalId);
    intervalId = null;
    chromeApi?.alarms?.clear?.(BROWSER_COMMAND_ALARM_NAME);
  }

  return { pollOnce, start, stop, ensureAlarm, isInFlight: () => inFlight, isRunning: () => intervalId != null };
}
