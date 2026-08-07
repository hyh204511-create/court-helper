// status-recognizer.js — 状态识别器（纯函数）
// 依据 docs/engineering/platform-recon-2026-08-03.md §5.3/5.7：
// - 网上立案页（wsla）：状态字典 11800007 文本；
// - 我的案件页（mycase）：案件状态文本（审理中/已结案…）；
// - 未知文本一律 UNKNOWN，禁止猜测。
// 返回模板状态词：审核中 / 立案成功 / 已驳回 / 强执成功 / UNKNOWN。

// 网上立案页状态文本 → 模板状态词（不含需按案件类型区分的「已立案」）
const WSLA_STATIC = {
  待审核: "审核中",
  待补充材料: "已驳回",
  审核不通过: "已驳回",
  不予立案: "已驳回",
  待补正: "已驳回",
};

// 我的案件页状态文本 → 模板状态词（不含按类型区分的项）
const MYCASE_STATIC = {};

/** 案件类型是否为执行类（首次执行/执行类/恢复执行…） */
function isEnforcement(caseType = "") {
  return caseType.includes("执行");
}

/**
 * 识别平台状态文本 → 模板状态词。
 * @param {{statusText: string, caseType?: string, pageKind?: 'wsla'|'mycase'}} input
 * @returns {'审核中'|'立案成功'|'已驳回'|'强执成功'|'UNKNOWN'}
 */
export function recognizeStatus({ statusText = "", caseType = "", pageKind } = {}) {
  const t = String(statusText).trim();
  if (!t) return "UNKNOWN";

  if (pageKind === "wsla" || !pageKind) {
    // 网上立案页（默认）
    if (Object.hasOwn(WSLA_STATIC, t)) return WSLA_STATIC[t];
    if (t === "审核通过") return isEnforcement(caseType) ? "UNKNOWN" : "立案成功";
    if (t === "已立案") return isEnforcement(caseType) ? "强执成功" : "立案成功";
    return "UNKNOWN";
  }

  if (pageKind === "mycase") {
    // 我的案件页：案件状态
    if (t === "审理中") return "立案成功"; // 有案号+立案日期 = 已成功立案
    if (t === "已结案") return isEnforcement(caseType) ? "强执成功" : "立案成功";
    return "UNKNOWN";
  }

  return "UNKNOWN";
}
