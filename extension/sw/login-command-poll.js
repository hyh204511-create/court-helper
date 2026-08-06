import { createRemoteClient } from "../data/remote-client.js";
import { isLoginRoute } from "../content/login-detector.js";

export const ENABLE_REMOTE_LOGIN = "ENABLE_REMOTE_LOGIN";
export const DISABLE_REMOTE_LOGIN = "DISABLE_REMOTE_LOGIN";
export const REMOTE_LOGIN_STATUS_REQUEST = "REMOTE_LOGIN_STATUS_REQUEST";

const CONFIG_KEYS = Object.freeze(["serverUrl", "serverUsername", "remoteLoginEnabled", "legacyRemoteLoginEnabled", "token", "expiresAt"]);
const TOKEN_KEYS = Object.freeze(["token", "expiresAt"]);
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
export const REMOTE_LOGIN_ALARM_NAME = "remote-login-poll";
export const REMOTE_LOGIN_ALARM_PERIOD_MINUTES = 1;
const LOGIN_SERVICE_URL = "http://127.0.0.1:8765";
const COURT_URL_PATTERN = "https://zxfw.court.gov.cn/*";
const SAFE_CONTENT_CODES = new Set([
  "SERVICE_UNAVAILABLE",
  "FORM_NOT_READY",
  "OCR_FAILED",
  "LOGIN_TIMEOUT",
  "NEEDS_HUMAN",
  "NOT_LOGIN_ROUTE",
  "BUSY",
]);

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeConfig(stored = {}, now = Date.now()) {
  const serverUrl = trimString(stored.serverUrl);
  const serverUsername = trimString(stored.serverUsername);
  const token = trimString(stored.token);
  const expiresAt = Number(stored.expiresAt);
  const enabled = stored.remoteLoginEnabled === true && stored.legacyRemoteLoginEnabled !== false;
  return {
    serverUrl,
    serverUsername,
    enabled,
    token,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    configured: Boolean(serverUrl && serverUsername),
    hasValidToken: Boolean(token && Number.isFinite(expiresAt) && expiresAt > now),
    hasToken: Boolean(token),
  };
}

function pathPart(value) {
  return encodeURIComponent(String(value));
}

function isAuthFailure(error) {
  return error?.status === 401 || error?.status === 403 || error?.code === "AUTH_REQUIRED" || error?.code === "FORBIDDEN";
}

function commandFromBody(body) {
  if (body?.command && typeof body.command === "object") return body.command;
  if (Array.isArray(body?.commands) && body.commands[0]) return body.commands[0];
  return null;
}

function isCourtLoginTab(tab = {}) {
  if (!Number.isFinite(tab.id) && typeof tab.id !== "number") return false;
  if (typeof tab.url !== "string") return false;
  let parsed;
  try {
    parsed = new URL(tab.url);
  } catch {
    return false;
  }
  return parsed.hostname === "zxfw.court.gov.cn" && isLoginRoute(parsed.hash);
}

async function readConfig(chromeApi, now) {
  const stored = await chromeApi.storage.local.get(CONFIG_KEYS);
  return normalizeConfig(stored, now);
}

async function writeResult(client, commandId, body) {
  await client.request(`/login-commands/${pathPart(commandId)}/result`, {
    method: "POST",
    body,
  });
}

function credentialUsable(credential) {
  return typeof credential?.account === "string"
    && credential.account.trim() !== ""
    && typeof credential?.password === "string"
    && credential.password !== "";
}

function contentFailureCode(response) {
  if (SAFE_CONTENT_CODES.has(response?.error)) return response.error;
  return "NEEDS_HUMAN";
}

export function createLoginCommandPoller({
  chromeApi = globalThis.chrome,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  scheduler = globalThis,
  now = Date.now,
  intervalMs = POLL_INTERVAL_MS,
  serviceUrl = LOGIN_SERVICE_URL,
} = {}) {
  let intervalId = null;
  let inFlight = false;
  let lastStatus = "stopped";
  let lastReason = null;

  function ensureAlarm() {
    try {
      chromeApi?.alarms?.create?.(REMOTE_LOGIN_ALARM_NAME, {
        periodInMinutes: REMOTE_LOGIN_ALARM_PERIOD_MINUTES,
      });
    } catch {
      // Alarm support is best-effort; the 3s interval still runs while the SW is alive.
    }
  }

  function clearAlarm() {
    try {
      chromeApi?.alarms?.clear?.(REMOTE_LOGIN_ALARM_NAME);
    } catch {
      // Clearing failure should not block token removal or interval cleanup.
    }
  }

  function clearTimer() {
    if (intervalId == null) return;
    scheduler.clearInterval?.(intervalId);
    intervalId = null;
  }

  function setPaused(reason) {
    clearTimer();
    clearAlarm();
    lastReason = reason;
    lastStatus = reason === "TOKEN_EXPIRED" || reason === "TOKEN_INVALID" ? "token-expired" : "stopped";
  }

  async function clearStoredToken() {
    if (!chromeApi?.storage?.local) return;
    if (typeof chromeApi.storage.local.remove === "function") {
      await chromeApi.storage.local.remove(TOKEN_KEYS);
    } else {
      await chromeApi.storage.local.set({ token: undefined, expiresAt: undefined });
    }
  }

  async function pauseForInvalidToken() {
    setPaused("TOKEN_INVALID");
    await clearStoredToken();
  }

  async function stop({ clearToken = false, disable = false } = {}) {
    clearTimer();
    clearAlarm();
    lastStatus = "stopped";
    lastReason = null;
    if (!chromeApi?.storage?.local) return { ok: true };
    const writes = {};
    if (disable) writes.remoteLoginEnabled = false;
    if (Object.keys(writes).length) await chromeApi.storage.local.set(writes);
    if (clearToken) await clearStoredToken();
    return { ok: true };
  }

  async function disable() {
    return stop({ clearToken: true, disable: true });
  }

  async function getClient() {
    if (!chromeApi?.storage?.local?.get) return { ok: false, reason: "STORAGE_UNAVAILABLE" };
    const config = await readConfig(chromeApi, now());
    if (!config.enabled) return { ok: false, reason: "DISABLED" };
    if (!config.configured) return { ok: false, reason: "NOT_CONFIGURED" };
    if (!config.hasValidToken) return { ok: false, reason: "TOKEN_EXPIRED", config };
    const client = createRemoteClient({ baseUrl: config.serverUrl, token: config.token, fetchImpl });
    if (!client) return { ok: false, reason: "NOT_CONFIGURED" };
    return { ok: true, client, config };
  }

  async function findLoginTab() {
    const tabs = await chromeApi.tabs.query({ url: COURT_URL_PATTERN });
    return (Array.isArray(tabs) ? tabs : []).find(isCourtLoginTab) ?? null;
  }

  async function executeCommand(client, command) {
    if (!command?.id || !command?.platformAccountId) return { ok: false, command: null };
    const tab = await findLoginTab();
    if (!tab) {
      await writeResult(client, command.id, { ok: false, code: "NO_TAB" });
      return { ok: false, commandId: command.id, code: "NO_TAB" };
    }

    let ping;
    try {
      ping = await chromeApi.tabs.sendMessage(tab.id, { type: "PING" });
    } catch {
      await writeResult(client, command.id, { ok: false, code: "FORM_NOT_READY" });
      return { ok: false, commandId: command.id, code: "FORM_NOT_READY" };
    }
    if (ping?.state === "logged-in") {
      await writeResult(client, command.id, { ok: true });
      return { ok: true, commandId: command.id };
    }

    let credential;
    try {
      credential = await client.request(`/platform-accounts/${pathPart(command.platformAccountId)}/credential`, {
        method: "POST",
      });
    } catch {
      await writeResult(client, command.id, { ok: false, code: "CREDENTIAL_FETCH_FAILED" });
      return { ok: false, commandId: command.id, code: "CREDENTIAL_FETCH_FAILED" };
    }
    if (!credentialUsable(credential)) {
      await writeResult(client, command.id, { ok: false, code: "CREDENTIAL_FETCH_FAILED" });
      return { ok: false, commandId: command.id, code: "CREDENTIAL_FETCH_FAILED" };
    }

    let response;
    try {
      response = await chromeApi.tabs.sendMessage(tab.id, {
        type: "AUTO_LOGIN",
        account: credential.account,
        password: credential.password,
        serviceUrl,
      });
    } catch {
      response = { ok: false, error: "FORM_NOT_READY" };
    }
    if (response?.ok === true) {
      await writeResult(client, command.id, { ok: true });
      return { ok: true, commandId: command.id };
    }
    const code = contentFailureCode(response);
    await writeResult(client, command.id, { ok: false, code });
    return { ok: false, commandId: command.id, code };
  }

  async function pollOnce() {
    if (inFlight) return { ok: false, skipped: "IN_FLIGHT" };
    inFlight = true;
    try {
      const clientResult = await getClient();
      if (!clientResult.ok) {
        if (clientResult.reason !== "DISABLED" && clientResult.reason !== "NOT_CONFIGURED") {
          setPaused(clientResult.reason);
        }
        return { ok: false, reason: clientResult.reason };
      }
      let body;
      try {
        body = await clientResult.client.request("/login-commands?status=pending");
      } catch (error) {
        if (isAuthFailure(error)) await pauseForInvalidToken();
        return { ok: false, reason: isAuthFailure(error) ? "TOKEN_INVALID" : "REMOTE_ERROR" };
      }
      const command = commandFromBody(body);
      if (!command) return { ok: false, command: null };
      return executeCommand(clientResult.client, command);
    } finally {
      inFlight = false;
    }
  }

  async function start({ immediate = true } = {}) {
    const clientResult = await getClient();
    if (!clientResult.ok) {
      setPaused(clientResult.reason);
      return { ok: false, reason: clientResult.reason };
    }
    if (intervalId == null) {
      intervalId = scheduler.setInterval?.(() => {
        pollOnce().catch(() => {});
      }, intervalMs);
    }
    ensureAlarm();
    lastStatus = "running";
    lastReason = null;
    if (immediate) return pollOnce();
    return { ok: true };
  }

  async function enable() {
    // The old flow traded a password supplied to the popup for an extension token.
    // Tokens are now minted only through explicit administrator device pairing.
    return { ok: false, reason: "PAIRING_REQUIRED" };
  }

  async function getStatus() {
    let config = {};
    try {
      if (chromeApi?.storage?.local?.get) {
        config = await readConfig(chromeApi, now());
      }
    } catch {
      return {
        enabled: false,
        status: "stopped",
        running: false,
        inFlight,
        expiresAt: 0,
        hasToken: false,
      };
    }
    let status = lastStatus;
    if (!config.enabled) status = "stopped";
    else if (!config.configured) status = "not-configured";
    else if (!config.hasValidToken) status = "token-expired";
    else if (intervalId != null) status = "running";
    return {
      enabled: config.enabled,
      status,
      running: status === "running",
      inFlight,
      expiresAt: config.expiresAt,
      hasToken: config.hasToken,
    };
  }

  return {
    start,
    stop,
    disable,
    enable,
    pollOnce,
    getStatus,
    ensureAlarm,
    clearAlarm,
    isRunning: () => intervalId != null,
    isInFlight: () => inFlight,
  };
}
