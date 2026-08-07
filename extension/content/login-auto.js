// login-auto.js — 登录表单 DOM 操作（不写 storage，不记录凭据）
import { SELECTORS } from "./selectors.js";
import { isLoginRoute } from "./login-detector.js";

const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";
const LOGIN_SUCCESS_TIMEOUT_MS = 8000;
const RUNTIME_MESSAGE_TIMEOUT_MS = LOGIN_SUCCESS_TIMEOUT_MS;
const PASSWORD_FORM_TIMEOUT_MS = 2000;
const CAPTCHA_REFRESH_TIMEOUT_MS = 3000;
const RETRY_MIN_MS = 3000;
const RETRY_MAX_MS = 8000;
export const CLICK_REQUEST = "CLICK_REQUEST";
export const CLICK_SESSION_END = "CLICK_SESSION_END";
const SAFE_ERROR_CODES = new Set([
  "SERVICE_UNAVAILABLE",
  "FORM_NOT_READY",
  "OCR_FAILED",
  "LOGIN_TIMEOUT",
  "NEEDS_HUMAN",
]);

let activeLogin = null;

function isRoot(value) {
  return !!value && typeof value.querySelectorAll === "function";
}

function normalizeFillArgs(first, second) {
  if (isRoot(first)) {
    return { root: first, credentials: second ?? {} };
  }
  return { root: isRoot(second) ? second : globalThis.document, credentials: first ?? {} };
}

function setControlledInputValue(input, value) {
  const view = input.ownerDocument?.defaultView ?? globalThis;
  const inputPrototype = view.HTMLInputElement?.prototype;
  const descriptor = inputPrototype && Object.getOwnPropertyDescriptor(inputPrototype, "value");
  if (typeof descriptor?.set !== "function") throw new Error("FORM_NOT_READY");

  descriptor.set.call(input, String(value ?? ""));
  const EventCtor = view.Event ?? globalThis.Event;
  if (typeof EventCtor !== "function") throw new Error("FORM_NOT_READY");
  input.dispatchEvent(new EventCtor("input", { bubbles: true, composed: true }));
}

function loginInputs(root) {
  const textInputs = [...root.querySelectorAll(SELECTORS.login.accountInput)];
  return {
    accountInput: textInputs[0],
    captchaInput: textInputs[1],
    passwordInput: root.querySelector(SELECTORS.login.passwordInput),
  };
}

function fillAccountAndPassword(root, credentials) {
  const { accountInput, passwordInput } = loginInputs(root);
  if (!accountInput || !passwordInput) throw new Error("FORM_NOT_READY");
  setControlledInputValue(accountInput, credentials.account);
  setControlledInputValue(passwordInput, credentials.password);
}

/**
 * 通过原生 value setter 填写账号、密码、验证码，并通知 uni-app 受控输入。
 * 支持 fillLoginForm(credentials, root) 与 fillLoginForm(root, credentials)。
 */
export function fillLoginForm(first, second) {
  const { root, credentials } = normalizeFillArgs(first, second);
  if (!isRoot(root)) throw new Error("FORM_NOT_READY");

  const { captchaInput } = loginInputs(root);
  if (!captchaInput) throw new Error("FORM_NOT_READY");

  fillAccountAndPassword(root, credentials);
  setControlledInputValue(captchaInput, credentials.captcha);
  return true;
}

/** 从首个 JPEG data URL 图片提取逗号后的纯 base64；找不到时返回 null。 */
export function fetchCaptchaBase64(root = globalThis.document) {
  if (!isRoot(root)) return null;
  const images = root.querySelectorAll(SELECTORS.login.captchaImage);
  for (const image of images) {
    const source = image.getAttribute?.("src") ?? image.src ?? "";
    if (!source.startsWith(JPEG_DATA_URL_PREFIX)) continue;
    const base64 = source.slice(JPEG_DATA_URL_PREFIX.length);
    if (base64) return base64;
  }
  return null;
}

/** 按精确文本查找可调用 click 的 view 候选，不依赖 button 标签。 */
export function findExactTextView(root, text) {
  if (!isRoot(root) || typeof text !== "string") return null;
  const candidates = root.querySelectorAll(SELECTORS.login.submitButton);
  const exact = [...candidates].filter(
    (element) => typeof element.click === "function" && (element.textContent ?? "").trim() === text,
  );
  const score = (element) => {
    const tag = element.tagName?.toLowerCase();
    if (!tag) return 0;
    if (["title", "head", "script", "style", "meta", "link"].includes(tag)) return 0;
    if (tag === "view" || tag === "uni-view" || tag.endsWith("view")) return 100;
    if (tag === "button" || tag === "a" || element.getAttribute?.("role") === "button") return 80;
    if (element.hasAttribute?.("onclick") || element.hasAttribute?.("data-clickable")) return 70;
    if (element.children?.length === 0) return 50;
    return 0;
  };
  return exact.sort((left, right) => score(right) - score(left))[0] ?? null;
}

function readImageSource(image) {
  return image?.getAttribute?.("src") ?? image?.src ?? "";
}

export function getElementCenterPoint(element) {
  if (!element || typeof element.getBoundingClientRect !== "function") {
    return { ok: false, error: "FORM_NOT_READY" };
  }
  const view = element.ownerDocument?.defaultView ?? globalThis;
  try {
    const style = view.getComputedStyle?.(element);
    if (style) {
      const visibility = (style.visibility ?? "").toString();
      const display = (style.display ?? "").toString();
      const opacityText = (style.opacity ?? "").toString().trim();
      if (visibility === "hidden" || visibility === "collapse" || display === "none") {
        return { ok: false, error: "FORM_NOT_READY" };
      }
      if (opacityText && Number(opacityText) <= 0) {
        return { ok: false, error: "FORM_NOT_READY" };
      }
    }
  } catch {
    return { ok: false, error: "FORM_NOT_READY" };
  }
  let rect;
  try {
    rect = element.getBoundingClientRect();
  } catch {
    return { ok: false, error: "FORM_NOT_READY" };
  }
  const left = Number(rect?.left);
  const top = Number(rect?.top);
  const width = Number(rect?.width ?? Number(rect?.right) - left);
  const height = Number(rect?.height ?? Number(rect?.bottom) - top);
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return { ok: false, error: "FORM_NOT_READY" };
  }
  if (width <= 0 || height <= 0) return { ok: false, error: "FORM_NOT_READY" };
  return {
    ok: true,
    x: Math.round(left + width / 2),
    y: Math.round(top + height / 2),
  };
}

function sendRuntimeMessage(sendMessage, message, timeoutMs = RUNTIME_MESSAGE_TIMEOUT_MS) {
  if (typeof sendMessage !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) globalThis.clearTimeout?.(timer);
      resolve(value);
    };
    const timeout = Math.max(1, Number(timeoutMs) || RUNTIME_MESSAGE_TIMEOUT_MS);
    if (typeof globalThis.setTimeout === "function") {
      timer = globalThis.setTimeout(() => finish({ ok: false, error: "NEEDS_HUMAN" }), timeout);
    }
    try {
      const result = sendMessage(message, finish);
      if (result && typeof result.then === "function") {
        result.then(finish, () => finish(null));
      } else if (sendMessage.length < 2 && result !== undefined) {
        finish(result);
      }
    } catch {
      finish(null);
    }
  });
}

export async function requestTrustedClick(element, dependencies = {}) {
  const point = getElementCenterPoint(element);
  if (!point.ok) return point;
  const response = await sendRuntimeMessage(
    dependencies.sendMessage,
    { type: CLICK_REQUEST, x: point.x, y: point.y },
    dependencies.runtimeMessageTimeoutMs,
  );
  if (response?.ok === true) {
    dependencies.clickSessionStarted = true;
    return { ok: true };
  }
  return { ok: false, error: "NEEDS_HUMAN" };
}

async function releaseTrustedClickSession(dependencies) {
  if (!dependencies?.clickSessionStarted) return;
  await sendRuntimeMessage(
    dependencies.sendMessage,
    { type: CLICK_SESSION_END },
    dependencies.runtimeMessageTimeoutMs,
  );
  dependencies.clickSessionStarted = false;
}

function findValidCaptchaImage(root) {
  if (!isRoot(root)) return null;
  const images = root.querySelectorAll(SELECTORS.login.captchaImage);
  for (const image of images) {
    const source = readImageSource(image);
    if (source.startsWith(JPEG_DATA_URL_PREFIX) && source.slice(JPEG_DATA_URL_PREFIX.length)) {
      return { image, source };
    }
  }
  return null;
}

function hasPasswordForm(root) {
  if (!isRoot(root)) return false;
  return !!root.querySelector(SELECTORS.login.passwordInput);
}

function hasCredentialForm(root) {
  if (!hasPasswordForm(root)) return false;
  return !!loginInputs(root).accountInput;
}

function hasCaptchaForm(root) {
  if (!isRoot(root)) return false;
  return !!loginInputs(root).captchaInput && !!fetchCaptchaBase64(root);
}

function readUserArea(root) {
  const element = root?.querySelector?.(SELECTORS.header.userName);
  return (element?.textContent ?? element?.innerText ?? "").toString().trim();
}

function safeError(error) {
  const code = typeof error?.message === "string" ? error.message : "";
  return SAFE_ERROR_CODES.has(code) ? code : "FORM_NOT_READY";
}

async function waitUntil(predicate, { now, sleep, timeoutMs, intervalMs }) {
  const timeout = Math.max(0, Number(timeoutMs) || 0);
  const interval = Math.max(1, Number(intervalMs) || 1);
  const deadline = now() + timeout;
  const maxPolls = Math.max(1, Math.ceil(timeout / interval) + 1);
  for (let poll = 0; poll < maxPolls; poll += 1) {
    try {
      if (predicate()) return true;
    } catch {
      // DOM may be between SPA render phases; keep the bounded wait going.
    }
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    await sleep(Math.min(interval, remaining));
  }
  return false;
}

async function ensurePasswordMode(root, dependencies, timeoutMs) {
  if (hasCredentialForm(root)) return true;
  const ready = await waitUntil(
    () => hasCredentialForm(root) || !!findExactTextView(root, "密码登录"),
    { ...dependencies, timeoutMs },
  );
  if (!ready) return false;
  if (hasCredentialForm(root)) return true;
  const tab = findExactTextView(root, "密码登录");
  if (!tab) return false;
  const click = await requestTrustedClick(tab, dependencies);
  if (!click.ok) return false;
  return waitUntil(() => hasCredentialForm(root), {
    ...dependencies,
    timeoutMs,
  });
}

async function requestOcr({ fetchImpl, serviceUrl, image }) {
  if (typeof fetchImpl !== "function") return { ok: false, error: "SERVICE_UNAVAILABLE" };
  const baseUrl = serviceUrl.replace(/\/+$/, "");
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
    });
  } catch {
    return { ok: false, error: "SERVICE_UNAVAILABLE" };
  }
  if (!response?.ok || typeof response.json !== "function") {
    return { ok: false, error: "SERVICE_UNAVAILABLE" };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: "OCR_FAILED" };
  }
  if (!payload?.ok || typeof payload.text !== "string" || !payload.text.trim()) {
    return { ok: false, error: "OCR_FAILED" };
  }
  return { ok: true, text: payload.text.trim() };
}

async function submitAttempt({ root, location, account, password, serviceUrl, dependencies }) {
  const captcha = fetchCaptchaBase64(root);
  if (!captcha) return { ok: false, error: "FORM_NOT_READY" };
  const ocr = await requestOcr({
    fetchImpl: dependencies.fetchImpl,
    serviceUrl,
    image: captcha,
  });
  if (!ocr.ok) return ocr;

  try {
    fillLoginForm({ account, password, captcha: ocr.text }, root);
  } catch {
    return { ok: false, error: "FORM_NOT_READY" };
  }
  const submitButton = findExactTextView(root, "登录");
  if (!submitButton) return { ok: false, error: "FORM_NOT_READY" };
  const click = await requestTrustedClick(submitButton, dependencies);
  if (!click.ok) return click;

  const success = await waitUntil(
    () => !isLoginRoute(location?.hash ?? "") || !!readUserArea(root),
    dependencies,
  );
  return success ? { ok: true } : { ok: false, error: "LOGIN_TIMEOUT" };
}

async function refreshCaptcha(root, dependencies, timeoutMs) {
  const current = findValidCaptchaImage(root);
  if (!current) return false;
  const click = await requestTrustedClick(current.image, dependencies);
  if (!click.ok) return false;
  return waitUntil(
    () => {
      const source = readImageSource(current.image);
      return source.startsWith(JPEG_DATA_URL_PREFIX) &&
        source.slice(JPEG_DATA_URL_PREFIX.length) &&
        source !== current.source;
    },
    { ...dependencies, timeoutMs },
  );
}

async function runAutoLogin(options) {
  const settings = options && typeof options === "object" ? options : {};
  const root = settings.root ?? globalThis.document;
  const location = settings.location ?? globalThis.location;
  const account = settings.account;
  const password = settings.password;
  const serviceUrl = settings.serviceUrl;
  if (!isLoginRoute(location?.hash ?? "")) return { ok: false, error: "FORM_NOT_READY" };
  if (typeof account !== "string" || !account || typeof password !== "string" || !password) {
    return { ok: false, error: "FORM_NOT_READY" };
  }
  if (typeof serviceUrl !== "string" || !serviceUrl) {
    return { ok: false, error: "SERVICE_UNAVAILABLE" };
  }
  if (!isRoot(root)) return { ok: false, error: "FORM_NOT_READY" };

  const now = typeof settings.now === "function" ? settings.now : Date.now;
  const sleep = typeof settings.sleep === "function"
    ? settings.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const random = typeof settings.random === "function" ? settings.random : Math.random;
  const dependencies = {
    now,
    sleep,
    fetchImpl: settings.fetchImpl ?? settings.fetch ?? globalThis.fetch?.bind(globalThis),
    sendMessage: settings.sendMessage ?? globalThis.chrome?.runtime?.sendMessage?.bind(globalThis.chrome.runtime),
    clickSessionStarted: false,
    runtimeMessageTimeoutMs: settings.runtimeMessageTimeoutMs ?? LOGIN_SUCCESS_TIMEOUT_MS,
    timeoutMs: settings.loginTimeoutMs ?? settings.timeoutMs ?? LOGIN_SUCCESS_TIMEOUT_MS,
    intervalMs: settings.pollIntervalMs ?? 100,
  };

  try {
    const passwordReady = await ensurePasswordMode(
      root,
      dependencies,
      settings.passwordFormTimeoutMs ?? PASSWORD_FORM_TIMEOUT_MS,
    );
    if (!passwordReady) return { ok: false, error: "FORM_NOT_READY" };

    try {
      fillAccountAndPassword(root, { account, password });
    } catch {
      return { ok: false, error: "FORM_NOT_READY" };
    }

    const captchaReady = await waitUntil(() => hasCaptchaForm(root), {
      ...dependencies,
      timeoutMs: settings.captchaFormTimeoutMs ?? PASSWORD_FORM_TIMEOUT_MS,
    });
    if (!captchaReady) return { ok: false, error: "FORM_NOT_READY" };

    const first = await submitAttempt({ root, location, account, password, serviceUrl, dependencies });
    if (first.ok) return first;
    if (first.error !== "LOGIN_TIMEOUT") return first;

    const refreshed = await refreshCaptcha(
      root,
      dependencies,
      settings.captchaRefreshTimeoutMs ?? CAPTCHA_REFRESH_TIMEOUT_MS,
    );
    if (!refreshed) return { ok: false, error: "NEEDS_HUMAN" };

    const randomValue = Math.min(1, Math.max(0, Number(random()) || 0));
    await sleep(RETRY_MIN_MS + Math.round((RETRY_MAX_MS - RETRY_MIN_MS) * randomValue));
    const second = await submitAttempt({ root, location, account, password, serviceUrl, dependencies });
    return second.ok ? second : { ok: false, error: "NEEDS_HUMAN" };
  } finally {
    await releaseTrustedClickSession(dependencies);
  }
}

/** 执行一次有界自动登录；并发调用共享同一个进行中的 Promise。 */
export function doAutoLogin(options = {}) {
  if (activeLogin) return activeLogin;
  const promise = runAutoLogin(options).catch((error) => ({ ok: false, error: safeError(error) }));
  activeLogin = promise;
  promise.then(
    () => { if (activeLogin === promise) activeLogin = null; },
    () => { if (activeLogin === promise) activeLogin = null; },
  );
  return promise;
}
