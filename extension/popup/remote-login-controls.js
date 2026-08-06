import {
  EXTENSION_PAIRING_REQUEST,
  EXTENSION_PAIRING_STATUS_REQUEST,
} from "../sw/extension-pairing.js";
import { DISABLE_REMOTE_LOGIN } from "../sw/login-command-poll.js";

export const UI_TEXT = Object.freeze({
  checking: "正在检查后台授权状态...",
  authorized: "后台授权已生效",
  awaitingApproval: "请在后台浏览器控制页输入此核对码：",
  stopped: "已停用",
  unavailable: "后台授权服务不可达，请检查服务器配置",
  requesting: "正在请求后台授权...",
  requestFailed: "授权请求失败，请检查服务器配置后重试",
});

function getElement(document, selector) {
  return document?.querySelector?.(selector) ?? null;
}

function statusText(status) {
  if (status === "authorized") return UI_TEXT.authorized;
  if (status === "unavailable" || status === "not_configured") return UI_TEXT.unavailable;
  return UI_TEXT.stopped;
}

function safeStatus(response = {}) {
  if (response?.status === "awaiting_approval") return "awaiting_approval";
  if (response?.status === "authorized") return "authorized";
  if (response?.status === "unavailable" || response?.status === "not_configured") return response.status;
  return "stopped";
}

function sendRuntimeMessage(chromeApi, message) {
  const sender = chromeApi?.runtime?.sendMessage;
  if (typeof sender !== "function") return Promise.resolve({ ok: false });
  try {
    return Promise.resolve(sender(message)).catch(() => ({ ok: false }));
  } catch {
    return Promise.resolve({ ok: false });
  }
}

export function createRemoteLoginControls({
  document = globalThis.document,
  chromeApi = globalThis.chrome,
} = {}) {
  const enableButton = getElement(document, "#btn-enable-remote-login");
  const disableButton = getElement(document, "#btn-disable-remote-login");
  const statusElement = getElement(document, "#remote-login-status");
  let destroyed = false;
  let busy = false;

  function setStatus(status, response = {}) {
    if (!statusElement) return;
    const code = typeof response?.verificationCode === "string" && /^\d{6}$/.test(response.verificationCode)
      ? response.verificationCode
      : null;
    statusElement.textContent = status === "awaiting_approval" && code
      ? `${UI_TEXT.awaitingApproval}${code}`
      : statusText(status);
    statusElement.dataset.state = status;
  }

  function setBusy(value) {
    busy = value;
    if (enableButton) enableButton.disabled = busy;
    if (disableButton) disableButton.disabled = busy;
  }

  async function refreshStatus() {
    if (destroyed) return { ok: false };
    const response = await sendRuntimeMessage(chromeApi, { type: EXTENSION_PAIRING_STATUS_REQUEST });
    setStatus(safeStatus(response), response);
    return response;
  }

  async function enable() {
    if (destroyed || busy) return { ok: false };
    setBusy(true);
    if (statusElement) {
      statusElement.textContent = UI_TEXT.requesting;
      statusElement.dataset.state = "checking";
    }
    try {
      const response = await sendRuntimeMessage(chromeApi, { type: EXTENSION_PAIRING_REQUEST });
      if (response?.ok === true) {
        setStatus(safeStatus(response), response);
      } else {
        setStatus(response?.status === "not_configured" ? "not_configured" : "unavailable", response);
        if (statusElement) statusElement.textContent = UI_TEXT.requestFailed;
      }
      return response;
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (destroyed || busy) return { ok: false };
    setBusy(true);
    try {
      const response = await sendRuntimeMessage(chromeApi, { type: DISABLE_REMOTE_LOGIN });
      setStatus("stopped");
      return response;
    } finally {
      setBusy(false);
    }
  }

  function bind() {
    enableButton?.addEventListener("click", enable);
    disableButton?.addEventListener("click", disable);
  }

  function unbind() {
    enableButton?.removeEventListener("click", enable);
    disableButton?.removeEventListener("click", disable);
  }

  async function init() {
    bind();
    if (statusElement) {
      statusElement.textContent = UI_TEXT.checking;
      statusElement.dataset.state = "checking";
    }
    return refreshStatus();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    unbind();
  }

  return { init, refreshStatus, enable, disable, destroy };
}
