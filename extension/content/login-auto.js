// login-auto.js — 登录表单 DOM 操作（不写 storage，不记录凭据）
import { SELECTORS } from "./selectors.js";
import { isLoginRoute } from "./login-detector.js";

const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";
const LOGIN_SUCCESS_TIMEOUT_MS = 8000;
const PASSWORD_FORM_TIMEOUT_MS = 2000;
const CAPTCHA_REFRESH_TIMEOUT_MS = 3000;
const RETRY_MIN_MS = 3000;
const RETRY_MAX_MS = 8000;
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

/**
 * 通过原生 value setter 填写账号、密码、验证码，并通知 uni-app 受控输入。
 * 支持 fillLoginForm(credentials, root) 与 fillLoginForm(root, credentials)。
 */
export function fillLoginForm(first, second) {
  const { root, credentials } = normalizeFillArgs(first, second);
  if (!isRoot(root)) throw new Error("FORM_NOT_READY");

  const textInputs = [...root.querySelectorAll(SELECTORS.login.accountInput)];
  const accountInput = textInputs[0];
  const captchaInput = textInputs[1];
  const passwordInput = root.querySelector(SELECTORS.login.passwordInput);
  if (!accountInput || !passwordInput || !captchaInput) throw new Error("FORM_NOT_READY");

  setControlledInputValue(accountInput, credentials.account);
  setControlledInputValue(passwordInput, credentials.password);
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
  return [...candidates].find(
    (element) => typeof element.click === "function" && (element.textContent ?? "").trim() === text,
  ) ?? null;
}

function readImageSource(image) {
  return image?.getAttribute?.("src") ?? image?.src ?? "";
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
  if (hasPasswordForm(root)) return true;
  const tab = findExactTextView(root, "密码登录");
  if (!tab) return false;
  try {
    tab.click();
  } catch {
    return false;
  }
  return waitUntil(() => hasPasswordForm(root), {
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
  try {
    submitButton.click();
  } catch {
    return { ok: false, error: "FORM_NOT_READY" };
  }

  const success = await waitUntil(
    () => !isLoginRoute(location?.hash ?? "") || !!readUserArea(root),
    dependencies,
  );
  return success ? { ok: true } : { ok: false, error: "LOGIN_TIMEOUT" };
}

async function refreshCaptcha(root, dependencies, timeoutMs) {
  const current = findValidCaptchaImage(root);
  if (!current) return false;
  try {
    current.image.click();
  } catch {
    return false;
  }
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
    timeoutMs: settings.loginTimeoutMs ?? settings.timeoutMs ?? LOGIN_SUCCESS_TIMEOUT_MS,
    intervalMs: settings.pollIntervalMs ?? 100,
  };

  const passwordReady = await ensurePasswordMode(
    root,
    dependencies,
    settings.passwordFormTimeoutMs ?? PASSWORD_FORM_TIMEOUT_MS,
  );
  if (!passwordReady) return { ok: false, error: "FORM_NOT_READY" };

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
