import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { runQueryAllExport, switchQueryCategory, waitForListQuiet } from "../extension/content/query-all-export.js";

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

test("一键流程允许仅一类有记录：另一类切换超时但结构化探测确认为空时仍导出", async () => {
  const calls = [];
  const result = await runQueryAllExport({
    switchCategory: async (kind) => {
      calls.push(`switch:${kind}`);
      return kind === "li" ? { ok: false, error: "QUERY_TAB_TIMEOUT" } : { ok: true };
    },
    queryKind: async (kind) => {
      calls.push(`query:${kind}`);
      return kind === "li"
        ? { ok: true, stats: { total: 0, completed: 0, needsHuman: 0 } }
        : { ok: true, stats: { total: 1, completed: 1, needsHuman: 0 } };
    },
    exportReport: async () => {
      calls.push("export");
      return { ok: true, upload: { status: "uploaded" } };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["switch:li", "query:li", "switch:qz", "query:qz", "export"]);
});

test("一键流程不能用另一类成功掩盖 API-DOM 硬失败", async () => {
  let exported = 0;
  const result = await runQueryAllExport({
    switchCategory: async () => ({ ok: true }),
    queryKind: async (kind) => kind === "li"
      ? { ok: false, error: "API_DOM_MISMATCH" }
      : { ok: true, stats: { total: 1, completed: 1, needsHuman: 0 } },
    exportReport: async () => { exported += 1; return { ok: true }; },
  });

  assert.deepEqual(result, { ok: false, error: "API_DOM_MISMATCH" });
  assert.equal(exported, 0);
});

test("分类切换超时后的结构化探测出现 API-DOM 硬失败时仍不导出", async () => {
  let exported = 0;
  const result = await runQueryAllExport({
    switchCategory: async () => ({ ok: false, error: "QUERY_TAB_TIMEOUT" }),
    queryKind: async () => ({ ok: false, error: "API_DOM_MISMATCH" }),
    exportReport: async () => { exported += 1; return { ok: true }; },
  });

  assert.deepEqual(result, { ok: false, error: "API_DOM_MISMATCH" });
  assert.equal(exported, 0);
});

test("API-DOM 复核前等待案件列表连续静默", async () => {
  const dom = new JSDOM(`<!doctype html><body><div class="fd-com-list-container"><div>OLD</div></div></body>`);
  const container = dom.window.document.querySelector(".fd-com-list-container");
  const waiting = waitForListQuiet(dom.window.document, { quietMs: 30, timeoutMs: 200 });
  dom.window.setTimeout(() => { container.innerHTML = "<div>NEW</div>"; }, 15);
  assert.equal(await waiting, true);
  assert.equal(
    await waitForListQuiet(new JSDOM("<!doctype html><body></body>").window.document, { quietMs: 5, timeoutMs: 20 }),
    false,
  );
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

test("默认等待器不会把旧分类残留空态当作目标分类已稳定", async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="fd-com-tab"><button>审判</button><button>执行</button></div>
    <button class="fd-com-search-btn">查询</button>
    <div class="fd-com-list-container">暂无数据</div>
  </body>`);
  dom.window.document.querySelector(".fd-com-search-btn").addEventListener("click", () => {
    dom.window.setTimeout(() => {
      dom.window.document.querySelector(".fd-com-list-container").innerHTML = `
        <div class="fd-case-item"><div class="fd-header-ajlx">首次执行案件</div></div>`;
    }, 20);
  });

  const result = await switchQueryCategory(dom.window.document, "qz", {
    afterTabClick: async () => undefined,
    timeoutMs: 300,
    intervalMs: 5,
    settleMs: 10,
  });

  assert.deepEqual(result, { ok: true });
  assert.match(dom.window.document.querySelector(".fd-com-list-container").textContent, /首次执行案件/);
});

test("默认等待器不会把旧目标分类行当作本次查询已完成", async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="fd-com-tab"><button>审判</button><button>执行</button></div>
    <button class="fd-com-search-btn">查询</button>
    <div class="fd-com-list-container">
      <div class="fd-case-item"><div class="fd-header-ajmc">OLD ROW</div><div class="fd-header-ajlx">民事一审案件</div></div>
    </div>
  </body>`);
  dom.window.document.querySelector(".fd-com-search-btn").addEventListener("click", () => {
    dom.window.setTimeout(() => {
      dom.window.document.querySelector(".fd-com-list-container").innerHTML = `
        <div class="fd-case-item"><div class="fd-header-ajmc">NEW ROW</div><div class="fd-header-ajlx">民事一审案件</div></div>`;
    }, 20);
  });

  const result = await switchQueryCategory(dom.window.document, "li", {
    afterTabClick: async () => undefined,
    timeoutMs: 300,
    intervalMs: 5,
    settleMs: 10,
  });

  assert.deepEqual(result, { ok: true });
  assert.match(dom.window.document.querySelector(".fd-com-list-container").textContent, /NEW ROW/);
});

test("默认等待器不会把加载提示变更和旧同分类案件行当作新查询结果", async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="fd-com-tab"><button>审判</button><button>执行</button></div>
    <button class="fd-com-search-btn">查询</button>
    <div class="fd-com-list-container">
      <div class="fd-case-item"><div class="fd-header-ajmc">OLD ROW</div><div class="fd-header-ajlx">民事一审案件</div></div>
    </div>
  </body>`);
  dom.window.document.querySelector(".fd-com-search-btn").addEventListener("click", () => {
    const container = dom.window.document.querySelector(".fd-com-list-container");
    container.insertAdjacentHTML("beforeend", '<span class="loading">加载中</span>');
    dom.window.setTimeout(() => {
      container.innerHTML = `
        <div class="fd-case-item"><div class="fd-header-ajmc">NEW ROW</div><div class="fd-header-ajlx">民事一审案件</div></div>`;
    }, 60);
  });

  const result = await switchQueryCategory(dom.window.document, "li", {
    afterTabClick: async () => undefined,
    timeoutMs: 300,
    intervalMs: 5,
    settleMs: 10,
  });

  assert.deepEqual(result, { ok: true });
  assert.match(dom.window.document.querySelector(".fd-com-list-container").textContent, /NEW ROW/);
});
