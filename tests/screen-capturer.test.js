import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAPTURE_OPTIONS,
  captureElement,
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

test("captureElement 仅在克隆页面移除跨域装饰背景并关闭 html2canvas 日志", async () => {
  const attrs = new Map();
  const target = {
    id: "synthetic-evidence-region",
    setAttribute(name, value) { attrs.set(name, value); },
    removeAttribute(name) { attrs.delete(name); },
  };
  const decorative = { style: { setProperty(name, value, priority) { this.applied = [name, value, priority]; } } };
  const evidence = { style: { setProperty() { throw new Error("evidence style must stay unchanged"); } } };
  const cloneRoot = { querySelectorAll: () => [decorative, evidence] };
  const cloneDocument = {
    querySelector: (selector) => selector.includes([...attrs.values()][0]) ? cloneRoot : null,
    defaultView: {
      getComputedStyle: (node) => ({
        backgroundImage: node === decorative
          ? 'url("https://example.invalid/images/mycase/yja-status-bg.png")'
          : "none",
      }),
    },
  };
  const calls = [];
  const dataUrl = "data:image/jpeg;base64," + Buffer.from([1, 2, 3]).toString("base64");
  const blob = await captureElement(target, {
    scale: 3,
    renderer: async (element, options) => {
      calls.push({ element, options });
      options.onclone(cloneDocument);
      return { toDataURL: () => dataUrl };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].element, target);
  assert.equal(calls[0].options.scale, 3);
  assert.equal(calls[0].options.useCORS, true);
  assert.equal(calls[0].options.backgroundColor, "#ffffff");
  assert.equal(calls[0].options.logging, false);
  assert.equal(typeof calls[0].options.onclone, "function");
  assert.deepEqual(decorative.style.applied, ["background-image", "none", "important"]);
  assert.equal(attrs.size, 0);
  assert.equal(blob.type, "image/jpeg");
  assert.equal(blob.size, 3);
});

test("captureElement 渲染失败也移除真实 DOM 上的临时标记", async () => {
  const attrs = new Map();
  const target = {
    setAttribute(name, value) { attrs.set(name, value); },
    removeAttribute(name) { attrs.delete(name); },
  };
  await assert.rejects(
    captureElement(target, { renderer: async () => { throw new Error("synthetic render failure"); } }),
    /synthetic render failure/,
  );
  assert.equal(attrs.size, 0);
});
