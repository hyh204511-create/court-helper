import { handleMessage } from "./shared/message-router.js";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const response = handleMessage(event.data);
  if (response && event.source) {
    event.source.postMessage(response);
  }
});
