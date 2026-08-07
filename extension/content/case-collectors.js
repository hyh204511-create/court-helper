// case-collectors.js — 案件列表/字段采集器（纯函数，DOM 元素或测试 stub 均可）
// 依据 docs/engineering/platform-recon-2026-08-03.md §5.1/5.4/5.6：
// - 列表行 .fd-case-item：状态 .fd-header-status / 名称 .fd-header-ajmc / 类型 .fd-header-ajlx
// - 字段行 .fd-field-item > (.fd-field-lable + .fd-field-value)：案号/立案日期/审核意见…
// - 关键选择器失效抛 SELECTOR_CHANGED（Task 3.7），禁止降级猜测。
import { CRITICAL_SELECTORS, SELECTORS } from "./selectors.js";

/** 元素文本：textContent 优先（jsdom 兼容），innerText 兜底（真实浏览器布局文本） */
const textOf = (el) => (el?.textContent ?? el?.innerText ?? "").toString().trim();

export class SelectorChangedError extends Error {
  constructor(selectorKey) {
    super(`SELECTOR_CHANGED: ${selectorKey}`);
    this.name = "SelectorChangedError";
    this.code = "SELECTOR_CHANGED";
    this.selectorKey = selectorKey;
  }
}

function resolveSelector(selectors, key) {
  const parts = key.split(".");
  let cur = selectors;
  for (const p of parts) cur = cur?.[p];
  return cur;
}

/** 探测关键选择器；失效抛 SELECTOR_CHANGED。
 * root 级：必须能定位行（list.row）；行级：取第一行探测行内关键选择器。
 * 空列表页（无行）合法，不报错。 */
export function assertSelectors(root, selectors = SELECTORS, keys = CRITICAL_SELECTORS) {
  for (const key of keys) {
    if (!resolveSelector(selectors, key)) throw new SelectorChangedError(key);
  }
  if (!root || typeof root.querySelectorAll !== "function") {
    throw new SelectorChangedError("list.row");
  }
  const rowSel = selectors.list.row;
  const rowEl = typeof root.querySelectorAll === "function"
    ? root.querySelectorAll(rowSel)[0] ?? null
    : null;
  if (!rowEl) return; // 空列表合法
  for (const key of ["list.status", "list.caseName", "list.fieldItem"]) {
    const sel = resolveSelector(selectors, key);
    if (typeof rowEl.querySelector !== "function" || rowEl.querySelector(sel) == null) {
      throw new SelectorChangedError(key);
    }
  }
}

/** 采集列表行数组（每行结构化） */
export function collectListRowEntries(root, selectors = SELECTORS) {
  assertSelectors(root, selectors);
  const rowEls = root.querySelectorAll(selectors.list.row);
  return [...rowEls].map((element) => ({
    data: collectRow(element, selectors),
    element,
  }));
}

/** 采集列表行数组（纯结构化数据，不携带 DOM 节点）。 */
export function collectListRows(root, selectors = SELECTORS) {
  return collectListRowEntries(root, selectors).map((entry) => entry.data);
}

/** 采集单行 */
export function collectRow(rowEl, selectors = SELECTORS) {
  const q = (sel) => rowEl.querySelector(sel);
  return {
    statusText: textOf(q(selectors.list.status)),
    caseName: textOf(q(selectors.list.caseName)),
    caseType: textOf(q(selectors.list.caseType)),
    fields: collectFields(rowEl, selectors),
    hasSpaceBtn: !!q(selectors.list.spaceBtn),
  };
}

/** 采集字段行：label/value 对 */
export function collectFields(rowEl, selectors = SELECTORS) {
  const items = rowEl.querySelectorAll(selectors.list.fieldItem);
  return [...items]
    .map((item) => ({
      label: textOf(item.querySelector(selectors.list.fieldLabel)),
      value: textOf(item.querySelector(selectors.list.fieldValue)),
    }))
    .filter((f) => f.label);
}

/** 按 label 取字段值；不存在返回 null */
export function findField(fields, label) {
  return fields.find((f) => f.label === label)?.value ?? null;
}

/** 从字段数组提取常用业务字段（立案/强执共用） */
export function extractBusinessFields(fields) {
  return {
    caseNumber: findField(fields, "案号"),
    filedDate: findField(fields, "立案日期"),
    court: findField(fields, "法院"),
    auditOpinion: findField(fields, "审核意见"),
    applyDate: findField(fields, "申请日期"),
  };
}

/**
 * 采集详情页（案件空间 pagesWsla/common/wsla/detail）。
 * 表单项 .uni-forms-item 的 innerText 为「label\nvalue」结构（实测）；
 * 「审核结果」+「审核时间」+「审核意见」构成同一审核记录（最新在前）。
 * @returns {{auditRecords: Array<{status: string, time?: string, opinion?: string}>, fields: Record<string,string>, opinion: string|null}}
 */
export function collectDetail(root, selectors = SELECTORS) {
  const items = root.querySelectorAll(selectors.detail.formItem);
  const fields = {};
  const auditRecords = [];
  let current = null;
  for (const item of items) {
    // 优先子元素对（label/value 结构，jsdom 兼容）；否则按 innerText/textContent 行拆分
    const kids = [...(item.children ?? [])].filter((c) => textOf(c));
    let label = "";
    let value = "";
    if (kids.length >= 2) {
      label = textOf(kids[0]);
      value = textOf(kids[kids.length - 1]);
    } else {
      const text = String(item.innerText ?? item.textContent ?? "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!text.length) continue;
      const [first, ...rest] = text;
      label = first;
      value = rest.join(" ");
    }
    if (!label) continue;
    if (label === "审核结果") {
      current = { status: value };
      auditRecords.push(current);
    } else if (label === "审核时间" && current) {
      current.time = value;
    } else if (label === "审核意见") {
      if (current) current.opinion = value;
      if (fields[label] === undefined) fields[label] = value;
    } else {
      fields[label] = value;
    }
  }
  return {
    auditRecords,
    fields,
    opinion: auditRecords[0]?.opinion ?? null,
  };
}
