import { handleMessage, sanitizeLoginState } from "./shared/message-router.js";
import { sanitizeSyncState } from "./shared/message-router.js";
import { createRemoteClient } from "./data/remote-client.js";
import { createSyncCoordinator } from "./data/sync-coordinator.js";

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

let syncCoordinator = null;

function stringValue(...values) {
  return values.find((value) => typeof value === "string" && value.trim() !== "")?.trim() ?? "";
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
  if (syncCoordinator) return syncCoordinator;
  const config = await readSyncConfig(chromeApi);
  if (!config) return null;
  const client = createRemoteClient({
    baseUrl: config.baseUrl,
    token: config.token,
    fetchImpl,
  });
  if (!client) return null;

  const coordinator = createSyncCoordinator({
    client,
    document,
    scheduler,
    onState: (state) => publishSyncStatus(chromeApi, state),
  });
  syncCoordinator = coordinator;
  try {
    await coordinator.start({ immediate });
  } catch {
    // A storage/open failure must not prevent the service worker message router from loading.
  }
  return coordinator;
}

export function getSyncCoordinator() {
  return syncCoordinator;
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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

export const syncInitialization = globalThis.chrome?.storage?.local?.get
  ? initializeSyncCoordinator().catch(() => null)
  : Promise.resolve(null);

function handleSyncRetry(sendResponse) {
  Promise.resolve(syncInitialization)
    .then((coordinator) => coordinator?.retry?.())
    .then(() => sendResponse({ type: "SYNC_RETRY_ACK", payload: { ok: Boolean(syncCoordinator) } }))
    .catch(() => sendResponse({ type: "SYNC_RETRY_ACK", payload: { ok: false } }));
  return true;
}

if (globalThis.chrome?.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
    const response = handleMessage(message);
    if (response) sendResponse(response);
    return false;
  });
}
