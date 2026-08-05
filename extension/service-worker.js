import { handleMessage, sanitizeLoginState } from "./shared/message-router.js";
import { sanitizeSyncState } from "./shared/message-router.js";
import { createRemoteClient } from "./data/remote-client.js";
import { createSyncCoordinator } from "./data/sync-coordinator.js";
import { createDebuggerDriver } from "./sw/debugger-driver.js";
import {
  DISABLE_REMOTE_LOGIN,
  ENABLE_REMOTE_LOGIN,
  REMOTE_LOGIN_ALARM_NAME,
  REMOTE_LOGIN_STATUS_REQUEST,
  createLoginCommandPoller,
} from "./sw/login-command-poll.js";

const SYNC_STATUS_REQUEST = "SYNC_STATUS_REQUEST";
const SYNC_CONFIG_KEYS = Object.freeze([
  "syncServerUrl",
  "syncDeviceToken",
  "syncConfig",
  "serverUrl",
  "baseUrl",
  "deviceToken",
  "token",
]);
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

let syncCoordinator = null;
let remoteClient = null;
let syncGeneration = 0;
export let syncInitialization = Promise.resolve(null);
const debuggerDriver = createDebuggerDriver();
const loginCommandPoller = createLoginCommandPoller();

function stringValue(...values) {
  return values.find((value) => typeof value === "string" && value.trim() !== "")?.trim() ?? "";
}

function bytesFromBase64(value) {
  if (typeof value !== "string" || value === "") {
    throw Object.assign(new TypeError("export base64 required"), { code: "EXPORT_BASE64_REQUIRED" });
  }
  let binary;
  if (typeof globalThis.atob === "function") {
    binary = globalThis.atob(value);
  } else {
    const BufferImpl = globalThis.Buffer;
    if (typeof BufferImpl?.from !== "function") {
      throw Object.assign(new Error("base64 decoder unavailable"), { code: "BASE64_UNAVAILABLE" });
    }
    return Uint8Array.from(BufferImpl.from(value, "base64"));
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function readSyncConfig(chromeApi = globalThis.chrome) {
  const storage = chromeApi?.storage?.local;
  if (typeof storage?.get !== "function") return null;
  try {
    const stored = await storage.get(SYNC_CONFIG_KEYS);
    const nested = stored?.syncConfig && typeof stored.syncConfig === "object" ? stored.syncConfig : {};
    const baseUrl = stringValue(
      stored?.syncServerUrl,
      stored?.serverUrl,
      stored?.baseUrl,
      nested.serverUrl,
      nested.baseUrl,
    );
    const token = stringValue(
      stored?.syncDeviceToken,
      stored?.deviceToken,
      stored?.token,
      nested.deviceToken,
      nested.token,
    );
    return baseUrl && token ? { baseUrl, token } : null;
  } catch {
    return null;
  }
}

function publishSyncStatus(chromeApi, state) {
  const payload = sanitizeSyncState(state);
  try {
    const result = chromeApi?.runtime?.sendMessage?.({ type: "SYNC_STATUS", payload });
    Promise.resolve(result).catch(() => {});
  } catch {
    // content script may have been unloaded while the service worker was publishing state.
  }
}

function stopSyncCoordinator() {
  const coordinator = syncCoordinator;
  syncCoordinator = null;
  remoteClient = null;
  try {
    coordinator?.stop?.();
  } catch {
    // A stale coordinator must not prevent the replacement from starting.
  }
}

function currentSyncState() {
  return sanitizeSyncState(syncCoordinator?.getState?.() ?? {
    status: "disabled",
    pendingCount: 0,
    cursor: 0,
    lastSyncAt: null,
    conflicts: [],
    message: "未配置服务器",
  });
}

export async function initializeSyncCoordinator({
  chromeApi = globalThis.chrome,
  fetchImpl = globalThis.fetch,
  scheduler = globalThis,
  document = globalThis.document,
  immediate = true,
} = {}) {
  if (syncCoordinator && remoteClient) return syncCoordinator;
  const generation = syncGeneration;
  const config = await readSyncConfig(chromeApi);
  if (generation !== syncGeneration) return null;
  if (!config) {
    remoteClient = null;
    return null;
  }
  const client = createRemoteClient({
    baseUrl: config.baseUrl,
    token: config.token,
    fetchImpl,
  });
  if (!client) return null;
  if (generation !== syncGeneration) return null;
  remoteClient = client;

  const coordinator = createSyncCoordinator({
    client,
    document,
    scheduler,
    onState: (state) => publishSyncStatus(chromeApi, state),
  });
  if (generation !== syncGeneration) {
    coordinator.stop?.();
    return null;
  }
  syncCoordinator = coordinator;
  try {
    await coordinator.start({ immediate });
  } catch {
    // A storage/open failure must not prevent the service worker message router from loading.
  }
  return coordinator;
}

function queueSyncRebuild() {
  syncGeneration += 1;
  stopSyncCoordinator();
  const previousInitialization = syncInitialization;
  syncInitialization = Promise.resolve(previousInitialization)
    .catch(() => null)
    .then(() => initializeSyncCoordinator())
    .catch(() => null);
  return syncInitialization;
}

export function getSyncCoordinator() {
  return syncCoordinator;
}

export function getRemoteClient() {
  return remoteClient;
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function wakeLoginCommandPoller({ immediate = true } = {}) {
  return loginCommandPoller.start({ immediate }).catch(() => null);
}

function createLoginCommandAlarm() {
  loginCommandPoller.ensureAlarm?.();
}

if (globalThis.chrome?.runtime?.onStartup?.addListener) {
  chrome.runtime.onStartup.addListener(() => {
    createLoginCommandAlarm();
    wakeLoginCommandPoller({ immediate: true });
  });
}

if (globalThis.chrome?.runtime?.onInstalled?.addListener) {
  chrome.runtime.onInstalled.addListener(() => {
    createLoginCommandAlarm();
    wakeLoginCommandPoller({ immediate: true });
  });
}

if (globalThis.chrome?.alarms?.onAlarm?.addListener) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== REMOTE_LOGIN_ALARM_NAME) return;
    loginCommandPoller.pollOnce().catch(() => {});
  });
}

if (globalThis.chrome?.storage?.onChanged?.addListener) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (SYNC_CONFIG_KEYS.some((key) => Object.hasOwn(changes ?? {}, key))) {
      queueSyncRebuild();
    }
    if (changes.remoteLoginEnabled?.newValue === false) {
      loginCommandPoller.stop({ clearToken: true }).catch(() => {});
    } else if (changes.remoteLoginEnabled?.newValue === true) {
      wakeLoginCommandPoller({ immediate: true });
    }
  });
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "AUTO_LOGIN") return;
  const response = handleMessage(event.data);
  if (response && event.source) {
    event.source.postMessage(response);
  }
});

async function persistLoginState(message, sendResponse) {
  try {
    const state = sanitizeLoginState(message);
    await chrome.storage.local.set(state);
    sendResponse({ ok: true });
  } catch {
    sendResponse({ ok: false, error: "STORAGE_UNAVAILABLE" });
  }
}

syncInitialization = globalThis.chrome?.storage?.local?.get
  ? initializeSyncCoordinator().catch(() => null)
  : Promise.resolve(null);

async function ensureSyncCoordinator() {
  if (syncCoordinator && remoteClient) return syncCoordinator;
  try {
    await syncInitialization;
  } catch {
    // A failed startup/rebuild is retried below using the current storage state.
  }
  if (syncCoordinator && remoteClient) return syncCoordinator;
  syncInitialization = initializeSyncCoordinator().catch(() => null);
  return syncInitialization;
}

async function handleExportUpload(message) {
  await ensureSyncCoordinator();
  if (!syncCoordinator || !remoteClient) return { ok: false, code: "NOT_CONFIGURED" };

  try {
    const bytes = bytesFromBase64(message?.base64);
    const result = await remoteClient.uploadReportExport({
      blob: new Blob([bytes], { type: message?.mime || XLSX_MIME }),
      fileName: message?.fileName,
      sha256: message?.sha256,
      clientExportId: message?.clientExportId,
    });
    return {
      ok: true,
      exportId: result?.id,
      fileName: result?.fileName,
      byteSize: result?.byteSize,
      createdAt: result?.createdAt,
    };
  } catch (error) {
    const code = typeof error?.code === "string" && error.code ? error.code : "REMOTE_ERROR";
    return { ok: false, code };
  }
}

function handleSyncRetry(sendResponse) {
  Promise.resolve(syncInitialization)
    .then((coordinator) => coordinator?.retry?.())
    .then(() => sendResponse({ type: "SYNC_RETRY_ACK", payload: { ok: Boolean(syncCoordinator) } }))
    .catch(() => sendResponse({ type: "SYNC_RETRY_ACK", payload: { ok: false } }));
  return true;
}

function handleRemoteLoginMessage(message, sendResponse) {
  if (message?.type === ENABLE_REMOTE_LOGIN) {
    loginCommandPoller.enable({ serverPassword: message.serverPassword })
      .then((response) => sendResponse(response))
      .catch(() => sendResponse({ ok: false, reason: "REMOTE_ERROR" }));
    return true;
  }
  if (message?.type === DISABLE_REMOTE_LOGIN) {
    loginCommandPoller.disable()
      .then((response) => sendResponse({ ...response, status: "stopped", enabled: false }))
      .catch(() => sendResponse({ ok: false, status: "stopped", enabled: false }));
    return true;
  }
  if (message?.type === REMOTE_LOGIN_STATUS_REQUEST) {
    loginCommandPoller.getStatus()
      .then((status) => sendResponse({ ok: true, ...status }))
      .catch(() => sendResponse({ ok: false, status: "stopped", enabled: false }));
    return true;
  }
  return false;
}

if (globalThis.chrome?.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (debuggerDriver.canHandle(message)) {
      return debuggerDriver.handleMessage(message, sender, sendResponse);
    }
    if (message?.type !== ENABLE_REMOTE_LOGIN && message?.type !== DISABLE_REMOTE_LOGIN) {
      wakeLoginCommandPoller({ immediate: true });
    }
    // AUTO_LOGIN 只在 content script 处理，service worker 不接收、不转发、不持久化。
    if (message?.type === "AUTO_LOGIN") return false;
    if (message?.type === "LOGIN_STATE") {
      persistLoginState(message, sendResponse);
      return true;
    }
    if (message?.type === SYNC_STATUS_REQUEST) {
      sendResponse({ type: "SYNC_STATUS", payload: currentSyncState() });
      return false;
    }
    if (message?.type === "SYNC_RETRY") {
      return handleSyncRetry(sendResponse);
    }
    if (message?.type === "EXPORT_UPLOAD") {
      handleExportUpload(message)
        .then((response) => sendResponse(response))
        .catch(() => sendResponse({ ok: false, code: "REMOTE_ERROR" }));
      return true;
    }
    if (handleRemoteLoginMessage(message, sendResponse)) {
      return true;
    }
    const response = handleMessage(message);
    if (response) sendResponse(response);
    return false;
  });
}
