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
  if (!text(record.sourceCaseName)) {
    return { ok: false, error: "MYCASE_EVIDENCE_UNAVAILABLE" };
  }
  const candidates = rows
    .filter((row) => rowMatchesKind(row, kind))
    .filter((row) => text(row.caseName) === text(record.sourceCaseName))
    .map((row) => {
      const fields = extractBusinessFields(row.fields);
      return { row, caseNumber: text(fields.caseNumber), filedTime: exactDate(fields.filedDate) };
    });
  if (!candidates.length || candidates.some((candidate) => !candidate.filedTime)) {
    return { ok: false, error: "MYCASE_EVIDENCE_UNAVAILABLE" };
  }
  const latestDate = candidates.reduce(
    (latest, candidate) => candidate.filedTime > latest ? candidate.filedTime : latest,
    candidates[0].filedTime,
  );
  const latest = candidates.filter((candidate) => candidate.filedTime === latestDate);
  if (latest.length !== 1) return { ok: false, error: "MYCASE_EVIDENCE_AMBIGUOUS" };
  const [{ row, caseNumber, filedTime }] = latest;
  if (recognizeStatus({
    statusText: row.statusText,
    caseType: row.caseType,
    pageKind: "mycase",
  }) !== expected) {
    return { ok: false, error: "MYCASE_EVIDENCE_UNAVAILABLE" };
  }
  if (!caseNumber || !filedTime) return { ok: false, error: "MYCASE_EVIDENCE_UNAVAILABLE" };
  return { ok: true, value: { uid: record.uid, caseNumber, filedTime } };
}

function apiDay(value) {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/.exec(text(value));
  return match?.[1] ?? null;
}

function titleHasExactParties(title, cause, plaintiff, defendant) {
  if (title === `${plaintiff}${defendant}${cause}`) return true;
  const suffix = `${cause}一案`;
  if (!title.endsWith(suffix)) return false;
  const partyTokens = title.slice(0, -suffix.length)
    .split(/与|诉|,|，|、/)
    .map((value) => value.trim())
    .filter(Boolean);
  return partyTokens.includes(plaintiff) && partyTokens.includes(defendant);
}

function unavailableCause(value) {
  const valueText = text(value);
  return !valueText || valueText === "暂无";
}

function stableEvidenceError(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null;
}

export function evidenceFailureCode({ selection, updated } = {}) {
  if (selection?.ok === true && updated?.needsHuman !== true) return null;
  if (selection?.ok !== true) {
    return stableEvidenceError(selection?.error)
      ?? stableEvidenceError(updated?.errorCode)
      ?? stableEvidenceError(updated?.error)
      ?? "MYCASE_EVIDENCE_UNAVAILABLE";
  }
  return stableEvidenceError(updated?.errorCode)
    ?? stableEvidenceError(updated?.error)
    ?? "MYCASE_EVIDENCE_UNAVAILABLE";
}

export function preferEvidenceError(current, candidate) {
  const currentCode = stableEvidenceError(current);
  const candidateCode = stableEvidenceError(candidate);
  if (!currentCode) return candidateCode ?? "MYCASE_EVIDENCE_UNAVAILABLE";
  if (currentCode === "MYCASE_EVIDENCE_UNAVAILABLE"
    && candidateCode && candidateCode !== "MYCASE_EVIDENCE_UNAVAILABLE") return candidateCode;
  return currentCode;
}

export function selectSourceApiRow(record, rows = []) {
  let candidates = Array.isArray(rows) ? rows : [];
  const stages = [
    ["caseName", text(record?.sourceCaseName), "SOURCE_CASE_NAME_MISMATCH"],
    ["applicant", text(record?.plaintiff), "SOURCE_APPLICANT_MISMATCH"],
    ["respondent", text(record?.defendant), "SOURCE_RESPONDENT_MISMATCH"],
    ["cause", text(record?.sourceCause), "SOURCE_CAUSE_MISMATCH"],
    ["applicationDate", text(record?.sourceApplicationDate), "SOURCE_APPLICATION_DATE_MISMATCH"],
  ];
  for (const [field, expected, error] of stages) {
    candidates = candidates.filter((row) => text(row?.[field]) === expected);
    if (!candidates.length) return { ok: false, error };
  }
  if (candidates.length !== 1) return { ok: false, error: "SOURCE_API_ROW_AMBIGUOUS" };
  return { ok: true, row: candidates[0] };
}

/**
 * 直接校验 ajlist 结构化补证。两个接口没有案件级共享 ID，必须由全部
 * 已确认结构键共同形成唯一候选；标题只按分隔后的完整当事人 token 校验。
 */
export function selectMyCaseApiEvidence({ record, sourceApiRow, rows = [], kind = "li" } = {}) {
  if (!record || typeof record !== "object") return { ok: false, error: "MYCASE_RECORD_MISSING" };
  if (!record.uid) return { ok: false, error: "MYCASE_RECORD_UID_MISSING" };
  if (record.status !== expectedStatus(kind)) return { ok: false, error: "MYCASE_STATUS_MISMATCH" };
  if (!sourceApiRow || typeof sourceApiRow !== "object") return { ok: false, error: "SOURCE_API_ROW_MISSING" };
  if (!Array.isArray(rows)) return { ok: false, error: "MYCASE_ROWS_INVALID" };
  const plaintiff = text(record.plaintiff);
  const defendant = text(record.defendant);
  const cause = text(record.sourceCause);
  const sourceAccount = text(sourceApiRow.sfBh);
  const sourceCourt = text(sourceApiRow.fymc);
  const sourceType = text(sourceApiRow.ajlx);
  const sourceCause = text(sourceApiRow.cause) || text(sourceApiRow.laay);
  const causeUnavailable = kind === "qz" && unavailableCause(cause) && unavailableCause(sourceCause);
  if (!plaintiff) return { ok: false, error: "SOURCE_PLAINTIFF_MISSING" };
  if (!defendant) return { ok: false, error: "SOURCE_DEFENDANT_MISSING" };
  if (!cause && !causeUnavailable) return { ok: false, error: "SOURCE_CAUSE_MISSING" };
  if (!causeUnavailable && cause !== sourceCause) return { ok: false, error: "SOURCE_CAUSE_MISMATCH" };
  if (!sourceAccount) return { ok: false, error: "SOURCE_ACCOUNT_MISSING" };
  if (!sourceCourt) return { ok: false, error: "SOURCE_COURT_MISSING" };
  if (!sourceType) return { ok: false, error: "SOURCE_TYPE_MISSING" };

  const stages = [
    [(row) => text(row?.csfid) === sourceAccount, "MYCASE_ACCOUNT_MISMATCH"],
    [(row) => text(row?.cfydmTranslateText) === sourceCourt, "MYCASE_COURT_MISMATCH"],
    [(row) => text(row?.cywlx) === sourceType, "MYCASE_TYPE_MISMATCH"],
  ];
  if (!causeUnavailable) stages.push([(row) => text(row?.claay) === sourceCause, "MYCASE_CAUSE_MISMATCH"]);
  // layy.updateTime 是来源记录更新时间，不等同于 ajlist.clarq 的成功日期；
  // 不用它否决唯一候选，最终成功时间始终只取 ajlist.clarq。
  stages.push(
    [
      (row) => causeUnavailable
        ? text(row?.cajmc) === text(record.sourceCaseName)
        : titleHasExactParties(text(row?.cajmc), sourceCause, plaintiff, defendant),
      "MYCASE_PARTIES_TITLE_MISMATCH",
    ],
  );
  let candidates = rows;
  for (const [matches, error] of stages) {
    candidates = candidates.filter(matches);
    if (!candidates.length) return { ok: false, error };
  }
  if (candidates.length !== 1) return { ok: false, error: "MYCASE_EVIDENCE_AMBIGUOUS" };
  const caseNumber = text(candidates[0].cah);
  const filedTime = apiDay(candidates[0].clarq);
  if (!caseNumber) return { ok: false, error: "MYCASE_CASE_NUMBER_MISSING" };
  if (!filedTime) return { ok: false, error: "MYCASE_FILED_DATE_INVALID" };
  return { ok: true, value: { uid: record.uid, caseNumber, filedTime } };
}
