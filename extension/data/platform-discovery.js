// platform-discovery.js — 空白模板时从真实平台列表建立案件记录。
// 仅接受已确认的“参与人”结构；当事人不从案件标题推测。
import { findField } from "../content/case-collectors.js";
import { BATCH_LIMIT } from "./batch-runner.js";

function discoveryError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function nonEmptyText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 解析平台“参与人”字段。立案为 原告/被告，强执为 申请执行人/被执行人。
 * 仅接收精确中文标签和分隔符，避免根据案件标题或模糊文本猜测主体。
 */
export function parseParticipantField(value, kind = "li") {
  const plaintiffLabel = kind === "qz" ? "申请执行人" : "原告";
  const defendantLabel = kind === "qz" ? "被执行人" : "被告";
  const text = nonEmptyText(value);
  const prefix = `${plaintiffLabel}：`;
  const separator = `；${defendantLabel}：`;
  if (!text.startsWith(prefix)) throw discoveryError("PARTY_FIELDS_UNAVAILABLE");
  const remainder = text.slice(prefix.length);
  const separatorAt = remainder.indexOf(separator);
  if (separatorAt < 1 || remainder.indexOf(separator, separatorAt + separator.length) !== -1) {
    throw discoveryError("PARTY_FIELDS_UNAVAILABLE");
  }
  const plaintiff = remainder.slice(0, separatorAt).trim();
  const defendant = remainder.slice(separatorAt + separator.length).trim();
  if (!plaintiff || !defendant) throw discoveryError("PARTY_FIELDS_UNAVAILABLE");
  return { plaintiff, defendant };
}

function exactIsoDate(value) {
  const text = nonEmptyText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/**
 * 将当前可见平台行转换为待采集的本地记录，并按当事人+案由选择最新申请日。
 * 这里只建档；状态、截图、驳回详情与成功时间/案号仍由批量采集器读取页面后写入。
 */
export function buildPlatformDiscoveryRecords({ account, platformAccountId = null, kind = "li", rows = [] } = {}) {
  const normalizedAccount = nonEmptyText(account);
  if (!normalizedAccount) throw discoveryError("ACCOUNT_UNDETECTED");
  if (!Array.isArray(rows)) throw discoveryError("LIST_DATA_UNAVAILABLE");
  if (rows.length > BATCH_LIMIT) throw discoveryError("BATCH_LIMIT_EXCEEDED");

  const selected = new Map();
  for (const row of rows) {
    const fields = Array.isArray(row?.fields) ? row.fields : [];
    const participants = parseParticipantField(findField(fields, "参与人"), kind);
    const caseName = nonEmptyText(row?.caseName);
    if (!caseName) throw discoveryError("CASE_IDENTITY_UNAVAILABLE");
    const cause = nonEmptyText(findField(fields, "案由"));
    const applicationDate = exactIsoDate(findField(fields, "申请日期"));
    const key = `${participants.plaintiff}\u0000${participants.defendant}\u0000${cause}`;
    const previous = selected.get(key);
    if (!previous) {
      selected.set(key, { row, participants, applicationDate });
      continue;
    }
    if (!previous.applicationDate || !applicationDate) throw discoveryError("AMBIGUOUS_LATEST_CASE");
    if (applicationDate === previous.applicationDate) throw discoveryError("AMBIGUOUS_LATEST_CASE");
    if (applicationDate > previous.applicationDate) {
      selected.set(key, { row, participants, applicationDate });
    }
  }

  return [...selected.values()].map(({ row, participants, applicationDate }) => ({
    account: normalizedAccount,
    platformAccountId: typeof platformAccountId === "string" && platformAccountId ? platformAccountId : null,
    plaintiff: participants.plaintiff,
    defendant: participants.defendant,
    sourceCaseName: nonEmptyText(row.caseName),
    sourceCause: nonEmptyText(findField(row.fields, "案由")),
    sourceApplicationDate: applicationDate,
    status: "UNKNOWN",
    filedTime: null,
    caseNumber: null,
    rejectTime: null,
    rejectReason: null,
    queryTime: null,
  }));
}

/**
 * 将已按三元组去重建档的记录精确回绑到当前列表行。
 * 同标题历史记录不能仅凭标题判歧义；必须复核原告/被告/案由及已选申请日期。
 */
export function selectDiscoveredListRow({ record, kind = "li", rows = [] } = {}) {
  if (!record || !Array.isArray(rows)) return { ok: false, error: "CASE_NOT_FOUND_IN_LIST" };
  const matches = [];
  rows.forEach((row, index) => {
    try {
      const participants = parseParticipantField(findField(row?.fields ?? [], "参与人"), kind);
      const cause = nonEmptyText(findField(row?.fields ?? [], "案由"));
      if (participants.plaintiff !== nonEmptyText(record.plaintiff)
        || participants.defendant !== nonEmptyText(record.defendant)
        || cause !== nonEmptyText(record.sourceCause)) return;
      const applicationDate = exactIsoDate(findField(row?.fields ?? [], "申请日期"));
      if (record.sourceApplicationDate && applicationDate !== record.sourceApplicationDate) return;
      matches.push(index);
    } catch {
      // 无法精确解析的行不是候选；若没有任何候选，统一返回稳定的未找到错误。
    }
  });
  if (!matches.length) return { ok: false, error: "CASE_NOT_FOUND_IN_LIST" };
  if (matches.length !== 1) return { ok: false, error: "CASE_MATCH_AMBIGUOUS" };
  return { ok: true, index: matches[0] };
}
