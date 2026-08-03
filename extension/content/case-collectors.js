// case-collectors.js — 案件列表/字段采集器（纯函数，DOM 元素或测试 stub 均可）
// 依据 docs/engineering/platform-recon-2026-08-03.md §5.1/5.4/5.6：
// - 列表行 .fd-case-item：状态 .fd-header-status / 名称 .fd-header-ajmc / 类型 .fd-header-ajlx
// - 字段行 .fd-field-item > (.fd-field-lable + .fd-field-value)：案号/立案日期/审核意见…
// - 关键选择器失效抛 SELECTOR_CHANGED（Task 3.7），禁止降级猜测。
import { CRITICAL_SELECTORS, SELECTORS } from "./selectors.js";

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
export function collectListRows(root, selectors = SELECTORS) {
  assertSelectors(root, selectors);
  const rowEls = root.querySelectorAll(selectors.list.row);
  return [...rowEls].map((rowEl) => collectRow(rowEl, selectors));
}

/** 采集单行 */
export function collectRow(rowEl, selectors = SELECTORS) {
  const q = (sel) => rowEl.querySelector(sel);
  return {
    statusText: q(selectors.list.status)?.innerText?.trim() ?? "",
    caseName: q(selectors.list.caseName)?.innerText?.trim() ?? "",
    caseType: q(selectors.list.caseType)?.innerText?.trim() ?? "",
    fields: collectFields(rowEl, selectors),
    hasSpaceBtn: !!q(selectors.list.spaceBtn),
  };
}

/** 采集字段行：label/value 对 */
export function collectFields(rowEl, selectors = SELECTORS) {
  const items = rowEl.querySelectorAll(selectors.list.fieldItem);
  return [...items]
    .map((item) => {
      const label = item.querySelector(selectors.list.fieldLabel)?.innerText?.trim() ?? "";
      const value = item.querySelector(selectors.list.fieldValue)?.innerText?.trim() ?? "";
      return { label, value };
    })
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
