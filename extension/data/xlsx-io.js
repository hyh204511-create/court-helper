// xlsx-io.js — Excel 导出核心（ExcelJS）
// 依据 docs/specs/excel-module.md：表头常量、双表块布局、OneCellAnchor 图片嵌入。
// Phase 5 扩展：完整样式复刻（填充/行高/列宽/日期格式）、强执表块、导入解析。
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

/**
 * 导出工作簿（Sheet1）。
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
