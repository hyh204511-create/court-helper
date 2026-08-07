// platform-evidence.js — 「我的案件」平台搜索结果的成功取证校验。
// 身份由发起完整 sourceCaseName 的平台搜索及其唯一结果确定；结果标题仍须 trim 后严格全等，禁止拆词、包含或正则匹配。
import { extractBusinessFields } from "../content/case-collectors.js";
import { recognizeStatus } from "../content/status-recognizer.js";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function expectedStatus(kind) {
  return kind === "qz" ? "强执成功" : "立案成功";
}

function rowMatchesKind(row, kind) {
  const execution = text(row?.caseType).includes("执行");
  return kind === "qz" ? execution : !execution;
}

function exactDate(value) {
  const candidate = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

/**
 * 验证一个“完整 sourceCaseName 已经交给平台搜索框”的结果集。
 * 仅接受平台返回的一条同类型成功案件，且其标题必须与 sourceCaseName trim 后严格全等。
 */
export function selectMyCaseEvidence({ record, kind = "li", rows = [] } = {}) {
  const expected = expectedStatus(kind);
  if (!record?.uid || record.status !== expected || !Array.isArray(rows)) {
    return { ok: false, error: "MYCASE_EVIDENCE_UNAVAILABLE" };
  }
  if (rows.length > 1) return { ok: false, error: "MYCASE_EVIDENCE_AMBIGUOUS" };
  const row = rows[0];
  if (!row || !rowMatchesKind(row, kind)) return { ok: false, error: "MYCASE_EVIDENCE_UNAVAILABLE" };
  if (!text(record.sourceCaseName) || text(row.caseName) !== text(record.sourceCaseName)) {
    return { ok: false, error: "MYCASE_EVIDENCE_UNAVAILABLE" };
  }
  if (recognizeStatus({
    statusText: row.statusText,
    caseType: row.caseType,
    pageKind: "mycase",
  }) !== expected) {
    return { ok: false, error: "MYCASE_EVIDENCE_UNAVAILABLE" };
  }
  const fields = extractBusinessFields(row.fields);
  const caseNumber = text(fields.caseNumber);
  const filedTime = exactDate(fields.filedDate);
  if (!caseNumber || !filedTime) return { ok: false, error: "MYCASE_EVIDENCE_UNAVAILABLE" };
  return { ok: true, value: { uid: record.uid, caseNumber, filedTime } };
}
