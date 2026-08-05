import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { SELECTORS } from "../extension/content/selectors.js";
import { doAutoLogin, fetchCaptchaBase64, fillLoginForm, findExactTextView } from "../extension/content/login-auto.js";

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
  let submits = 0;
  const submit = findExactTextView(dom.window.document, "登录");
  submit.addEventListener("click", () => {
    submits += 1;
    location.hash = "#/pagesWsla/pc/list/index";
  });
  const ocrRequests = [];
  const result = await doAutoLogin(autoLoginOptions(
    dom,
    clock,
    async (_url, request) => {
      ocrRequests.push(JSON.parse(request.body));
      return jsonResponse({ ok: true, text: "A7x2" });
    },
    { location },
  ));

  assert.deepEqual(result, { ok: true });
  assert.equal(submits, 1);
  assert.deepEqual(ocrRequests, [{ image: "amJzZG9t" }]);
  dom.window.close();
});

test("doAutoLogin：OCR 服务不可达时返回 SERVICE_UNAVAILABLE，不提交表单", async () => {
  const dom = makeLoginDom();
  const clock = makeClock();
  let submits = 0;
  findExactTextView(dom.window.document, "登录").addEventListener("click", () => { submits += 1; });
  const result = await doAutoLogin(autoLoginOptions(dom, clock, async () => {
    throw new Error("transport detail must not escape");
  }));

  assert.deepEqual(result, { ok: false, error: "SERVICE_UNAVAILABLE" });
  assert.equal(submits, 0);
  assert.equal(JSON.stringify(result).includes("demo-password"), false);
  dom.window.close();
});

test("doAutoLogin：DDDDOCR_MISSING 映射为 OCR_FAILED，不盲目提交", async () => {
  const dom = makeLoginDom();
  const clock = makeClock();
  let submits = 0;
  findExactTextView(dom.window.document, "登录").addEventListener("click", () => { submits += 1; });
  const result = await doAutoLogin(autoLoginOptions(
    dom,
    clock,
    async () => jsonResponse({ ok: false, error: "DDDDOCR_MISSING" }),
  ));

  assert.deepEqual(result, { ok: false, error: "OCR_FAILED" });
  assert.equal(submits, 0);
  dom.window.close();
});

test("doAutoLogin：首次超时只刷新一次，等待新图后节流并最多提交第二次", async () => {
  const dom = makeLoginDom();
  const clock = makeClock();
  const location = { hash: "#/pagesGrxx/pc/login/index" };
  const image = dom.window.document.querySelector("#captcha");
  image.src = "data:image/jpeg;base64,old-captcha";
  let refreshRequested = false;
  let refreshes = 0;
  let submits = 0;
  image.addEventListener("click", () => {
    refreshRequested = true;
    refreshes += 1;
  });
  clock.onSleep = async () => {
    if (refreshRequested && image.getAttribute("src") === "data:image/jpeg;base64,old-captcha") {
      image.setAttribute("src", "data:image/jpeg;base64,new-captcha");
    }
  };
  findExactTextView(dom.window.document, "登录").addEventListener("click", () => { submits += 1; });
  const ocrRequests = [];
  const result = await doAutoLogin(autoLoginOptions(
    dom,
    clock,
    async (_url, request) => {
      ocrRequests.push(JSON.parse(request.body));
      return jsonResponse({ ok: true, text: "A7x2" });
    },
    { location },
  ));

  assert.deepEqual(result, { ok: false, error: "NEEDS_HUMAN" });
  assert.equal(submits, 2);
  assert.equal(refreshes, 1);
  assert.deepEqual(ocrRequests, [{ image: "old-captcha" }, { image: "new-captcha" }]);
  const throttleSleeps = clock.sleeps.filter((ms) => ms >= 3000 && ms <= 8000);
  assert.equal(throttleSleeps.length, 1);
  assert.equal(throttleSleeps[0], 3000);
  dom.window.close();
});

test("doAutoLogin：验证码刷新超时不读取旧图、不提交第二次", async () => {
  const dom = makeLoginDom();
  const clock = makeClock();
  let submits = 0;
  let refreshes = 0;
  const image = dom.window.document.querySelector("#captcha");
  image.addEventListener("click", () => { refreshes += 1; });
  findExactTextView(dom.window.document, "登录").addEventListener("click", () => { submits += 1; });
  const result = await doAutoLogin(autoLoginOptions(
    dom,
    clock,
    async () => jsonResponse({ ok: true, text: "A7x2" }),
  ));

  assert.deepEqual(result, { ok: false, error: "NEEDS_HUMAN" });
  assert.equal(refreshes, 1);
  assert.equal(submits, 1);
  dom.window.close();
});

test("doAutoLogin：刷新阶段无有效 JPEG 验证码图时不点击、不二次提交并待人工", async () => {
  const dom = makeLoginDom();
  const clock = makeClock();
  const location = { hash: "#/pagesGrxx/pc/login/index" };
  const image = dom.window.document.querySelector("#captcha");
  let captchaClicks = 0;
  let submits = 0;
  image.addEventListener("click", () => { captchaClicks += 1; });
  findExactTextView(dom.window.document, "登录").addEventListener("click", () => {
    submits += 1;
    image.setAttribute("src", "data:image/png;base64,cG5n");
  });

  const result = await doAutoLogin(autoLoginOptions(
    dom,
    clock,
    async () => jsonResponse({ ok: true, text: "A7x2" }),
    { location },
  ));

  assert.deepEqual(result, { ok: false, error: "NEEDS_HUMAN" });
  assert.equal(captchaClicks, 0);
  assert.equal(submits, 1);
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
  dom.window.document.querySelector("#submit-view").addEventListener("click", () => {
    location.hash = "#/pagesWsla/pc/list/index";
  });

  const result = await doAutoLogin(autoLoginOptions(
    dom,
    clock,
    async () => jsonResponse({ ok: true, text: "A7x2" }),
    { location },
  ));
  assert.deepEqual(result, { ok: true });
  assert.equal(tabClicks, 1);
  dom.window.close();
});

test("doAutoLogin：并发调用单飞，避免双击并行提交", async () => {
  const dom = makeLoginDom();
  const clock = makeClock();
  const location = { hash: "#/pagesGrxx/pc/login/index" };
  let submits = 0;
  findExactTextView(dom.window.document, "登录").addEventListener("click", () => {
    submits += 1;
    location.hash = "#/pagesWsla/pc/list/index";
  });
  let releaseFetch;
  const fetchStarted = new Promise((resolve) => { releaseFetch = resolve; });
  const fetchImpl = async () => {
    await fetchStarted;
    return jsonResponse({ ok: true, text: "A7x2" });
  };
  const first = doAutoLogin(autoLoginOptions(dom, clock, fetchImpl, { location }));
  const second = doAutoLogin(autoLoginOptions(dom, clock, fetchImpl, { location }));
  assert.equal(first, second);
  releaseFetch();
  assert.deepEqual(await first, { ok: true });
  assert.equal(submits, 1);
  dom.window.close();
});
