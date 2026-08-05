export const CLICK_REQUEST = "CLICK_REQUEST";
export const CLICK_SESSION_END = "CLICK_SESSION_END";

const DEBUGGER_PROTOCOL_VERSION = "1.3";
const COURT_PLATFORM_ORIGIN = "https://zxfw.court.gov.cn/";
const DEFAULT_AUTO_DETACH_MS = 30000;
const HUMAN_RESPONSE = Object.freeze({ ok: false, error: "NEEDS_HUMAN" });

function isCourtPlatformUrl(url) {
  return typeof url === "string" && url.startsWith(COURT_PLATFORM_ORIGIN);
}

function readLastError(chromeApi) {
  const message = chromeApi?.runtime?.lastError?.message;
  return typeof message === "string" && message ? new Error(message) : null;
}

function callDebugger(chromeApi, fn, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      const error = readLastError(chromeApi);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    try {
      const result = fn(...args, done);
      if (result && typeof result.then === "function") {
        result.then(done, reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

function isFiniteCoordinate(value) {
  return Number.isFinite(Number(value));
}

function tabTarget(tabId) {
  return { tabId };
}

export function createDebuggerDriver({
  chromeApi = globalThis.chrome,
  scheduler = globalThis,
  autoDetachMs = DEFAULT_AUTO_DETACH_MS,
} = {}) {
  const attachedTabs = new Map();
  const attachingTabs = new Map();

  const clearDetachTimer = (state) => {
    if (state?.timer) scheduler.clearTimeout?.(state.timer);
    if (state) state.timer = null;
  };

  const forgetTab = (tabId) => {
    const state = attachedTabs.get(tabId);
    clearDetachTimer(state);
    attachedTabs.delete(tabId);
    attachingTabs.delete(tabId);
  };

  const detachTab = async (tabId) => {
    if (!attachedTabs.has(tabId)) return;
    forgetTab(tabId);
    if (typeof chromeApi?.debugger?.detach !== "function") return;
    try {
      await callDebugger(chromeApi, chromeApi.debugger.detach.bind(chromeApi.debugger), [tabTarget(tabId)]);
    } catch {
      // Detach is best-effort cleanup; the next attach attempt will surface any real problem.
    }
  };

  const scheduleAutoDetach = (tabId) => {
    const state = attachedTabs.get(tabId);
    if (!state) return;
    clearDetachTimer(state);
    if (typeof scheduler.setTimeout !== "function") return;
    state.timer = scheduler.setTimeout(() => {
      detachTab(tabId);
    }, autoDetachMs);
  };

  const ensureAttached = async (tabId) => {
    if (attachedTabs.has(tabId)) {
      scheduleAutoDetach(tabId);
      return;
    }
    if (attachingTabs.has(tabId)) {
      await attachingTabs.get(tabId);
      scheduleAutoDetach(tabId);
      return;
    }
    if (typeof chromeApi?.debugger?.attach !== "function") {
      throw new Error("debugger unavailable");
    }
    const attachPromise = callDebugger(chromeApi, chromeApi.debugger.attach.bind(chromeApi.debugger), [
      tabTarget(tabId),
      DEBUGGER_PROTOCOL_VERSION,
    ]).then(() => {
      attachedTabs.set(tabId, { timer: null });
      scheduleAutoDetach(tabId);
    }).finally(() => {
      attachingTabs.delete(tabId);
    });
    attachingTabs.set(tabId, attachPromise);
    await attachPromise;
  };

  const dispatchMouseEvent = async (tabId, type, x, y) => {
    await callDebugger(chromeApi, chromeApi.debugger.sendCommand.bind(chromeApi.debugger), [
      tabTarget(tabId),
      "Input.dispatchMouseEvent",
      {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
      },
    ]);
  };

  const handleClickRequest = async (message, sender) => {
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId) || !isCourtPlatformUrl(sender?.tab?.url)) return HUMAN_RESPONSE;
    if (!isFiniteCoordinate(message?.x) || !isFiniteCoordinate(message?.y)) return HUMAN_RESPONSE;

    const x = Number(message.x);
    const y = Number(message.y);
    try {
      await ensureAttached(tabId);
      await dispatchMouseEvent(tabId, "mousePressed", x, y);
      await dispatchMouseEvent(tabId, "mouseReleased", x, y);
      scheduleAutoDetach(tabId);
      return { ok: true };
    } catch {
      await detachTab(tabId);
      return HUMAN_RESPONSE;
    }
  };

  const handleSessionEnd = async (sender) => {
    const tabId = sender?.tab?.id;
    if (Number.isInteger(tabId) && isCourtPlatformUrl(sender?.tab?.url)) await detachTab(tabId);
    return { ok: true };
  };

  if (typeof chromeApi?.debugger?.onDetach?.addListener === "function") {
    chromeApi.debugger.onDetach.addListener((source) => {
      if (Number.isInteger(source?.tabId)) forgetTab(source.tabId);
    });
  }

  return {
    canHandle(message) {
      return message?.type === CLICK_REQUEST || message?.type === CLICK_SESSION_END;
    },
    handleMessage(message, sender, sendResponse) {
      if (!this.canHandle(message)) return false;
      const work = message.type === CLICK_REQUEST
        ? handleClickRequest(message, sender)
        : handleSessionEnd(sender);
      work.then(sendResponse, () => sendResponse(HUMAN_RESPONSE));
      return true;
    },
    detachTab,
    isAttached(tabId) {
      return attachedTabs.has(tabId);
    },
  };
}
