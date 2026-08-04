// 一键抓取门禁与消息封装；批量执行仍由 content 的既有 START_BATCH 分支负责。
export const LIST_ROUTE = "#/pagesWsla/pc/list/index";

export function isListRoute(route = "") {
  const value = typeof route === "string" ? route : "";
  return value === LIST_ROUTE || value.startsWith(`${LIST_ROUTE}/`) || value.startsWith(`${LIST_ROUTE}?`);
}

export function canStartBatch({ state, route, loginInProgress = false } = {}) {
  return state === "logged-in" && isListRoute(route) && !loginInProgress;
}

export function startBatchMessage() {
  return { type: "START_BATCH", kind: "li" };
}

/** 防止 popup 快速双击，但不复制/实现批量执行逻辑。 */
export function createStartBatchSender({ chromeApi = globalThis.chrome } = {}) {
  let inFlight = null;
  return function sendStartBatch(tabId) {
    if (inFlight) return inFlight;
    const promise = Promise.resolve().then(() => chromeApi.tabs.sendMessage(tabId, startBatchMessage()));
    inFlight = promise;
    promise.then(
      () => { if (inFlight === promise) inFlight = null; },
      () => { if (inFlight === promise) inFlight = null; },
    );
    return promise;
  };
}
