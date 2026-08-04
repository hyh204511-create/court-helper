// popup 登录控制器：凭据只存在于当前 popup 的闭包内存。
export const LOGIN_SERVICE_URL = "http://127.0.0.1:8765";

const UI_TEXT = {
  checking: "检查本地服务…",
  online: "服务在线",
  offline: "服务不可用，请运行 python scripts/login-helper-server.py",
  empty: "服务在线，未找到账号",
  chooseAccount: "请选择账号",
  noTab: "未找到法院标签页",
  success: "登录成功",
  serviceError: "本地服务不可用，请检查本地服务",
  formError: "登录页面未准备好，请刷新后重试",
  needsHuman: "登录失败，请人工处理",
  ocrError: "验证码识别失败，请人工处理",
  timeout: "登录超时，请人工处理",
};

const FIXED_ERRORS = new Set([
  "SERVICE_UNAVAILABLE",
  "FORM_NOT_READY",
  "OCR_FAILED",
  "LOGIN_TIMEOUT",
  "NEEDS_HUMAN",
]);

function fixedErrorText(code) {
  if (code === "SERVICE_UNAVAILABLE") return UI_TEXT.serviceError;
  if (code === "FORM_NOT_READY") return UI_TEXT.formError;
  if (code === "OCR_FAILED") return UI_TEXT.ocrError;
  if (code === "LOGIN_TIMEOUT") return UI_TEXT.timeout;
  return UI_TEXT.needsHuman;
}

function getElement(document, selector) {
  return document?.querySelector?.(selector) ?? null;
}

function setServiceStatus(element, text, kind) {
  if (!element) return;
  element.textContent = text;
  element.dataset.state = kind;
}

export function createLoginController({
  document = globalThis.document,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  chromeApi = globalThis.chrome,
  serviceUrl = LOGIN_SERVICE_URL,
} = {}) {
  const serviceStatus = getElement(document, "#login-service-status");
  const accountSelect = getElement(document, "#login-account");
  const autoLoginButton = getElement(document, "#btn-auto-login");
  const resultElement = getElement(document, "#login-result");
  const loginStatus = getElement(document, "#login-status");
  const credentials = new Map();
  let destroyed = false;
  let bound = false;
  let initPromise = null;
  let autoLoginPromise = null;

  function setResult(text, kind = "") {
    if (!resultElement) return;
    resultElement.textContent = text;
    resultElement.dataset.state = kind;
  }

  function setButtonEnabled(enabled) {
    if (autoLoginButton) autoLoginButton.disabled = !enabled || destroyed;
  }

  function renderAccounts(accounts) {
    credentials.clear();
    if (!accountSelect) return;
    accountSelect.replaceChildren();
    for (const entry of accounts) {
      credentials.set(entry.account, entry.password);
      const option = document.createElement("option");
      option.value = entry.account;
      option.textContent = entry.account;
      accountSelect.append(option);
    }
    setButtonEnabled(accounts.length > 0);
  }

  async function fetchJson(path) {
    if (typeof fetchImpl !== "function") throw new Error("SERVICE_UNAVAILABLE");
    const response = await fetchImpl(`${serviceUrl.replace(/\/+$/, "")}${path}`);
    if (!response?.ok || typeof response.json !== "function") throw new Error("SERVICE_UNAVAILABLE");
    const body = await response.json();
    if (!body?.ok) throw new Error("SERVICE_UNAVAILABLE");
    return body;
  }

  async function loadAccounts() {
    if (destroyed) return { ok: false, error: "SERVICE_UNAVAILABLE" };
    setServiceStatus(serviceStatus, UI_TEXT.checking, "checking");
    try {
      await fetchJson("/health");
    } catch {
      renderAccounts([]);
      setServiceStatus(serviceStatus, UI_TEXT.offline, "offline");
      return { ok: false, error: "SERVICE_UNAVAILABLE" };
    }

    let body;
    try {
      body = await fetchJson("/accounts");
    } catch {
      renderAccounts([]);
      setServiceStatus(serviceStatus, UI_TEXT.offline, "offline");
      return { ok: false, error: "SERVICE_UNAVAILABLE" };
    }
    const accounts = (Array.isArray(body.accounts) ? body.accounts : [])
      .filter((entry) => (
        entry && typeof entry.account === "string" && entry.account.trim() && typeof entry.password === "string"
      ))
      .map((entry) => ({ account: entry.account, password: entry.password }));
    renderAccounts(accounts);
    setServiceStatus(serviceStatus, accounts.length ? UI_TEXT.online : UI_TEXT.empty, "online");
    return { ok: true, accounts: accounts.length };
  }

  function setLoginState({ state = "unknown", maskedAccount = "" } = {}) {
    if (!loginStatus) return;
    loginStatus.classList.remove("badge-on", "badge-off");
    if (state === "logged-in") {
      loginStatus.classList.add("badge-on");
      loginStatus.textContent = maskedAccount || "已登录";
    } else if (state === "session-expired") {
      loginStatus.classList.add("badge-off");
      loginStatus.textContent = "会话已失效，请重新登录";
    } else if (state === "login") {
      loginStatus.classList.add("badge-off");
      loginStatus.textContent = "未登录";
    } else {
      loginStatus.classList.add("badge-off");
      loginStatus.textContent = "状态未知";
    }
  }

  async function sendAutoLogin() {
    if (destroyed || autoLoginPromise) return autoLoginPromise;
    const account = accountSelect?.value ?? "";
    const password = credentials.get(account);
    if (!account || typeof password !== "string") {
      setResult(UI_TEXT.chooseAccount, "error");
      return { ok: false, error: "FORM_NOT_READY" };
    }
    setButtonEnabled(false);
    autoLoginPromise = (async () => {
      try {
        const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          setResult(UI_TEXT.noTab, "error");
          return { ok: false, error: "FORM_NOT_READY" };
        }
        const response = await chromeApi.tabs.sendMessage(tab.id, {
          type: "AUTO_LOGIN",
          account,
          password,
          serviceUrl,
        });
        if (response?.ok === true) {
          setResult(UI_TEXT.success, "success");
          return { ok: true };
        }
        const code = FIXED_ERRORS.has(response?.error) ? response.error : "NEEDS_HUMAN";
        setResult(fixedErrorText(code), "error");
        return { ok: false, error: code };
      } catch {
        setResult(UI_TEXT.serviceError, "error");
        return { ok: false, error: "SERVICE_UNAVAILABLE" };
      }
    })();
    const current = autoLoginPromise;
    current.then(
      () => { if (autoLoginPromise === current) { autoLoginPromise = null; setButtonEnabled(credentials.size > 0); } },
      () => { if (autoLoginPromise === current) { autoLoginPromise = null; setButtonEnabled(credentials.size > 0); } },
    );
    return current;
  }

  function bind() {
    if (bound || !autoLoginButton) return;
    bound = true;
    autoLoginButton.addEventListener("click", sendAutoLogin);
  }

  function init() {
    if (!initPromise) {
      bind();
      initPromise = loadAccounts();
    }
    return initPromise;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    autoLoginButton?.removeEventListener("click", sendAutoLogin);
    credentials.clear();
    setButtonEnabled(false);
  }

  return {
    init,
    loadAccounts,
    sendAutoLogin,
    setLoginState,
    destroy,
  };
}
