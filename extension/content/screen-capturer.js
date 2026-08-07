// screen-capturer.js — 截图模块：captureVisibleTab → JPEG Blob（质量 0.85）
// 依据 docs/specs/excel-module.md 与计划 Task 4.1；DOM 就绪握手由批量执行器（Phase 6）负责。
export const CAPTURE_OPTIONS = { format: "jpeg", quality: 0.85 };

/**
 * 截取指定窗口当前可视区域。
 * @param {number} [windowId] 省略时截当前窗口
 * @returns {Promise<Blob>} JPEG Blob
 */
export async function captureVisibleTab(windowId) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, CAPTURE_OPTIONS);
  return dataUrlToBlob(dataUrl);
}

/** dataURL → Blob（atob 逐字节转换，避免中文/大图截断） */
export function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(",");
  const mime = /^data:(.*?);/.exec(meta)?.[1] || "image/jpeg";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * 截取 DOM 元素为 JPEG Blob（html2canvas，content script 内可用，无需扩展权限）。
 * @param {Element} el 目标元素（如审核结果区）
 * @param {{scale?: number, renderer?: Function}} [opts]
 * @returns {Promise<Blob>}
 */
export async function captureElement(el, { scale = 2, renderer = null } = {}) {
  const render = renderer ?? (await import("html2canvas")).default;
  const canvas = await render(el, { scale, useCORS: true, backgroundColor: "#ffffff" });
  const dataUrl = canvas.toDataURL("image/jpeg", CAPTURE_OPTIONS.quality);
  return dataUrlToBlob(dataUrl);
}
