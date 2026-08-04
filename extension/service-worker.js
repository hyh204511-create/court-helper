import { handleMessage, sanitizeLoginState } from "./shared/message-router.js";

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

if (globalThis.chrome?.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // AUTO_LOGIN 只在 content script 处理，service worker 不接收、不转发、不持久化。
    if (message?.type === "AUTO_LOGIN") return false;
    if (message?.type === "LOGIN_STATE") {
      persistLoginState(message, sendResponse);
      return true;
    }
    const response = handleMessage(message);
    if (response) sendResponse(response);
    return false;
  });
}
