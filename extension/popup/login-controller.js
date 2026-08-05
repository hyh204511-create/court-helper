// popup 登录控制器：平台凭据可来自服务器；OCR 仍由本地 helper 提供。
import { createRemoteClient } from "../data/remote-client.js";

export const LOGIN_SERVICE_URL = "http://127.0.0.1:8765";

const SERVER_CONFIG_KEYS = Object.freeze(["serverUrl", "serverUsername"]);

const UI_TEXT = {
  checking: "正在检查登录服务...",
  online: "服务可用",
  offline: "本地服务不可用，请运行 python scripts/login-helper-server.py",
  empty: "服务可用，未配置账号",
  serverFallback: "未配置服务器，使用本地登录服务",
  serverOnline: "服务器账号可用",
  serverUnreachable: "服务器不可达，请检查配置或网络",
  serverAuthFailed: "服务器登录失败，请检查账号或密码",
  credentialError: "凭据获取失败，请人工处理",
  chooseAccount: "请选择账号",
  noTab: "未找到当前法院标签页",
  success: "登录成功",
  serviceError: "本地登录服务不可用，请检查后重试",
  formError: "登录表单未就绪，请人工检查",
  needsHuman: "登录异常，请人工处理",
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

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function readServerConfig(chromeApi) {
  const storage = chromeApi?.storage?.local;
  if (typeof storage?.get !== "function") return { configured: false };
  try {
    const stored = await storage.get(SERVER_CONFIG_KEYS);
    const serverUrl = trimString(stored?.serverUrl);
    const serverUsername = trimString(stored?.serverUsername);
    return {
      configured: Boolean(serverUrl && serverUsername),
      serverUrl,
      serverUsername,
    };
  } catch {
    return { configured: false };
  }
}

function classifyRemoteError(error) {
  if (error?.status === 400 || error?.status === 401 || error?.status === 403) {
    return "SERVER_AUTH_FAILED";
  }
  return "SERVER_UNREACHABLE";
}

function hasUsableCredential(body) {
  return typeof body?.account === "string"
    && body.account.trim() !== ""
    && typeof body?.password === "string"
    && body.password !== "";
}

export function createLoginController({
  document = globalThis.document,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  chromeApi = globalThis.chrome,
  serviceUrl = LOGIN_SERVICE_URL,
  onLoginResult = null,
} = {}) {
  const serviceStatus = getElement(document, "#login-service-status");
  const accountSelect = getElement(document, "#login-account");
  const autoLoginButton = getElement(document, "#btn-auto-login");
  const resultElement = getElement(document, "#login-result");
  const loginStatus = getElement(document, "#login-status");
  const serverPasswordInput = getElement(document, "#login-server-password");
  const localCredentials = new Map();
  const serverAccounts = new Map();
  let credentialSource = "local";
  let serverClient = null;
  let destroyed = false;
  let bound = false;
  let initPromise = null;
  let autoLoginPromise = null;

  function setResult(text, kind = "") {
    if (!resultElement) return;
    resultElement.textContent = text;
    resultElement.dataset.state = kind;
  }

  function hasAccounts() {
    return credentialSource === "server" ? serverAccounts.size > 0 : localCredentials.size > 0;
  }

  function setButtonEnabled(enabled) {
    if (autoLoginButton) autoLoginButton.disabled = !enabled || destroyed;
  }

  function resetAccountOptions(source) {
    credentialSource = source;
    localCredentials.clear();
    serverAccounts.clear();
    accountSelect?.replaceChildren();
  }

  function renderLocalAccounts(accounts) {
    resetAccountOptions("local");
    if (!accountSelect) return;
    for (const entry of accounts) {
      localCredentials.set(entry.account, entry.password);
      const option = document.createElement("option");
      option.value = entry.account;
      option.textContent = entry.account;
      accountSelect.append(option);
    }
    setButtonEnabled(accounts.length > 0);
  }

  function renderServerAccounts(accounts) {
    resetAccountOptions("server");
    if (!accountSelect) return;
    for (const entry of accounts) {
      serverAccounts.set(entry.id, entry);
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.label;
      accountSelect.append(option);
    }
    setButtonEnabled(accounts.length > 0);
  }

  async function fetchLocalJson(path) {
    if (typeof fetchImpl !== "function") throw new Error("SERVICE_UNAVAILABLE");
    const response = await fetchImpl(`${serviceUrl.replace(/\/+$/, "")}${path}`);
    if (!response?.ok || typeof response.json !== "function") throw new Error("SERVICE_UNAVAILABLE");
    const body = await response.json();
    if (!body?.ok) throw new Error("SERVICE_UNAVAILABLE");
    return body;
  }

  async function loadLocalAccounts({ fallback = false } = {}) {
    if (destroyed) return { ok: false, error: "SERVICE_UNAVAILABLE" };
    setServiceStatus(serviceStatus, fallback ? UI_TEXT.serverFallback : UI_TEXT.checking, fallback ? "fallback" : "checking");
    try {
      await fetchLocalJson("/health");
    } catch {
      renderLocalAccounts([]);
      setServiceStatus(serviceStatus, UI_TEXT.offline, "offline");
      return { ok: false, error: "SERVICE_UNAVAILABLE" };
    }

    let body;
    try {
      body = await fetchLocalJson("/accounts");
    } catch {
      renderLocalAccounts([]);
      setServiceStatus(serviceStatus, UI_TEXT.offline, "offline");
      return { ok: false, error: "SERVICE_UNAVAILABLE" };
    }
    const accounts = (Array.isArray(body.accounts) ? body.accounts : [])
      .filter((entry) => (
        entry && typeof entry.account === "string" && entry.account.trim() && typeof entry.password === "string"
      ))
      .map((entry) => ({ account: entry.account, password: entry.password }));
    renderLocalAccounts(accounts);
    setServiceStatus(serviceStatus, accounts.length ? (fallback ? UI_TEXT.serverFallback : UI_TEXT.online) : UI_TEXT.empty, "online");
    return { ok: true, accounts: accounts.length, source: "local" };
  }

  async function loginServer({ serverUrl, serverUsername }) {
    const password = serverPasswordInput?.value ?? "";
    if (!password) {
      const error = new Error("SERVER_AUTH_FAILED");
      error.code = "SERVER_AUTH_FAILED";
      throw error;
    }
    const authClient = createRemoteClient({ baseUrl: serverUrl, fetchImpl });
    if (!authClient) {
      const error = new Error("SERVER_UNREACHABLE");
      error.code = "SERVER_UNREACHABLE";
      throw error;
    }
    const response = await authClient.request("/auth/login", {
      method: "POST",
      body: {
        username: serverUsername,
        password,
        clientType: "extension",
      },
    });
    const token = trimString(response?.token);
    if (!token) {
      const error = new Error("SERVER_AUTH_FAILED");
      error.code = "SERVER_AUTH_FAILED";
      throw error;
    }
    return createRemoteClient({ baseUrl: serverUrl, token, fetchImpl });
  }

  async function loadServerAccounts(config) {
    if (destroyed) return { ok: false, error: "SERVER_UNREACHABLE" };
    setServiceStatus(serviceStatus, UI_TEXT.checking, "checking");
    setResult("", "");
    try {
      serverClient = await loginServer(config);
    } catch (error) {
      renderServerAccounts([]);
      const code = error?.code === "SERVER_AUTH_FAILED" ? "SERVER_AUTH_FAILED" : classifyRemoteError(error);
      setServiceStatus(
        serviceStatus,
        code === "SERVER_AUTH_FAILED" ? UI_TEXT.serverAuthFailed : UI_TEXT.serverUnreachable,
        code === "SERVER_AUTH_FAILED" ? "auth-failed" : "offline",
      );
      return { ok: false, error: code };
    }

    try {
      const body = await serverClient.listPlatformAccounts();
      const accounts = (Array.isArray(body?.platformAccounts) ? body.platformAccounts : [])
        .filter((entry) => (
          entry
          && typeof entry.id === "string"
          && entry.id.trim()
          && typeof entry.label === "string"
          && entry.label.trim()
          && entry.enabled !== false
        ))
        .map((entry) => ({
          id: entry.id,
          label: entry.label,
          enabled: entry.enabled,
          updatedAt: entry.updatedAt,
        }));
      renderServerAccounts(accounts);
      setServiceStatus(serviceStatus, accounts.length ? UI_TEXT.serverOnline : UI_TEXT.empty, "online");
      return { ok: true, accounts: accounts.length, source: "server" };
    } catch {
      renderServerAccounts([]);
      setServiceStatus(serviceStatus, UI_TEXT.serverUnreachable, "offline");
      return { ok: false, error: "SERVER_UNREACHABLE" };
    }
  }

  async function loadAccounts() {
    const config = await readServerConfig(chromeApi);
    if (!config.configured) {
      serverClient = null;
      return loadLocalAccounts({ fallback: true });
    }
    return loadServerAccounts(config);
  }

  function setLoginState({ state = "unknown", maskedAccount = "" } = {}) {
    if (!loginStatus) return;
    loginStatus.classList.remove("badge-on", "badge-off");
    if (state === "logged-in") {
      loginStatus.classList.add("badge-on");
      loginStatus.textContent = maskedAccount || "已登录";
    } else if (state === "session-expired") {
      loginStatus.classList.add("badge-off");
      loginStatus.textContent = "会话过期，请重新登录";
    } else if (state === "login") {
      loginStatus.classList.add("badge-off");
      loginStatus.textContent = "未登录";
    } else {
      loginStatus.classList.add("badge-off");
      loginStatus.textContent = "状态未知";
    }
  }

  async function resolveSelectedCredential() {
    if (credentialSource === "local") {
      const account = accountSelect?.value ?? "";
      const password = localCredentials.get(account);
      if (!account || typeof password !== "string") return null;
      return { ok: true, account, password };
    }

    const id = accountSelect?.value ?? "";
    if (!id || !serverAccounts.has(id) || !serverClient) return null;
    try {
      const credential = await serverClient.getCredential(id);
      if (!hasUsableCredential(credential)) throw new Error("CREDENTIAL_FETCH_FAILED");
      return {
        ok: true,
        account: credential.account,
        password: credential.password,
      };
    } catch {
      return { ok: false, error: "CREDENTIAL_FETCH_FAILED" };
    }
  }

  async function sendAutoLogin() {
    if (destroyed || autoLoginPromise) return autoLoginPromise;
    const selected = accountSelect?.value ?? "";
    if (!selected) {
      setResult(UI_TEXT.chooseAccount, "error");
      return { ok: false, error: "FORM_NOT_READY" };
    }
    setButtonEnabled(false);
    autoLoginPromise = (async () => {
      const credential = await resolveSelectedCredential();
      if (!credential) {
        setResult(UI_TEXT.chooseAccount, "error");
        return { ok: false, error: "FORM_NOT_READY" };
      }
      if (credential.ok === false) {
        setResult(UI_TEXT.credentialError, "error");
        return { ok: false, error: "CREDENTIAL_FETCH_FAILED" };
      }
      try {
        const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          setResult(UI_TEXT.noTab, "error");
          return { ok: false, error: "FORM_NOT_READY" };
        }
        const response = await chromeApi.tabs.sendMessage(tab.id, {
          type: "AUTO_LOGIN",
          account: credential.account,
          password: credential.password,
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
    })().then((response) => {
      try {
        onLoginResult?.(response);
      } catch {
        // UI 状态回调失败不能影响登录结果。
      }
      return response;
    });
    const current = autoLoginPromise;
    current.then(
      () => { if (autoLoginPromise === current) { autoLoginPromise = null; setButtonEnabled(hasAccounts()); } },
      () => { if (autoLoginPromise === current) { autoLoginPromise = null; setButtonEnabled(hasAccounts()); } },
    );
    return current;
  }

  function bind() {
    if (bound || !autoLoginButton) return;
    bound = true;
    autoLoginButton.addEventListener("click", sendAutoLogin);
    serverPasswordInput?.addEventListener?.("change", loadAccounts);
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
    serverPasswordInput?.removeEventListener?.("change", loadAccounts);
    localCredentials.clear();
    serverAccounts.clear();
    serverClient = null;
    setButtonEnabled(false);
  }

  return {
    init,
    loadAccounts,
    sendAutoLogin,
    setLoginState,
    isAutoLoginInProgress: () => !!autoLoginPromise,
    destroy,
  };
}
