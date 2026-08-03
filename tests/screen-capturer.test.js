import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAPTURE_OPTIONS,
  captureVisibleTab,
  dataUrlToBlob,
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
