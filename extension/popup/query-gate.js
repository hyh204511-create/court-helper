// 一键抓取门禁与消息封装；批量执行仍由 content 的既有 START_BATCH 分支负责。
export const LIST_ROUTES = Object.freeze([
  "#/pagesWsla/pc/list/index",
  "#/pages/pc/case-list/index",
]);
// 兼容既有调用方；新代码应使用 LIST_ROUTES/isListRoute。
export const LIST_ROUTE = LIST_ROUTES[0];

export function isListRoute(route = "") {
  const value = typeof route === "string" ? route : "";
  return LIST_ROUTES.some((prefix) => (
    value === prefix || value.startsWith(`${prefix}/`) || value.startsWith(`${prefix}?`)
  ));
}

export function canStartBatch({ state, route, loginInProgress = false } = {}) {
  return state === "logged-in" && isListRoute(route) && !loginInProgress;
}

export function startBatchMessage(kind = "li") {
  return { type: "START_BATCH", kind: kind === "qz" ? "qz" : "li" };
}

/** 防止 popup 快速双击，但不复制/实现批量执行逻辑。 */
export function createStartBatchSender({ chromeApi = globalThis.chrome } = {}) {
  let inFlight = null;
  return function sendStartBatch(tabId, kind = "li") {
    if (inFlight) return inFlight;
    const promise = Promise.resolve().then(() => chromeApi.tabs.sendMessage(tabId, startBatchMessage(kind)));
    inFlight = promise;
    promise.then(
      () => { if (inFlight === promise) inFlight = null; },
      () => { if (inFlight === promise) inFlight = null; },
    );
    return promise;
  };
}
