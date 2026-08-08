import { SELECTORS } from "./selectors.js";

const LABELS = { li: "审判", qz: "执行" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function exactLeafMatches(container, label) {
  return [...container.querySelectorAll("*")].filter((element) => {
    if (String(element.textContent ?? "").trim() !== label) return false;
    return ![...element.children].some((child) => String(child.textContent ?? "").trim() === label);
  });
}

function isUsable(element) {
  if (!element || element.hidden || element.getAttribute?.("aria-hidden") === "true") return false;
  if (element.matches?.(":disabled")) return false;
  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  return style?.display !== "none" && style?.visibility !== "hidden";
}

async function defaultWaitForList(root, kind, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const container = root.querySelector(SELECTORS.list.container);
    const rows = [...root.querySelectorAll(SELECTORS.list.row)];
    const isExpected = rows.length > 0 && rows.every((row) => {
      const type = String(row.querySelector(SELECTORS.list.caseType)?.textContent ?? "").trim();
      return kind === "qz" ? type.includes("执行") : !type.includes("执行");
    });
    if (isExpected || (container && String(container.textContent ?? "").includes("暂无数据"))) return true;
    await sleep(intervalMs);
  }
  return false;
}

export async function switchQueryCategory(root, kind, options = {}) {
  const label = LABELS[kind];
  if (!label) return { ok: false, error: "SELECTOR_CHANGED" };
  const containers = [...root.querySelectorAll(SELECTORS.list.tab)];
  const buttons = [...root.querySelectorAll(SELECTORS.list.searchBtn)];
  if (containers.length !== 1 || buttons.length !== 1 || !isUsable(buttons[0])) {
    return { ok: false, error: "SELECTOR_CHANGED" };
  }
  const matches = exactLeafMatches(containers[0], label).filter(isUsable);
  if (matches.length !== 1) return { ok: false, error: "SELECTOR_CHANGED" };
  const waitForList = options.waitForList ?? ((selectedKind) => defaultWaitForList(root, selectedKind, options));
  const afterTabClick = options.afterTabClick ?? (() => sleep(50));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    matches[0].click();
    await afterTabClick(kind);
    buttons[0].click();
    if (await waitForList(kind)) return { ok: true };
  }
  return { ok: false, error: "QUERY_TAB_TIMEOUT" };
}

function softManualResult(result) {
  return result?.ok === false && (
    Number(result?.stats?.needsHuman ?? 0) > 0
    || Number(result?.evidence?.needsHuman ?? 0) > 0
  );
}

export async function runQueryAllExport({ switchCategory, queryKind, exportReport }) {
  let needsHuman = false;
  for (const kind of ["li", "qz"]) {
    const switched = await switchCategory(kind);
    if (!switched?.ok) return { ok: false, error: switched?.error ?? "SELECTOR_CHANGED" };
    const queried = await queryKind(kind);
    if (!queried?.ok) {
      if (!softManualResult(queried)) return { ok: false, error: queried?.error ?? "NEEDS_HUMAN" };
      needsHuman = true;
    }
  }
  const exported = await exportReport();
  return { ...exported, needsHuman };
}
