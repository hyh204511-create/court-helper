import { handleMessage, sanitizeLoginState } from "./shared/message-router.js";
import { sanitizeSyncState } from "./shared/message-router.js";
import { createRemoteClient } from "./data/remote-client.js";
import { createSyncCoordinator } from "./data/sync-coordinator.js";
import * as syncOutbox from "./data/outbox.js";
import { createDebuggerDriver } from "./sw/debugger-driver.js";
import { createCaseSyncBridge } from "./sw/case-sync-bridge.js";
import {
  BROWSER_COMMAND_ALARM_NAME,
  createBrowserCommandPoller,
} from "./sw/browser-command-poll.js";
import { routeExtensionAction } from "./sw/action-router.js";
import {
  QUERY_API_REQUEST,
  handleMainWorldQueryRequest,
} from "./sw/main-world-query-bridge.js";
import {
  EXTENSION_PAIRING_ALARM_NAME,
  EXTENSION_PAIRING_REQUEST,
  EXTENSION_PAIRING_STATUS_REQUEST,
  createExtensionPairer,
} from "./sw/extension-pairing.js";

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
const browserCommandPoller = createBrowserCommandPoller();
const caseSyncBridge = createCaseSyncBridge({
  ensureCoordinator: ensureSyncCoordinator,
  outbox: syncOutbox,
});
const extensionPairer = createExtensionPairer({
  onAuthorized: async () => wakeBrowserCommandPoller({ immediate: true }),
});

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

function wakeBrowserCommandPoller({ immediate = true } = {}) {
  return browserCommandPoller.start({ immediate }).catch(() => null);
}

function resumeExtensionPairer() {
  return extensionPairer.resume().catch(() => null);
}

browserCommandPoller.ensureAlarm();
void wakeBrowserCommandPoller({ immediate: true });

if (globalThis.chrome?.runtime?.onStartup?.addListener) {
  chrome.runtime.onStartup.addListener(() => {
    browserCommandPoller.ensureAlarm();
    wakeBrowserCommandPoller({ immediate: true });
    resumeExtensionPairer();
  });
}

if (globalThis.chrome?.runtime?.onInstalled?.addListener) {
  chrome.runtime.onInstalled.addListener(() => {
    browserCommandPoller.ensureAlarm();
    wakeBrowserCommandPoller({ immediate: true });
    resumeExtensionPairer();
  });
}

if (globalThis.chrome?.action?.onClicked?.addListener) {
  chrome.action.onClicked.addListener(() => {
    routeExtensionAction().catch(() => chrome.runtime.openOptionsPage?.());
  });
}

if (globalThis.chrome?.alarms?.onAlarm?.addListener) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === BROWSER_COMMAND_ALARM_NAME) browserCommandPoller.pollOnce().catch(() => {});
    if (alarm?.name === EXTENSION_PAIRING_ALARM_NAME) extensionPairer.pollOnce().catch(() => {});
  });
}

if (globalThis.chrome?.storage?.onChanged?.addListener) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (SYNC_CONFIG_KEYS.some((key) => Object.hasOwn(changes ?? {}, key))) {
      queueSyncRebuild();
    }
    if (changes.remoteLoginEnabled?.newValue === false) {
      browserCommandPoller.stop();
    } else if (changes.remoteLoginEnabled?.newValue === true) {
      wakeBrowserCommandPoller({ immediate: true });
    }
    if (Object.hasOwn(changes ?? {}, "token") || Object.hasOwn(changes ?? {}, "expiresAt")) {
      resumeExtensionPairer();
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
      platformAccountId: message?.platformAccountId,
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

function handleExtensionPairingMessage(message, sendResponse) {
  if (message?.type === EXTENSION_PAIRING_STATUS_REQUEST) {
    extensionPairer.resume()
      .then((response) => sendResponse({ ok: true, ...response }))
      .catch(() => sendResponse({ ok: false, status: "unavailable", code: "PAIRING_UNAVAILABLE" }));
    return true;
  }
  if (message?.type === EXTENSION_PAIRING_REQUEST) {
    extensionPairer.requestPairing({ serverUrl: message?.serverUrl })
      .then((response) => sendResponse({ ok: true, ...response }))
      .catch(() => sendResponse({ ok: false, status: "unavailable", code: "PAIRING_UNAVAILABLE" }));
    return true;
  }
  return false;
}

const CASE_DETAIL_MESSAGE_TYPES = new Set([
  "CASE_SPACE_OPEN",
  "CASE_SPACE_ADOPTED",
  "CASE_DETAIL_PENDING_GET",
  "CASE_DETAIL_PENDING_CLEAR",
]);

function isCourtContentSender(sender) {
  try {
    const senderUrl = [sender?.tab?.url, sender?.url]
      .find((value) => typeof value === "string" && value.trim());
    return new URL(senderUrl ?? "").hostname === "zxfw.court.gov.cn";
  } catch {
    return false;
  }
}

function isCourtDetailUrl(url) {
  try {
    const parsed = new URL(url ?? "");
    return parsed.hostname === "zxfw.court.gov.cn" && /detail|layyxq/i.test(parsed.hash || parsed.pathname);
  } catch {
    return false;
  }
}

async function adoptUpdatedCaseSpaceTab(tabId, changeInfo, tab) {
  if (!isCourtDetailUrl(changeInfo?.url ?? tab?.url)) return;
  const session = chrome.storage?.session;
  if (!session?.get || !session?.set) return;
  const { pendingDetail, caseSpaceHandoff } = await session.get(["pendingDetail", "caseSpaceHandoff"]);
  if (!pendingDetail?.uid || caseSpaceHandoff?.phase === "adopted") return;
  const sourceTabId = caseSpaceHandoff?.sourceTabId;
  const beforeTabs = new Map((Array.isArray(caseSpaceHandoff?.beforeTabs) ? caseSpaceHandoff.beforeTabs : [])
    .map((value) => [value?.id, String(value?.url ?? "")]));
  const currentUrl = String(changeInfo?.url ?? tab?.url ?? "");
  if (Number.isInteger(sourceTabId) && tabId !== sourceTabId
    && beforeTabs.has(tabId) && beforeTabs.get(tabId) === currentUrl) return;
  await session.set({
    caseSpaceHandoff: {
      uid: pendingDetail.uid,
      kind: pendingDetail.kind === "qz" ? "qz" : "li",
      sourceTabId,
      detailTabId: tabId,
      phase: "adopted",
      at: Date.now(),
    },
  });
}

async function reconcileCaseSpaceTabs() {
  if (typeof chrome.tabs?.query !== "function") return;
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!Number.isInteger(tab?.id)) continue;
    const currentUrl = tab.pendingUrl || tab.url;
    await adoptUpdatedCaseSpaceTab(tab.id, { url: currentUrl }, { ...tab, url: currentUrl });
    const { caseSpaceHandoff } = await chrome.storage.session.get("caseSpaceHandoff");
    if (caseSpaceHandoff?.phase === "adopted") return;
  }
}

function handleCaseDetailMessage(message, sender, sendResponse) {
  if (!CASE_DETAIL_MESSAGE_TYPES.has(message?.type)) return false;
  if (!isCourtContentSender(sender)) {
    sendResponse({ ok: false, code: "UNTRUSTED_SENDER" });
    return true;
  }
  const session = chrome.storage?.session;
  if (!session?.get || !session?.set || !session?.remove) {
    sendResponse({ ok: false, code: "CASE_SPACE_HANDOFF_FAILED" });
    return true;
  }
  (async () => {
    if (message.type === "CASE_DETAIL_PENDING_GET") {
      await reconcileCaseSpaceTabs();
      const { pendingDetail, caseSpaceHandoff } = await session.get(["pendingDetail", "caseSpaceHandoff"]);
      const value = pendingDetail?.uid
        ? { uid: pendingDetail.uid, kind: pendingDetail.kind === "qz" ? "qz" : "li" }
        : null;
      const handoff = caseSpaceHandoff?.uid
        ? {
            uid: caseSpaceHandoff.uid,
            kind: caseSpaceHandoff.kind === "qz" ? "qz" : "li",
            phase: caseSpaceHandoff.phase === "adopted" ? "adopted" : "opening",
          }
        : null;
      sendResponse({ ok: true, pendingDetail: value, handoff });
      return;
    }
    if (message.type === "CASE_DETAIL_PENDING_CLEAR") {
      await session.remove("pendingDetail");
      sendResponse({ ok: true });
      return;
    }
    const uid = typeof message.uid === "string" && message.uid ? message.uid : null;
    if (!uid) {
      sendResponse({ ok: false, code: "CASE_SPACE_HANDOFF_FAILED" });
      return;
    }
    const kind = message.kind === "qz" ? "qz" : "li";
    const tabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : null;
    const phase = message.type === "CASE_SPACE_ADOPTED" ? "adopted" : "opening";
    let beforeTabs = [];
    if (phase === "opening" && typeof chrome.tabs?.query === "function") {
      try {
        const tabs = await chrome.tabs.query({});
        beforeTabs = Array.isArray(tabs)
          ? tabs.filter((tab) => Number.isInteger(tab?.id)).map((tab) => ({ id: tab.id, url: String(tab.url ?? "") }))
          : [];
      } catch {
        beforeTabs = [];
      }
    }
    await session.set({
      ...(phase === "opening" ? { pendingDetail: { uid, kind } } : {}),
      caseSpaceHandoff: {
        uid,
        kind,
        sourceTabId: phase === "opening" ? tabId : undefined,
        beforeTabs: phase === "opening" ? beforeTabs : undefined,
        detailTabId: phase === "adopted" ? tabId : undefined,
        phase,
        at: Date.now(),
      },
    });
    sendResponse({ ok: true, phase, tabId });
  })().catch(() => sendResponse({ ok: false, code: "CASE_SPACE_HANDOFF_FAILED" }));
  return true;
}

if (globalThis.chrome?.tabs?.onCreated?.addListener) {
  chrome.tabs.onCreated.addListener((tab) => {
    const createdUrl = tab?.pendingUrl || tab?.url;
    adoptUpdatedCaseSpaceTab(tab?.id, { url: createdUrl }, { ...tab, url: createdUrl }).catch(() => undefined);
  });
}

if (globalThis.chrome?.tabs?.onUpdated?.addListener) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    adoptUpdatedCaseSpaceTab(tabId, changeInfo, tab).catch(() => undefined);
  });
}

if (globalThis.chrome?.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (caseSyncBridge.canHandle(message)) {
      caseSyncBridge.handle(message, sender)
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({
          ok: false,
          code: typeof error?.code === "string" ? error.code : "CASE_SYNC_NOT_ACKNOWLEDGED",
        }));
      return true;
    }
    if (message?.type === QUERY_API_REQUEST) {
      handleMainWorldQueryRequest({ message, sender, chromeApi: chrome })
        .then((response) => sendResponse(response))
        .catch(() => sendResponse({ ok: false, status: "UNKNOWN", needsHuman: true, code: "BRIDGE_UNAVAILABLE" }));
      return true;
    }
    if (debuggerDriver.canHandle(message)) {
      return debuggerDriver.handleMessage(message, sender, sendResponse);
    }
    wakeBrowserCommandPoller({ immediate: true });
    if (handleCaseDetailMessage(message, sender, sendResponse)) return true;
    // AUTO_LOGIN 只在 content script 处理，service worker 不接收、不转发、不持久化。
    if (message?.type === "AUTO_LOGIN") return false;
    if (handleExtensionPairingMessage(message, sendResponse)) return true;
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
    const response = handleMessage(message);
    if (response) sendResponse(response);
    return false;
  });
}
