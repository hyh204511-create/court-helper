export const UI_TEXT = Object.freeze({
  checking: "正在检查远程登录状态...",
  running: "轮询运行中",
  stopped: "已停用",
  expired: "token 过期，请重新启用",
  notConfigured: "未配置服务器",
  enabling: "正在启用...",
  enableFailed: "启用失败，请检查服务器配置或密码",
});

function getElement(document, selector) {
  return document?.querySelector?.(selector) ?? null;
}

function statusText(status) {
  if (status === "running") return UI_TEXT.running;
  if (status === "token-expired") return UI_TEXT.expired;
  if (status === "not-configured") return UI_TEXT.notConfigured;
  return UI_TEXT.stopped;
}

function safeStatus(response = {}) {
  if (response?.ok !== true && response?.enabled !== true) return "stopped";
  const value = typeof response?.status === "string" ? response.status : "";
  return ["running", "token-expired", "not-configured", "stopped"].includes(value) ? value : "stopped";
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
  const passwordInput = getElement(document, "#remote-login-password");
  const enableButton = getElement(document, "#btn-enable-remote-login");
  const disableButton = getElement(document, "#btn-disable-remote-login");
  const statusElement = getElement(document, "#remote-login-status");
  let destroyed = false;
  let busy = false;

  function setStatus(status) {
    if (!statusElement) return;
    statusElement.textContent = statusText(status);
    statusElement.dataset.state = status;
  }

  function setBusy(value) {
    busy = value;
    if (enableButton) enableButton.disabled = busy;
    if (disableButton) disableButton.disabled = busy;
  }

  async function refreshStatus() {
    if (destroyed) return { ok: false };
    const response = await sendRuntimeMessage(chromeApi, { type: "REMOTE_LOGIN_STATUS_REQUEST" });
    const status = safeStatus(response);
    setStatus(status);
    return response;
  }

  async function enable() {
    if (destroyed || busy) return { ok: false };
    const serverPassword = passwordInput?.value ?? "";
    setBusy(true);
    if (statusElement) {
      statusElement.textContent = UI_TEXT.enabling;
      statusElement.dataset.state = "checking";
    }
    try {
      const response = await sendRuntimeMessage(chromeApi, { type: "ENABLE_REMOTE_LOGIN", serverPassword });
      if (response?.ok === true) {
        setStatus(safeStatus(response));
        if (passwordInput) passwordInput.value = "";
      } else {
        setStatus(response?.reason === "NOT_CONFIGURED" ? "not-configured" : "stopped");
        if (statusElement) statusElement.textContent = UI_TEXT.enableFailed;
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
      const response = await sendRuntimeMessage(chromeApi, { type: "DISABLE_REMOTE_LOGIN" });
      setStatus("stopped");
      if (passwordInput) passwordInput.value = "";
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

  return {
    init,
    refreshStatus,
    enable,
    disable,
    destroy,
  };
}
