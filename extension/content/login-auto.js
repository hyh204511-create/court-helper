// login-auto.js — 登录表单 DOM 操作（不写 storage，不记录凭据）
import { SELECTORS } from "./selectors.js";

const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";

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
