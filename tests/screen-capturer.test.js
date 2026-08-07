import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAPTURE_OPTIONS,
  captureVisibleTab,
  dataUrlToBlob,
  requestVisibleTabCapture,
} from "../extension/content/screen-capturer.js";

test("captureVisibleTab 调用 chrome.tabs.captureVisibleTab 并返回 JPEG Blob", async () => {
  const calls = [];
  globalThis.chrome = {
    tabs: {
      captureVisibleTab: async (windowId, opts) => {
        calls.push({ windowId, opts });
        return "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff]).toString("base64");
      },
    },
  };
  try {
    const blob = await captureVisibleTab(42);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].windowId, 42);
    assert.deepEqual(calls[0].opts, { format: "jpeg", quality: 0.85 });
    assert.equal(blob.type, "image/jpeg");
    assert.equal(blob.size, 3);
  } finally {
    delete globalThis.chrome;
  }
});

test("CAPTURE_OPTIONS 固定 JPEG 质量 0.85", () => {
  assert.deepEqual(CAPTURE_OPTIONS, { format: "jpeg", quality: 0.85 });
});

test("dataUrlToBlob 解析 base64 数据", () => {
  const blob = dataUrlToBlob("data:image/jpeg;base64," + Buffer.from("hello").toString("base64"));
  assert.equal(blob.type, "image/jpeg");
  assert.equal(blob.size, 5);
});

test("content 通过 Service Worker 截取消息发送方的活动法院标签", async () => {
  const dataUrl = "data:image/jpeg;base64," + Buffer.from([1, 2, 3]).toString("base64");
  const messages = [];
  const blob = await requestVisibleTabCapture({
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        return { ok: true, dataUrl };
      },
    },
  });
  assert.deepEqual(messages, [{ type: "CAPTURE_VISIBLE_TAB" }]);
  assert.equal(blob.type, "image/jpeg");
  assert.equal(blob.size, 3);
});
