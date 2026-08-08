// xlsx-io.js — Excel 导出核心（ExcelJS）
// 依据 docs/specs/excel-module.md：
// - 新版 20 列合并表头（新导出唯一权威）；
// - 样式复刻：表头加粗 11 + FF92D050 填充 + 行高 27；数据行高 28；列宽表；日期 mm-dd-yy；
// - UNKNOWN 状态：单元格留空 + 浅红填充 + 深红字体（待人工提示）；
// - 图片 OneCellAnchor 锚定 H/K/P/S 列单元格。
import ExcelJS from "exceljs";

// 模板 12 列表头（唯一权威，勿改）
export const HEADER_LI = [
  "原告", "被告", "账号", "密码", "立案状态", "立案成功时间", "案号",
  "成功图片", "驳回时间", "驳回原因", "驳回图片", "查询时间",
];
export const HEADER_QZ = [
  "原告", "被告", "账号", "密码", "强执状态", "强执成功时间", "强执案号",
  "成功图片", "驳回时间", "驳回原因", "驳回图片", "查询时间",
];
export const HEADER_COMBINED = [
  ...HEADER_LI.slice(0, 11), "立案查询时间",
  "强执状态", "强执成功时间", "强执案号", "成功图片",
  "驳回时间", "驳回原因", "驳回图片", "强执查询时间",
];

export const STYLE = {
  header: {
    font: { name: "宋体", bold: true, size: 11 },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF92D050" } },
    border: {
      top: { style: "thin" }, right: { style: "thin" },
      bottom: { style: "thin" }, left: { style: "thin" },
    },
    alignment: { horizontal: "center", vertical: "middle" },
    height: 27,
  },
  data: {
    font: { name: "宋体", size: 11 },
    border: {
      top: { style: "thin" }, right: { style: "thin" },
      bottom: { style: "thin" }, left: { style: "thin" },
    },
    alignment: { vertical: "middle" },
    wrapAlignment: { vertical: "middle", wrapText: true },
    height: 28,
  },
  colWidths: {
    A: 15, B: 14, C: 20.37, D: 15.5, F: 13.25,
    G: 24.13, H: 12.87, I: 12.87, J: 39.63, K: 18, L: 10.75,
    N: 12.13, Q: 12.87, T: 12.78,
  },
  dateFormat: "mm-dd-yy",
  unknown: {
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } },
    font: { color: { argb: "FF9C0006" } },
  },
  image: {
    liSuccess: { col: 7, width: 60 },
    liReject: { col: 10, width: 90 },
    qzSuccess: { col: 15, width: 60 },
    qzReject: { col: 18, width: 90 },
    height: 34,
  },
};

function writeHeader(ws, row, headers) {
  for (let c = 0; c < headers.length; c++) {
    const cell = ws.getCell(row, c + 1);
    cell.value = headers[c];
    cell.font = STYLE.header.font;
    cell.fill = STYLE.header.fill;
    cell.border = STYLE.header.border;
    cell.alignment = STYLE.header.alignment;
  }
  ws.getRow(row).height = STYLE.header.height;
}

function formatDataRow(ws, row) {
  for (let col = 1; col <= HEADER_COMBINED.length; col += 1) {
    const cell = ws.getCell(row, col);
    cell.font = STYLE.data.font;
    cell.border = STYLE.data.border;
    cell.alignment = [10, 18].includes(col) ? STYLE.data.wrapAlignment : STYLE.data.alignment;
    if ([6, 9, 12, 14, 17, 20].includes(col)) cell.numFmt = STYLE.dateFormat;
  }
  ws.getRow(row).height = STYLE.data.height;
}

/** 'YYYY-MM-DD' → Date（UTC 午夜，避免 ExcelJS 序列化后日期漂移一天）；空 → null */
function dateToCell(v) {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}

function writeResult(ws, row, rec, statusColumn, imageJobs, imageStyle) {
  if (!rec) return;
  const statusCell = ws.getCell(row, statusColumn);
  if (rec.status === "UNKNOWN") {
    statusCell.value = "";
    statusCell.fill = STYLE.unknown.fill;
    statusCell.font = { ...STYLE.data.font, ...STYLE.unknown.font };
  } else {
    statusCell.value = rec.status ?? "";
  }

  ws.getCell(row, statusColumn + 1).value = dateToCell(rec.filedTime);
  ws.getCell(row, statusColumn + 2).value = rec.caseNumber ?? "";
  ws.getCell(row, statusColumn + 4).value = dateToCell(rec.rejectTime);
  ws.getCell(row, statusColumn + 5).value = rec.rejectReason ?? "";
  ws.getCell(row, statusColumn + 7).value = dateToCell(rec.queryTime);

  if (rec.successImage) {
    imageJobs.push({ blob: rec.successImage, ...imageStyle.success, row: row - 1 });
  }
  if (rec.rejectImage) {
    imageJobs.push({ blob: rec.rejectImage, ...imageStyle.reject, row: row - 1 });
  }
}

function recordKey(rec) {
  return [rec?.account, rec?.plaintiff, rec?.defendant].map((value) => String(value ?? "").trim()).join("\u0000");
}

function combinedRows(cases, enforcementCases) {
  const pendingQz = new Map();
  for (const rec of enforcementCases) {
    const key = recordKey(rec);
    const values = pendingQz.get(key) ?? [];
    values.push(rec);
    pendingQz.set(key, values);
  }
  const rows = cases.map((li) => {
    const matches = pendingQz.get(recordKey(li));
    const qz = matches?.shift() ?? null;
    return { li, qz };
  });
  for (const matches of pendingQz.values()) {
    for (const qz of matches) rows.push({ li: null, qz });
  }
  return rows;
}

function writeCombinedRow(ws, row, pair, imageJobs) {
  formatDataRow(ws, row);
  const identity = pair.li ?? pair.qz ?? {};
  ws.getCell(row, 1).value = identity.plaintiff ?? "";
  ws.getCell(row, 2).value = identity.defendant ?? "";
  ws.getCell(row, 3).value = identity.account ?? "";
  ws.getCell(row, 4).value = identity.password ?? "";
  writeResult(ws, row, pair.li, 5, imageJobs, {
    success: STYLE.image.liSuccess, reject: STYLE.image.liReject,
  });
  writeResult(ws, row, pair.qz, 13, imageJobs, {
    success: STYLE.image.qzSuccess, reject: STYLE.image.qzReject,
  });
}

/**
 * 构建完整导出工作簿（20 列合并布局 + 样式复刻 + 图片嵌入）。
 * @param {{cases?: object[], enforcementCases?: object[]}} [data] db 记录（含 Blob 图片）
 * @returns {Promise<ExcelJS.Workbook>}
 */
export async function buildExportWorkbook({ cases = [], enforcementCases = [] } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const [letter, width] of Object.entries(STYLE.colWidths)) {
    ws.getColumn(letter).width = width;
  }

  writeHeader(ws, 1, HEADER_COMBINED);
  const imageJobs = [];
  let row = 2;
  for (const pair of combinedRows(cases, enforcementCases)) {
    writeCombinedRow(ws, row, pair, imageJobs);
    row += 1;
  }
  const reservedEnd = Math.max(row - 1, 11);
  for (let reservedRow = row; reservedRow <= reservedEnd; reservedRow += 1) {
    formatDataRow(ws, reservedRow);
  }

  for (const job of imageJobs) {
    const buffer = new Uint8Array(await job.blob.arrayBuffer());
    const extension = (job.blob.type || "").includes("png") ? "png" : "jpeg";
    const imageId = wb.addImage({ buffer, extension });
    ws.addImage(imageId, {
      tl: { col: job.col, row: job.row },
      ext: { width: job.width, height: STYLE.image.height },
    });
  }
  return wb;
}

/**
 * 通用导出工作簿（Sheet1）。
 * @param {string} filePath 输出路径
 * @param {object} opts
 * @param {string[]} opts.header 表头（12 列）
 * @param {Array<Array<*>>} opts.rows 数据行
 * @param {Array<{col:number, row:number, buffer:Buffer, width:number, height:number}>} opts.images
 *   col/row 为 0 基单元格坐标（H2 = {col:7, row:1}）
 */
export async function exportWorkbook(filePath, { header, rows = [], images = [] }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(header);
  for (const row of rows) ws.addRow(row);
  for (const img of images) {
    const imageId = wb.addImage({ buffer: img.buffer, extension: "png" });
    ws.addImage(imageId, {
      tl: { col: img.col, row: img.row },
      ext: { width: img.width, height: img.height },
    });
  }
  await wb.xlsx.writeFile(filePath);
  return wb;
}
