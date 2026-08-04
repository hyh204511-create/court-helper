import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { SELECTORS } from "../extension/content/selectors.js";
import { fetchCaptchaBase64, fillLoginForm, findExactTextView } from "../extension/content/login-auto.js";

test("集中登录选择器能定位输入框、JPEG 验证码图和文本锚点", () => {
  const dom = new JSDOM(`
    <main>
      <input type="text" class="uni-input-input" aria-label="账号">
      <input type="password" class="uni-input-input" aria-label="密码">
      <input type="text" class="uni-input-input" aria-label="验证码">
      <img src="data:image/jpeg;base64,ZmFrZS1jYXB0Y2hh" alt="验证码">
      <view>密码登录</view>
      <view>登录</view>
    </main>
  `);
  const { document } = dom.window;

  const textInputs = [...document.querySelectorAll(SELECTORS.login.accountInput)];
  assert.equal(textInputs.length, 2);
  assert.equal(textInputs[0].getAttribute("aria-label"), "账号");
  assert.equal(document.querySelector(SELECTORS.login.passwordInput)?.getAttribute("aria-label"), "密码");
  assert.equal(textInputs[1].getAttribute("aria-label"), "验证码");
  assert.equal(document.querySelector(SELECTORS.login.captchaImage)?.src, "data:image/jpeg;base64,ZmFrZS1jYXB0Y2hh");

  const textAnchors = [...document.querySelectorAll(SELECTORS.login.submitButton)];
  assert.ok(textAnchors.some((el) => el.textContent.trim() === "密码登录"));
  assert.ok(textAnchors.some((el) => el.textContent.trim() === "登录"));
  dom.window.close();
});

function makeLoginDom() {
  return new JSDOM(`
    <main>
      <view id="password-tab">密码登录</view>
      <div>请使用密码登录后继续</div>
      <input type="text" class="uni-input-input" aria-label="账号">
      <input type="password" class="uni-input-input" aria-label="密码">
      <input type="text" class="uni-input-input" aria-label="验证码">
      <img src="data:image/png;base64,cG5n" alt="不是验证码">
      <img id="captcha" src="data:image/jpeg;base64,amJzZG9t" alt="验证码">
      <view id="submit-view">登录</view>
    </main>
  `);
}

test("fillLoginForm 使用原生 value setter 并为三个字段派发冒泡 input", () => {
  const dom = makeLoginDom();
  const { document, HTMLInputElement, Event } = dom.window;
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  const inputs = [...document.querySelectorAll("input")];
  const events = [];

  for (const input of inputs) {
    Object.defineProperty(input, "value", {
      configurable: true,
      get: nativeValue.get,
      set() {
        throw new Error("instance value setter must not be used");
      },
    });
    input.addEventListener("input", (event) => {
      events.push({ label: input.getAttribute("aria-label"), bubbles: event.bubbles, composed: event.composed });
    });
  }

  fillLoginForm({ account: "demo-account", password: "demo-password", captcha: "C7x2" }, document);

  assert.equal(nativeValue.get.call(inputs[0]), "demo-account");
  assert.equal(nativeValue.get.call(inputs[1]), "demo-password");
  assert.equal(nativeValue.get.call(inputs[2]), "C7x2");
  assert.deepEqual(events, [
    { label: "账号", bubbles: true, composed: true },
    { label: "密码", bubbles: true, composed: true },
    { label: "验证码", bubbles: true, composed: true },
  ]);
  assert.equal(Event, dom.window.Event);
  dom.window.close();
});

test("fetchCaptchaBase64 只返回首个 JPEG data URL 的 base64", () => {
  const dom = makeLoginDom();
  assert.equal(fetchCaptchaBase64(dom.window.document), "amJzZG9t");

  const missing = new JSDOM('<main><img src="data:image/png;base64,cG5n"></main>');
  assert.equal(fetchCaptchaBase64(missing.window.document), null);
  const empty = new JSDOM("<main><img></main>");
  assert.equal(fetchCaptchaBase64(empty.window.document), null);
  dom.window.close();
  missing.window.close();
  empty.window.close();
});

test("精确文本定位只返回登录 view，不依赖 button 标签", () => {
  const dom = makeLoginDom();
  const target = findExactTextView(dom.window.document, "登录");
  assert.equal(target?.id, "submit-view");
  assert.equal(dom.window.document.querySelector("button"), null);
  assert.equal(findExactTextView(dom.window.document, "密码登录")?.id, "password-tab");
  assert.equal(findExactTextView(dom.window.document, "登录按钮"), null);
  dom.window.close();
});
