import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLICK_REQUEST,
  CLICK_SESSION_END,
  createDebuggerDriver,
} from "../extension/sw/debugger-driver.js";

function makeScheduler() {
  const timers = [];
  return {
    timers,
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
  };
}

function makeChrome({ attachError = null, sendErrorAt = -1 } = {}) {
  const calls = {
    attach: [],
    sendCommand: [],
    detach: [],
  };
  const detachListeners = [];
  const chromeApi = {
    runtime: { lastError: null },
    debugger: {
      attach(target, version, callback) {
        calls.attach.push({ target, version });
        chromeApi.runtime.lastError = attachError ? { message: attachError } : null;
        callback?.();
        chromeApi.runtime.lastError = null;
      },
      sendCommand(target, method, params, callback) {
        calls.sendCommand.push({ target, method, params });
        const shouldFail = calls.sendCommand.length === sendErrorAt;
        chromeApi.runtime.lastError = shouldFail ? { message: "send failed" } : null;
        callback?.();
        chromeApi.runtime.lastError = null;
      },
      detach(target, callback) {
        calls.detach.push({ target });
        callback?.();
      },
      onDetach: {
        addListener(listener) {
          detachListeners.push(listener);
        },
      },
    },
  };
  return { chromeApi, calls, detachListeners };
}

function makeDeferredAttachChrome() {
  const calls = {
    attach: [],
    sendCommand: [],
    detach: [],
  };
  const attachResolves = [];
  const chromeApi = {
    runtime: { lastError: null },
    debugger: {
      attach(target, version, callback) {
        calls.attach.push({ target, version });
        return new Promise((resolve) => {
          attachResolves.push(() => {
            callback?.();
            resolve();
          });
        });
      },
      sendCommand(target, method, params, callback) {
        calls.sendCommand.push({ target, method, params });
        callback?.();
      },
      detach(target, callback) {
        calls.detach.push({ target });
        callback?.();
      },
      onDetach: {
        addListener() {},
      },
    },
  };
  return { chromeApi, calls, attachResolves };
}

function request(driver, message, sender) {
  let response;
  const asyncResponse = driver.handleMessage(message, sender, (value) => {
    response = value;
  });
  return Promise.resolve(asyncResponse === true ? undefined : asyncResponse)
    .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
    .then(() => response);
}

const courtSender = {
  tab: {
    id: 23,
    url: "https://zxfw.court.gov.cn/zxfw/#/pagesGrxx/pc/login/index",
  },
};

test("debugger driver：成功点击 attach 一次，按顺序透传坐标并结束 detach", async () => {
  const scheduler = makeScheduler();
  const { chromeApi, calls } = makeChrome();
  const driver = createDebuggerDriver({ chromeApi, scheduler });

  const first = await request(driver, { type: CLICK_REQUEST, x: 101, y: 202 }, courtSender);
  const second = await request(driver, { type: CLICK_REQUEST, x: 303, y: 404 }, courtSender);
  const ended = await request(driver, { type: CLICK_SESSION_END }, courtSender);

  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });
  assert.deepEqual(ended, { ok: true });
  assert.deepEqual(calls.attach, [{ target: { tabId: 23 }, version: "1.3" }]);
  assert.deepEqual(calls.sendCommand.map((call) => [call.params.type, call.params.x, call.params.y]), [
    ["mousePressed", 101, 202],
    ["mouseReleased", 101, 202],
    ["mousePressed", 303, 404],
    ["mouseReleased", 303, 404],
  ]);
  assert.ok(calls.sendCommand.every((call) => call.method === "Input.dispatchMouseEvent"));
  assert.ok(calls.sendCommand.every((call) => call.params.button === "left" && call.params.clickCount === 1));
  assert.deepEqual(calls.detach, [{ target: { tabId: 23 } }]);
  assert.ok(scheduler.timers.every((timer) => timer.cleared));
});

test("debugger driver：attach 失败回执 NEEDS_HUMAN 且不发送鼠标事件", async () => {
  const { chromeApi, calls } = makeChrome({ attachError: "permission denied" });
  const driver = createDebuggerDriver({ chromeApi, scheduler: makeScheduler() });

  const response = await request(driver, { type: CLICK_REQUEST, x: 10, y: 20 }, courtSender);

  assert.deepEqual(response, { ok: false, error: "NEEDS_HUMAN" });
  assert.equal(calls.attach.length, 1);
  assert.equal(calls.sendCommand.length, 0);
  assert.equal(calls.detach.length, 0);
});

test("debugger driver：非法院平台 tab 拒绝，不 attach", async () => {
  const { chromeApi, calls } = makeChrome();
  const driver = createDebuggerDriver({ chromeApi, scheduler: makeScheduler() });

  const response = await request(
    driver,
    { type: CLICK_REQUEST, x: 10, y: 20 },
    { tab: { id: 99, url: "https://example.com/" } },
  );

  assert.deepEqual(response, { ok: false, error: "NEEDS_HUMAN" });
  assert.equal(calls.attach.length, 0);
  assert.equal(calls.sendCommand.length, 0);
});

test("debugger driver：非法院平台 tab 的 CLICK_SESSION_END 不 detach 法院会话", async () => {
  const { chromeApi, calls } = makeChrome();
  const driver = createDebuggerDriver({ chromeApi, scheduler: makeScheduler() });

  assert.deepEqual(await request(driver, { type: CLICK_REQUEST, x: 10, y: 20 }, courtSender), { ok: true });
  const response = await request(
    driver,
    { type: CLICK_SESSION_END },
    { tab: { id: 23, url: "https://example.com/" } },
  );

  assert.deepEqual(response, { ok: true });
  assert.equal(driver.isAttached(23), true);
  assert.deepEqual(calls.detach, []);
});

test("debugger driver：同 tab 并发 CLICK_REQUEST 复用同一个 attach", async () => {
  const { chromeApi, calls, attachResolves } = makeDeferredAttachChrome();
  const driver = createDebuggerDriver({ chromeApi, scheduler: makeScheduler() });
  const responses = [];

  driver.handleMessage({ type: CLICK_REQUEST, x: 10, y: 20 }, courtSender, (value) => {
    responses.push(value);
  });
  driver.handleMessage({ type: CLICK_REQUEST, x: 30, y: 40 }, courtSender, (value) => {
    responses.push(value);
  });

  assert.equal(calls.attach.length, 1);
  attachResolves[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(responses, [{ ok: true }, { ok: true }]);
  assert.equal(calls.attach.length, 1);
  assert.deepEqual(calls.sendCommand.map((call) => [call.params.type, call.params.x, call.params.y]), [
    ["mousePressed", 10, 20],
    ["mousePressed", 30, 40],
    ["mouseReleased", 10, 20],
    ["mouseReleased", 30, 40],
  ]);
});

test("debugger driver：sendCommand 失败回执 NEEDS_HUMAN 并清理 attach", async () => {
  const { chromeApi, calls } = makeChrome({ sendErrorAt: 2 });
  const driver = createDebuggerDriver({ chromeApi, scheduler: makeScheduler() });

  const response = await request(driver, { type: CLICK_REQUEST, x: 10, y: 20 }, courtSender);

  assert.deepEqual(response, { ok: false, error: "NEEDS_HUMAN" });
  assert.equal(calls.attach.length, 1);
  assert.equal(calls.sendCommand.length, 2);
  assert.deepEqual(calls.detach, [{ target: { tabId: 23 } }]);
});

test("debugger driver：onDetach 清理状态，后续点击会重新 attach", async () => {
  const { chromeApi, calls, detachListeners } = makeChrome();
  const driver = createDebuggerDriver({ chromeApi, scheduler: makeScheduler() });

  assert.deepEqual(await request(driver, { type: CLICK_REQUEST, x: 1, y: 2 }, courtSender), { ok: true });
  detachListeners[0]({ tabId: 23 }, "target_closed");
  assert.deepEqual(await request(driver, { type: CLICK_REQUEST, x: 3, y: 4 }, courtSender), { ok: true });

  assert.equal(calls.attach.length, 2);
  assert.equal(calls.detach.length, 0);
});

test("debugger driver：自动登录会话超时后自动 detach", async () => {
  const scheduler = makeScheduler();
  const { chromeApi, calls } = makeChrome();
  const driver = createDebuggerDriver({ chromeApi, scheduler, autoDetachMs: 1234 });

  assert.deepEqual(await request(driver, { type: CLICK_REQUEST, x: 1, y: 2 }, courtSender), { ok: true });
  assert.equal(calls.detach.length, 0);
  assert.equal(scheduler.timers.at(-1).delay, 1234);

  scheduler.timers.at(-1).callback();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls.detach, [{ target: { tabId: 23 } }]);
  assert.equal(driver.isAttached(23), false);
});
