// xlsx-io.js — Excel 导出核心（ExcelJS）
// 依据 docs/specs/excel-module.md：
// - 模板 12 列表头常量（唯一权威）；
// - 双表块动态布局：立案表头第 1 行，强执表头 = 立案末行 + 5；
// - 样式复刻：表头加粗 11 + FF92D050 填充 + 行高 27；数据行高 28；列宽表；日期 mm-dd-yy；
// - UNKNOWN 状态：单元格留空 + 浅红填充 + 深红字体（待人工提示）；
// - 图片 OneCellAnchor 锚定 H/K 列单元格。
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

export const STYLE = {
  header: {
    font: { bold: true, size: 11 },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF92D050" } },
    height: 27,
  },
  dataRowHeight: 28,
  colWidths: {
    A: 15, B: 14, C: 20.37, D: 15.5, E: 12, F: 13.25,
    G: 24.13, H: 12.87, I: 12, J: 39.63, K: 18, L: 10.75,
  },
  dateFormat: "mm-dd-yy",
  unknown: {
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } },
    font: { color: { argb: "FF9C0006" } },
  },
  image: {
    success: { col: 7, width: 60 }, // H 列（0 基）
    reject: { col: 10, width: 90 }, // K 列（0 基）
    height: 34,
  },
};

function writeHeader(ws, row, headers) {
  for (let c = 0; c < headers.length; c++) {
    const cell = ws.getCell(row, c + 1);
    cell.value = headers[c];
    cell.font = STYLE.header.font;
    cell.fill = STYLE.header.fill;
    cell.alignment = { horizontal: "center", vertical: "center" };
  }
  ws.getRow(row).height = STYLE.header.height;
}

/** 'YYYY-MM-DD' → Date（UTC 午夜，避免 ExcelJS 序列化后日期漂移一天）；空 → null */
function dateToCell(v) {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}

function writeDataRow(ws, row, rec, kind, imageJobs) {
  const dateCols = kind === "li" ? { filed: 6, reject: 9 } : { filed: 6, reject: 9 };
  ws.getCell(row, 1).value = rec.plaintiff ?? "";
  ws.getCell(row, 2).value = rec.defendant ?? "";
  ws.getCell(row, 3).value = rec.account ?? "";
  ws.getCell(row, 4).value = rec.password ?? "";

  const statusCell = ws.getCell(row, 5);
  if (rec.status === "UNKNOWN") {
    statusCell.value = "";
    statusCell.fill = STYLE.unknown.fill;
    statusCell.font = STYLE.unknown.font;
  } else {
    statusCell.value = rec.status ?? "";
  }

  const filed = dateToCell(rec.filedTime);
  ws.getCell(row, dateCols.filed).value = filed;
  ws.getCell(row, dateCols.filed).numFmt = STYLE.dateFormat;

  ws.getCell(row, 7).value = rec.caseNumber ?? "";

  const reject = dateToCell(rec.rejectTime);
  ws.getCell(row, dateCols.reject).value = reject;
  ws.getCell(row, dateCols.reject).numFmt = STYLE.dateFormat;
  ws.getCell(row, 10).value = rec.rejectReason ?? "";

  const query = dateToCell(rec.queryTime);
  ws.getCell(row, 12).value = query;
  ws.getCell(row, 12).numFmt = STYLE.dateFormat;

  if (rec.successImage) {
    imageJobs.push({ blob: rec.successImage, ...STYLE.image.success, row: row - 1 });
  }
  if (rec.rejectImage) {
    imageJobs.push({ blob: rec.rejectImage, ...STYLE.image.reject, row: row - 1 });
  }
  ws.getRow(row).height = STYLE.dataRowHeight;
}

/**
 * 构建完整导出工作簿（双表块 + 样式复刻 + 图片嵌入）。
 * @param {{cases?: object[], enforcementCases?: object[]}} [data] db 记录（含 Blob 图片）
 * @returns {Promise<ExcelJS.Workbook>}
 */
export async function buildExportWorkbook({ cases = [], enforcementCases = [] } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const [letter, width] of Object.entries(STYLE.colWidths)) {
    ws.getColumn(letter).width = width;
  }

  writeHeader(ws, 1, HEADER_LI);
  const imageJobs = [];
  let row = 2;
  for (const c of cases) {
    writeDataRow(ws, row, c, "li", imageJobs);
    row += 1;
  }
  // 强执表头 = 立案末行 + 5（row 此时 = 立案末行 + 1，故 +4）
  const qzHeader = row + 4;
  writeHeader(ws, qzHeader, HEADER_QZ);
  let qzRow = qzHeader + 1;
  for (const c of enforcementCases) {
    writeDataRow(ws, qzRow, c, "qz", imageJobs);
    qzRow += 1;
  }

  for (const job of imageJobs) {
    const buffer = Buffer.from(await job.blob.arrayBuffer());
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
