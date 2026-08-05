import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { SELECTORS } from "../extension/content/selectors.js";
import {
  CLICK_REQUEST,
  doAutoLogin,
  fetchCaptchaBase64,
  fillLoginForm,
  findExactTextView,
  getElementCenterPoint,
  requestTrustedClick,
} from "../extension/content/login-auto.js";

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

test("fetchCaptchaBase64：多图跳过空 src 和 PNG，取首个 JPEG", () => {
  const dom = new JSDOM(`
    <main>
      <img src="">
      <img src="data:image/png;base64,cG5n">
      <img src="data:image/jpeg;base64,first-jpeg">
      <img src="data:image/jpeg;base64,second-jpeg">
    </main>
  `);

  assert.equal(fetchCaptchaBase64(dom.window.document), "first-jpeg");
  dom.window.close();
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

test("findExactTextView prefers uni-view login button over matching document title", () => {
  const dom = new JSDOM(`
    <!doctype html>
    <html>
      <head><title>登录</title></head>
      <body>
        <main>
          <uni-view class="fd-login-btn" id="submit-view">登录</uni-view>
        </main>
      </body>
    </html>
  `);

  const target = findExactTextView(dom.window.document, "登录");
  assert.equal(target?.id, "submit-view");
  assert.equal(target?.tagName.toLowerCase(), "uni-view");
  assert.notEqual(target?.tagName.toLowerCase(), "title");
  dom.window.close();
});

test("findExactTextView prefers uni-view password tab over matching document title", () => {
  const dom = new JSDOM(`
    <!doctype html>
    <html>
      <head><title>密码登录</title></head>
      <body>
        <main>
          <uni-view class="fd-login-tab" id="password-tab">密码登录</uni-view>
        </main>
      </body>
    </html>
  `);

  const target = findExactTextView(dom.window.document, "密码登录");
  assert.equal(target?.id, "password-tab");
  assert.equal(target?.tagName.toLowerCase(), "uni-view");
  assert.notEqual(target?.tagName.toLowerCase(), "title");
  dom.window.close();
});

function makeClock() {
  const clock = {
    current: 0,
    sleeps: [],
    onSleep: null,
    now() {
      return clock.current;
    },
    async sleep(ms) {
      clock.sleeps.push(ms);
      clock.current += ms;
      await clock.onSleep?.(ms);
    },
  };
  return clock;
}

function setRect(element, rect) {
  element.getBoundingClientRect = () => ({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
  });
}

function prepareClickTargets(document) {
  setRect(findExactTextView(document, "登录"), { left: 10.2, top: 20.2, width: 99.6, height: 39.6 });
  setRect(document.querySelector("#captcha"), { left: 300.4, top: 80.4, width: 120, height: 48 });
}

function autoLoginOptions(dom, clock, fetchImpl, overrides = {}) {
  return {
    account: "demo-account",
    password: "demo-password",
    serviceUrl: "http://127.0.0.1:8765",
    root: dom.window.document,
    location: { hash: "#/pagesGrxx/pc/login/index" },
    fetch: fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0,
    sendMessage: async () => ({ ok: true }),
    ...overrides,
  };
}

function jsonResponse(payload, ok = true) {
  return { ok, json: async () => payload };
}

test("doAutoLogin：首次 OCR、填表、点击后 hash 离开登录路由即成功", async () => {
  const dom = makeLoginDom();
  const clock = makeClock();
  const location = { hash: "#/pagesGrxx/pc/login/index" };
  prepareClickTargets(dom.window.document);
  const clickRequests = [];
  const ocrRequests = [];
  const result = await doAutoLogin(autoLoginOptions(
    dom,
    clock,
    async (_url, request) => {
      ocrRequests.push(JSON.parse(request.body));
      return jsonResponse({ ok: true, text: "A7x2" });
    },
    {
      location,
      sendMessage: async (message) => {
        clickRequests.push(message);
        location.hash = "#/pagesWsla/pc/list/index";
        return { ok: true };
      },
    },
  ));

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(clickRequests, [
    { type: CLICK_REQUEST, x: 60, y: 40 },
    { type: "CLICK_SESSION_END" },
  ]);
  assert.deepEqual(ocrRequests, [{ image: "amJzZG9t" }]);
  dom.window.close();
});

test("doAutoLogin：OCR 服务不可达时返回 SERVICE_UNAVAILABLE，不提交表单", async () => {
  const dom = makeLoginDom();
  const clock = makeClock();
  prepareClickTargets(dom.window.document);
  const clickRequests = [];
  const result = await doAutoLogin(autoLoginOptions(dom, clock, async () => {
    throw new Error("transport detail must not escape");
  }, { sendMessage: async (message) => { clickRequests.push(message); return { ok: true }; } }));

  assert.deepEqual(result, { ok: false, error: "SERVICE_UNAVAILABLE" });
  assert.deepEqual(clickRequests, []);
  assert.equal(JSON.stringify(result).includes("demo-password"), false);
  dom.window.close();
});

test("doAutoLogin：DDDDOCR_MISSING 映射为 OCR_FAILED，不盲目提交", async () => {
  const dom = makeLoginDom();
  const clock = makeClock();
  prepareClickTargets(dom.window.document);
  const clickRequests = [];
  const result = await doAutoLogin(autoLoginOptions(
    dom,
    clock,
    async () => jsonResponse({ ok: false, error: "DDDDOCR_MISSING" }),
    { sendMessage: async (message) => { clickRequests.push(message); return { ok: true }; } },
  ));

  assert.deepEqual(result, { ok: false, error: "OCR_FAILED" });
  assert.deepEqual(clickRequests, []);
  dom.window.close();
});

test("doAutoLogin：首次超时只刷新一次，等待新图后节流并最多提交第二次", async () => {
  const dom = makeLoginDom();
  const clock = makeClock();
  const location = { hash: "#/pagesGrxx/pc/login/index" };
  const image = dom.window.document.querySelector("#captcha");
  prepareClickTargets(dom.window.document);
  image.src = "data:image/jpeg;base64,old-captcha";
  let refreshRequested = false;
  clock.onSleep = async () => {
    if (refreshRequested && image.getAttribute("src") === "data:image/jpeg;base64,old-captcha") {
      image.setAttribute("src", "data:image/jpeg;base64,new-captcha");
    }
  };
  const ocrRequests = [];
  const clickRequests = [];
  const result = await doAutoLogin(autoLoginOptions(
    dom,
    clock,
    async (_url, request) => {
      ocrRequests.push(JSON.parse(request.body));
      return jsonResponse({ ok: true, text: "A7x2" });
    },
    {
      location,
      sendMessage: async (message) => {
        clickRequests.push(message);
        if (message.type === CLICK_REQUEST && message.x === 360 && message.y === 104) {
          refreshRequested = true;
        }
        return { ok: true };
      },
    },
  ));

  assert.deepEqual(result, { ok: false, error: "NEEDS_HUMAN" });
  assert.deepEqual(clickRequests, [
    { type: CLICK_REQUEST, x: 60, y: 40 },
    { type: CLICK_REQUEST, x: 360, y: 104 },
    { type: CLICK_REQUEST, x: 60, y: 40 },
    { type: "CLICK_SESSION_END" },
  ]);
  assert.deepEqual(ocrRequests, [{ image: "old-captcha" }, { image: "new-captcha" }]);
  const throttleSleeps = clock.sleeps.filter((ms) => ms >= 3000 && ms <= 8000);
  assert.equal(throttleSleeps.length, 1);
  assert.equal(throttleSleeps[0], 3000);
  dom.window.close();
});

test("doAutoLogin：验证码刷新超时不读取旧图、不提交第二次", async () => {
  const dom = makeLoginDom();
  const clock = makeClock();
  prepareClickTargets(dom.window.document);
  const clickRequests = [];
  const result = await doAutoLogin(autoLoginOptions(
    dom,
    clock,
    async () => jsonResponse({ ok: true, text: "A7x2" }),
    { sendMessage: async (message) => { clickRequests.push(message); return { ok: true }; } },
  ));

  assert.deepEqual(result, { ok: false, error: "NEEDS_HUMAN" });
  assert.deepEqual(clickRequests, [
    { type: CLICK_REQUEST, x: 60, y: 40 },
    { type: CLICK_REQUEST, x: 360, y: 104 },
    { type: "CLICK_SESSION_END" },
  ]);
  dom.window.close();
});

test("doAutoLogin：刷新阶段无有效 JPEG 验证码图时不点击、不二次提交并待人工", async () => {
  const dom = makeLoginDom();
  const clock = makeClock();
  const location = { hash: "#/pagesGrxx/pc/login/index" };
  const images = [...dom.window.document.querySelectorAll("img")];
  const image = dom.window.document.querySelector("#captcha");
  prepareClickTargets(dom.window.document);
  const clickRequests = [];

  const result = await doAutoLogin(autoLoginOptions(
    dom,
    clock,
    async () => jsonResponse({ ok: true, text: "A7x2" }),
    {
      location,
      sendMessage: async (message) => {
        clickRequests.push(message);
        if (message.type === CLICK_REQUEST && message.x === 60 && message.y === 40) {
          image.setAttribute("src", "data:image/png;base64,cG5n");
        }
        return { ok: true };
      },
    },
  ));

  assert.deepEqual(result, { ok: false, error: "NEEDS_HUMAN" });
  assert.equal(images.length, 2);
  assert.deepEqual(clickRequests, [
    { type: CLICK_REQUEST, x: 60, y: 40 },
    { type: "CLICK_SESSION_END" },
  ]);
  dom.window.close();
});

test("doAutoLogin：需要时只点击一次密码登录并等待密码框出现", async () => {
  const dom = new JSDOM(`
    <main>
      <view id="password-tab">密码登录</view>
      <input type="text" class="uni-input-input" aria-label="账号">
      <input type="text" class="uni-input-input" aria-label="验证码">
      <img src="data:image/jpeg;base64,amJzZG9t">
      <view id="submit-view">登录</view>
    </main>
  `);
  const clock = makeClock();
  let tabClicks = 0;
  let formAdded = false;
  const messages = [];
  const tab = dom.window.document.querySelector("#password-tab");
  tab.addEventListener("click", () => { tabClicks += 1; });
  clock.onSleep = async () => {
    if (!formAdded) {
      const password = dom.window.document.createElement("input");
      password.type = "password";
      password.className = "uni-input-input";
      password.setAttribute("aria-label", "密码");
      dom.window.document.querySelector("main").insertBefore(password, dom.window.document.querySelector("img"));
      formAdded = true;
    }
  };
  const location = { hash: "#/pagesGrxx/pc/login/index" };
  setRect(tab, { left: 48, top: 12, width: 104, height: 32 });
  setRect(dom.window.document.querySelector("#submit-view"), { left: 8, top: 16, width: 40, height: 20 });
  setRect(dom.window.document.querySelector("img"), { left: 100, top: 100, width: 80, height: 40 });

  const result = await doAutoLogin(autoLoginOptions(
    dom,
    clock,
    async () => jsonResponse({ ok: true, text: "A7x2" }),
    {
      location,
      sendMessage: async (message) => {
        messages.push(message);
        if (message.type === CLICK_REQUEST && message.x === 28 && message.y === 26) {
          location.hash = "#/pagesWsla/pc/list/index";
        }
        return { ok: true };
      },
    },
  ));
  assert.deepEqual(result, { ok: true });
  assert.equal(tabClicks, 0);
  assert.deepEqual(messages, [
    { type: CLICK_REQUEST, x: 100, y: 28 },
    { type: CLICK_REQUEST, x: 28, y: 26 },
    { type: "CLICK_SESSION_END" },
  ]);
  dom.window.close();
});

test("doAutoLogin：密码 tab 切换走 CLICK_REQUEST，不触发合成 click", async () => {
  const dom = new JSDOM(`
    <main>
      <view id="password-tab">密码登录</view>
      <input type="text" class="uni-input-input" aria-label="账号">
      <input type="text" class="uni-input-input" aria-label="验证码">
      <img src="data:image/jpeg;base64,amJzZG9t">
      <view id="submit-view">登录</view>
    </main>
  `);
  const clock = makeClock();
  const location = { hash: "#/pagesGrxx/pc/login/index" };
  const tab = dom.window.document.querySelector("#password-tab");
  const submit = dom.window.document.querySelector("#submit-view");
  const image = dom.window.document.querySelector("img");
  let syntheticTabClicks = 0;
  tab.addEventListener("click", () => { syntheticTabClicks += 1; });
  setRect(tab, { left: 90, top: 10, width: 80, height: 30 });
  setRect(submit, { left: 8, top: 16, width: 40, height: 20 });
  setRect(image, { left: 100, top: 100, width: 80, height: 40 });
  const messages = [];

  const result = await doAutoLogin(autoLoginOptions(
    dom,
    clock,
    async () => jsonResponse({ ok: true, text: "A7x2" }),
    {
      location,
      sendMessage: async (message) => {
        messages.push(message);
        if (message.type === CLICK_REQUEST && message.x === 130 && message.y === 25) {
          const password = dom.window.document.createElement("input");
          password.type = "password";
          password.className = "uni-input-input";
          password.setAttribute("aria-label", "密码");
          dom.window.document.querySelector("main").insertBefore(password, image);
        }
        if (message.type === CLICK_REQUEST && message.x === 28 && message.y === 26) {
          location.hash = "#/pagesWsla/pc/list/index";
        }
        return { ok: true };
      },
    },
  ));

  assert.deepEqual(result, { ok: true });
  assert.equal(syntheticTabClicks, 0);
  assert.deepEqual(messages, [
    { type: CLICK_REQUEST, x: 130, y: 25 },
    { type: CLICK_REQUEST, x: 28, y: 26 },
    { type: "CLICK_SESSION_END" },
  ]);
  dom.window.close();
});

test("doAutoLogin：并发调用单飞，避免双击并行提交", async () => {
  const dom = makeLoginDom();
  const clock = makeClock();
  const location = { hash: "#/pagesGrxx/pc/login/index" };
  prepareClickTargets(dom.window.document);
  let clickRequests = 0;
  let releaseFetch;
  const fetchStarted = new Promise((resolve) => { releaseFetch = resolve; });
  const fetchImpl = async () => {
    await fetchStarted;
    return jsonResponse({ ok: true, text: "A7x2" });
  };
  const first = doAutoLogin(autoLoginOptions(dom, clock, fetchImpl, {
    location,
    sendMessage: async (message) => {
      if (message.type === CLICK_REQUEST) {
        clickRequests += 1;
        location.hash = "#/pagesWsla/pc/list/index";
      }
      return { ok: true };
    },
  }));
  const second = doAutoLogin(autoLoginOptions(dom, clock, fetchImpl, {
    location,
    sendMessage: async () => {
      throw new Error("single-flight should reuse the first run");
    },
  }));
  assert.equal(first, second);
  releaseFetch();
  assert.deepEqual(await first, { ok: true });
  assert.equal(clickRequests, 1);
  dom.window.close();
});

test("requestTrustedClick：中心点取整后发送 CLICK_REQUEST，content 不携带 tabId", async () => {
  const dom = makeLoginDom();
  const submit = findExactTextView(dom.window.document, "登录");
  setRect(submit, { left: 10.2, top: 20.2, width: 99.6, height: 39.6 });
  const messages = [];

  const response = await requestTrustedClick(submit, {
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });

  assert.deepEqual(getElementCenterPoint(submit), { ok: true, x: 60, y: 40 });
  assert.deepEqual(response, { ok: true });
  assert.deepEqual(messages, [{ type: CLICK_REQUEST, x: 60, y: 40 }]);
  assert.equal("tabId" in messages[0], false);
  dom.window.close();
});

test("requestTrustedClick：无有效 rect 时返回 FORM_NOT_READY 且不发消息", async () => {
  const dom = makeLoginDom();
  const submit = findExactTextView(dom.window.document, "登录");
  const messages = [];

  const response = await requestTrustedClick(submit, {
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });

  assert.deepEqual(getElementCenterPoint(submit), { ok: false, error: "FORM_NOT_READY" });
  assert.deepEqual(response, { ok: false, error: "FORM_NOT_READY" });
  assert.deepEqual(messages, []);
  dom.window.close();
});

test("requestTrustedClick：visibility hidden 或 opacity 0 时返回 FORM_NOT_READY", async () => {
  const hiddenDom = makeLoginDom();
  const hiddenSubmit = findExactTextView(hiddenDom.window.document, "登录");
  setRect(hiddenSubmit, { left: 10, top: 20, width: 100, height: 40 });
  hiddenSubmit.style.visibility = "hidden";
  const messages = [];

  assert.deepEqual(getElementCenterPoint(hiddenSubmit), { ok: false, error: "FORM_NOT_READY" });
  assert.deepEqual(await requestTrustedClick(hiddenSubmit, {
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  }), { ok: false, error: "FORM_NOT_READY" });
  assert.deepEqual(messages, []);
  hiddenDom.window.close();

  const transparentDom = makeLoginDom();
  const transparentSubmit = findExactTextView(transparentDom.window.document, "登录");
  setRect(transparentSubmit, { left: 10, top: 20, width: 100, height: 40 });
  transparentSubmit.style.opacity = "0";
  assert.deepEqual(getElementCenterPoint(transparentSubmit), { ok: false, error: "FORM_NOT_READY" });
  transparentDom.window.close();
});

test("requestTrustedClick：sendMessage 永不回调时有界超时返回 NEEDS_HUMAN", async () => {
  const dom = makeLoginDom();
  const submit = findExactTextView(dom.window.document, "登录");
  setRect(submit, { left: 10, top: 20, width: 100, height: 40 });

  const response = await Promise.race([
    requestTrustedClick(submit, {
      runtimeMessageTimeoutMs: 5,
      sendMessage() {
        // Intentionally never calls the callback and returns no Promise.
      },
    }),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "TEST_TIMEOUT" }), 50)),
  ]);

  assert.deepEqual(response, { ok: false, error: "NEEDS_HUMAN" });
  dom.window.close();
});

test("doAutoLogin：CLICK_REQUEST 失败时返回 NEEDS_HUMAN，不做合成点击兜底", async () => {
  const dom = makeLoginDom();
  const clock = makeClock();
  prepareClickTargets(dom.window.document);
  let syntheticClicks = 0;
  const messages = [];
  findExactTextView(dom.window.document, "登录").addEventListener("click", () => { syntheticClicks += 1; });

  const result = await doAutoLogin(autoLoginOptions(
    dom,
    clock,
    async () => jsonResponse({ ok: true, text: "A7x2" }),
    {
      sendMessage: async (message) => {
        messages.push(message);
        return { ok: false, error: "NEEDS_HUMAN" };
      },
    },
  ));

  assert.deepEqual(result, { ok: false, error: "NEEDS_HUMAN" });
  assert.equal(syntheticClicks, 0);
  assert.deepEqual(messages, [{ type: CLICK_REQUEST, x: 60, y: 40 }]);
  dom.window.close();
});

test("doAutoLogin：runtime 消息不可达时返回 NEEDS_HUMAN", async () => {
  const dom = makeLoginDom();
  const clock = makeClock();
  prepareClickTargets(dom.window.document);

  const result = await doAutoLogin(autoLoginOptions(
    dom,
    clock,
    async () => jsonResponse({ ok: true, text: "A7x2" }),
    { sendMessage: async () => { throw new Error("runtime disconnected"); } },
  ));

  assert.deepEqual(result, { ok: false, error: "NEEDS_HUMAN" });
  dom.window.close();
});
