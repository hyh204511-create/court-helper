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
  if (element.getAttribute?.("aria-disabled") === "true") return false;
  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  return style?.display !== "none" && style?.visibility !== "hidden" && style?.pointerEvents !== "none";
}

function trackListMutations(root) {
  const container = root.querySelector(SELECTORS.list.container);
  const MutationObserverImpl = root.defaultView?.MutationObserver ?? root.ownerDocument?.defaultView?.MutationObserver;
  let lastMutationAt = null;
  if (!container || typeof MutationObserverImpl !== "function") {
    return { container, lastMutationAt: () => lastMutationAt, disconnect() {} };
  }
  const observer = new MutationObserverImpl(() => { lastMutationAt = Date.now(); });
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  return { container, lastMutationAt: () => lastMutationAt, disconnect: () => observer.disconnect() };
}

async function defaultWaitForList(root, kind, tracker, { timeoutMs = 10_000, intervalMs = 100, settleMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const rows = [...root.querySelectorAll(SELECTORS.list.row)];
    const isExpected = rows.length > 0 && rows.every((row) => {
      const type = String(row.querySelector(SELECTORS.list.caseType)?.textContent ?? "").trim();
      return kind === "qz" ? type.includes("执行") : !type.includes("执行");
    });
    const changedAt = tracker.lastMutationAt();
    const changedAndSettled = changedAt !== null && Date.now() - changedAt >= settleMs;
    const isConfirmedEmpty = changedAndSettled
      && tracker.container
      && String(tracker.container.textContent ?? "").includes("暂无数据");
    if ((changedAndSettled && isExpected) || isConfirmedEmpty) return true;
    await sleep(intervalMs);
  }
  return false;
}

export function isQueryControlsReady(root) {
  const containers = [...root.querySelectorAll(SELECTORS.list.tab)];
  const buttons = [...root.querySelectorAll(SELECTORS.list.searchBtn)];
  if (containers.length !== 1 || buttons.length !== 1 || !isUsable(buttons[0])) return false;
  return Object.values(LABELS).every((label) => (
    exactLeafMatches(containers[0], label).filter(isUsable).length === 1
  ));
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
  const afterTabClick = options.afterTabClick ?? (() => sleep(50));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    matches[0].click();
    await afterTabClick(kind);
    const tracker = trackListMutations(root);
    try {
      buttons[0].click();
      const ready = options.waitForList
        ? await options.waitForList(kind)
        : await defaultWaitForList(root, kind, tracker, options);
      if (ready) return { ok: true };
    } finally {
      tracker.disconnect();
    }
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
