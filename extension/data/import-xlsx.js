// import-xlsx.js — 模板导入解析（ExcelJS）
// 依据 docs/specs/excel-module.md §3：
// - 表头 12 列逐列比对；强执表头按内容识别（A=原告 且 E=强执状态）；
// - A/C 必填；状态必须在枚举内，空 → UNKNOWN；
// - H/K 图片列（含 DISPIMG 公式）一律跳过，不读图。
import ExcelJS from "exceljs";

import { HEADER_LI, HEADER_QZ } from "./xlsx-io.js";

const STATUS_LI = ["立案成功", "已驳回", "审核中"];
const STATUS_QZ = ["强执成功", "已驳回", "审核中"];

function cellStr(ws, row, col) {
  const v = ws.getCell(row, col).value;
  return v == null ? "" : String(v).trim();
}

/** 日期 → 'YYYY-MM-DD'；Date/字符串容错；解析失败返回 null */
export function toDateStr(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
}

function checkHeader(ws, row, expected) {
  for (let c = 0; c < expected.length; c++) {
    if (cellStr(ws, row, c + 1) !== expected[c]) return false;
  }
  return true;
}

/** 强执表头行 = 首个「A=原告 且 E=强执状态」的行 */
export function findQzHeaderRow(ws) {
  for (let r = 2; r <= ws.rowCount; r++) {
    if (cellStr(ws, r, 1) === "原告" && cellStr(ws, r, 5) === "强执状态") return r;
  }
  return null;
}

function parseRows(ws, startRow, endRow, kind) {
  const statusSet = kind === "li" ? STATUS_LI : STATUS_QZ;
  const rows = [];
  const reasons = [];
  for (let r = startRow; r <= endRow; r++) {
    const a = cellStr(ws, r, 1);
    const b = cellStr(ws, r, 2);
    const c = cellStr(ws, r, 3);
    const d = cellStr(ws, r, 4);
    if (!a && !c) continue; // 整行空 → 跳过
    if (!a || !c) {
      reasons.push(`第${r}行缺少必填列（原告/账号）`);
      continue;
    }
    const statusText = cellStr(ws, r, 5);
    let status;
    if (!statusText) status = "UNKNOWN";
    else if (statusSet.includes(statusText)) status = statusText;
    else {
      reasons.push(`第${r}行状态无效: ${statusText}`);
      continue;
    }
    rows.push({
      account: c,
      password: d,
      plaintiff: a,
      defendant: b,
      status,
      filedTime: toDateStr(ws.getCell(r, 6).value),
      caseNumber: cellStr(ws, r, 7) || null,
      successImage: null, // H 列图片跳过（含 DISPIMG）
      rejectTime: toDateStr(ws.getCell(r, 9).value),
      rejectReason: cellStr(ws, r, 10) || null,
      rejectImage: null, // K 列图片跳过
      queryTime: toDateStr(ws.getCell(r, 12).value),
    });
  }
  return { rows, reasons };
}

/**
 * 解析模板 xlsx（Buffer 或 ArrayBuffer）。
 * @returns {Promise<{liRows: object[], qzRows: object[], skipped: number, reasons: string[]}>}
 */
export async function importXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet("Sheet1") || wb.worksheets[0];
  if (!ws) throw new Error("模板不匹配：未找到工作表 Sheet1");
  if (!checkHeader(ws, 1, HEADER_LI)) throw new Error("模板不匹配：第 1 行表头与立案表不一致");
  const qzHeaderRow = findQzHeaderRow(ws);
  if (!qzHeaderRow) throw new Error("模板不匹配：未找到强执表头行（A=原告 且 E=强执状态）");
  if (!checkHeader(ws, qzHeaderRow, HEADER_QZ)) throw new Error("模板不匹配：强执表头与模板不一致");

  const li = parseRows(ws, 2, qzHeaderRow - 1, "li");
  const qz = parseRows(ws, qzHeaderRow + 1, ws.rowCount, "qz");
  return {
    liRows: li.rows,
    qzRows: qz.rows,
    skipped: li.reasons.length + qz.reasons.length,
    reasons: [...li.reasons, ...qz.reasons],
  };
}
