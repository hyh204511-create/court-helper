import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { runQueryAllExport, switchQueryCategory } from "../extension/content/query-all-export.js";

test("一键流程严格按审判查询、执行查询、导出顺序运行", async () => {
  const calls = [];
  const result = await runQueryAllExport({
    switchCategory: async (kind) => { calls.push(`switch:${kind}`); return { ok: true }; },
    queryKind: async (kind) => {
      calls.push(`query:${kind}`);
      return kind === "li" ? { ok: false, error: "NEEDS_HUMAN", stats: { needsHuman: 1 } } : { ok: true };
    },
    exportReport: async () => { calls.push("export"); return { ok: true, upload: { status: "uploaded" } }; },
  });

  assert.equal(result.ok, true);
  assert.equal(result.needsHuman, true);
  assert.deepEqual(calls, ["switch:li", "query:li", "switch:qz", "query:qz", "export"]);
});

test("一键流程遇到结构硬失败立即停止且不导出", async () => {
  let exported = 0;
  const result = await runQueryAllExport({
    switchCategory: async (kind) => kind === "li" ? { ok: true } : { ok: false, error: "SELECTOR_CHANGED" },
    queryKind: async () => ({ ok: true }),
    exportReport: async () => { exported += 1; return { ok: true }; },
  });

  assert.deepEqual(result, { ok: false, error: "SELECTOR_CHANGED" });
  assert.equal(exported, 0);
});

test("分类切换只点击唯一精确文本 tab 和唯一查询按钮", async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="fd-com-tab"><button>审判</button><button>执行</button><button>执行帮助</button></div>
    <button class="fd-com-search-btn">查询</button>
    <div class="fd-com-list-container"></div>
  </body>`);
  const clicks = [];
  dom.window.document.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => clicks.push(button.textContent.trim()));
  });

  const result = await switchQueryCategory(dom.window.document, "qz", {
    waitForList: async () => true,
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(clicks, ["执行", "查询"]);
});

test("分类精确文本重复时返回 SELECTOR_CHANGED 且不点击查询", async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="fd-com-tab"><button>执行</button><button>执行</button></div>
    <button class="fd-com-search-btn">查询</button>
  </body>`);
  let clicks = 0;
  dom.window.document.querySelector(".fd-com-search-btn").addEventListener("click", () => { clicks += 1; });

  const result = await switchQueryCategory(dom.window.document, "qz", { waitForList: async () => true });

  assert.deepEqual(result, { ok: false, error: "SELECTOR_CHANGED" });
  assert.equal(clicks, 0);
});
