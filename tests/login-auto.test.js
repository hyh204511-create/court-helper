import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { SELECTORS } from "../extension/content/selectors.js";

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
