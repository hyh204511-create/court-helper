import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";

import { buildExportWorkbook } from "../extension/data/xlsx-io.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const IMG = (n) => new Blob([new Uint8Array([n, n + 1, n + 2])], { type: "image/png" });

function rec(over = {}) {
  return {
    account: "TEST-ACCOUNT-001",
    password: "test-pass-001",
    plaintiff: "测试原告甲",
    defendant: "测试被告A",
    status: "审核中",
    filedTime: null,
    caseNumber: null,
    successImage: null,
    rejectTime: null,
    rejectReason: null,
    rejectImage: null,
    queryTime: "2026-08-03",
    ...over,
  };
}

async function writeToTemp(wb) {
  const dir = mkdtempSync(path.join(tmpdir(), "court-helper-export-"));
  const file = path.join(dir, "export.xlsx");
  await wb.xlsx.writeFile(file);
  return { dir, file };
}

function verify(file, cells) {
  const args = ["scripts/verify-export.py", file];
  if (cells) args.push("--cells", cells.join(","));
  const res = spawnSync("python", args, { encoding: "utf8", cwd: ROOT });
  assert.equal(res.status, 0, `verify-export.py 失败: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

test("导出 21 列合并表：布局/业务员/日期格式/图片锚点", async () => {
  const wb = await buildExportWorkbook({
    cases: [
      rec({ status: "立案成功", filedTime: "2026-07-22", caseNumber: "（2026）京0000民初00001号", successImage: IMG(1) }),
      rec({ status: "已驳回", rejectTime: "2026-07-28", rejectReason: "请补充材料。", rejectImage: IMG(2) }),
    ],
    enforcementCases: [
      rec({ status: "强执成功", filedTime: "2026-06-03", caseNumber: "（2026）京0000执00001号", successImage: IMG(3) }),
    ],
    salesperson: "测试业务员甲",
  });
  const { dir, file } = await writeToTemp(wb);
  try {
    const info = verify(file, [
      "A1", "E1", "G1", "E2", "F2", "G2", "I3", "J3",
      "L1", "M1", "T1", "U1", "M2", "N2", "O2", "L2", "U2", "U3",
    ]);
    // 单表头布局：同一账号与当事人的立案、强执结果合并到同一行。
    assert.deepEqual(info.sheets, ["Sheet1"]);
    assert.equal(info.cells.A1, "原告");
    assert.equal(info.cells.E1, "立案状态");
    assert.equal(info.cells.G1, "案号");
    assert.equal(info.cells.L1, "立案查询时间");
    assert.equal(info.cells.M1, "强执状态");
    assert.equal(info.cells.T1, "强执查询时间");
    assert.equal(info.cells.U1, "业务员");
    // 数据值
    assert.equal(info.cells.E2, "立案成功");
    assert.equal(info.cells.F2, "2026-07-22");
    assert.equal(info.cells.G2, "（2026）京0000民初00001号");
    assert.equal(info.cells.I3, "2026-07-28");
    assert.equal(info.cells.J3, "请补充材料。");
    assert.equal(info.cells.M2, "强执成功");
    assert.equal(info.cells.N2, "2026-06-03");
    assert.equal(info.cells.O2, "（2026）京0000执00001号");
    assert.equal(info.cells.L2, "2026-08-03");
    assert.equal(info.cells.U2, "测试业务员甲");
    assert.equal(info.cells.U3, "测试业务员甲");
    // 图片锚点：立案成功 H2、驳回 K3、强执成功 P2（0 基）
    assert.equal(info.image_count, 3);
    assert.deepEqual(info.anchors, [
      { col: 7, row: 1 },
      { col: 15, row: 1 },
      { col: 10, row: 2 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("浏览器无 Node Buffer 全局时仍可构建带图工作簿", async () => {
  const originalBuffer = globalThis.Buffer;
  try {
    globalThis.Buffer = undefined;
    const wb = await buildExportWorkbook({
      cases: [rec({ status: "立案成功", successImage: IMG(7) })],
    });
    assert.equal(wb.getWorksheet("Sheet1").getImages().length, 1);
  } finally {
    globalThis.Buffer = originalBuffer;
  }
});

test("UNKNOWN 状态：单元格留空 + 浅红填充 + 深红字体（ExcelJS 读回）", async () => {
  const wb = await buildExportWorkbook({ cases: [rec({ status: "UNKNOWN" })] });
  const ws = wb.getWorksheet("Sheet1");
  const cell = ws.getCell("E2");
  assert.equal(cell.value, "");
  assert.equal(cell.fill.fgColor.argb, "FFFFC7CE");
  assert.equal(cell.font.color.argb, "FF9C0006");
});

test("导出凭据统一覆盖所有行的账号密码且不修改本地记录", async () => {
  const source = rec({ account: "页面账号", password: "旧模板密码" });
  const wb = await buildExportWorkbook({
    cases: [source],
    exportCredential: { account: "真实平台账号", password: "真实平台密码" },
  });
  const ws = wb.getWorksheet("Sheet1");
  assert.equal(ws.getCell("C2").value, "真实平台账号");
  assert.equal(ws.getCell("D2").value, "真实平台密码");
  assert.equal(source.account, "页面账号");
  assert.equal(source.password, "旧模板密码");
});

test("样式复刻：表头加粗/填充/行高、数据行高（ExcelJS 读回）", async () => {
  const wb = await buildExportWorkbook({ cases: [rec()] });
  const ws = wb.getWorksheet("Sheet1");
  assert.equal(ws.getCell("A1").font.bold, true);
  assert.equal(ws.getCell("A1").fill.fgColor.argb, "FF92D050");
  assert.equal(ws.getRow(1).height, 27);
  assert.equal(ws.getRow(2).height, 28);
  assert.equal(ws.getColumn("J").width, 39.63);
  assert.equal(ws.getColumn("Q").width, 12.87);
  assert.equal(ws.getColumn("U").width, 13);
  assert.equal(ws.getCell("F2").numFmt, "mm-dd-yy");
});

test("模板保真：保留十行空白表格、细边框、宋体、垂直居中和驳回原因换行", async () => {
  const wb = await buildExportWorkbook({ cases: [rec()] });
  const { dir, file } = await writeToTemp(wb);
  try {
    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.readFile(file);
    const ws = reloaded.getWorksheet("Sheet1");

    assert.equal(ws.getCell("M1").value, "强执状态");
    assert.equal(ws.getRow(11).height, 28);
    assert.equal(ws.getCell("F11").numFmt, "mm-dd-yy");
    assert.equal(ws.getCell("I11").numFmt, "mm-dd-yy");
    assert.equal(ws.getCell("L11").numFmt, "mm-dd-yy");
    assert.equal(ws.getCell("N11").numFmt, "mm-dd-yy");
    assert.equal(ws.getCell("Q11").numFmt, "mm-dd-yy");
    assert.equal(ws.getCell("T11").numFmt, "mm-dd-yy");

    for (const cell of ["A1", "A11", "R10", "U11"]) {
      assert.equal(ws.getCell(cell).font.name, "宋体");
      assert.equal(ws.getCell(cell).alignment.vertical, "middle");
      assert.equal(ws.getCell(cell).border.left.style, "thin");
      assert.equal(ws.getCell(cell).border.right.style, "thin");
      assert.equal(ws.getCell(cell).border.top.style, "thin");
      assert.equal(ws.getCell(cell).border.bottom.style, "thin");
    }
    assert.equal(ws.getCell("R10").alignment.wrapText, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
