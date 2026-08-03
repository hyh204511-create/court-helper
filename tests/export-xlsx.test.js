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

test("导出双表块：布局/样式/日期格式/图片锚点", async () => {
  const wb = await buildExportWorkbook({
    cases: [
      rec({ status: "立案成功", filedTime: "2026-07-22", caseNumber: "（2026）京0000民初00001号", successImage: IMG(1) }),
      rec({ status: "已驳回", rejectTime: "2026-07-28", rejectReason: "请补充材料。", rejectImage: IMG(2) }),
    ],
    enforcementCases: [
      rec({ status: "强执成功", filedTime: "2026-06-03", caseNumber: "（2026）京0000执00001号", successImage: IMG(3) }),
    ],
  });
  const { dir, file } = await writeToTemp(wb);
  try {
    const info = verify(file, [
      "A1", "E1", "G1", "E2", "F2", "G2", "I3", "J3",
      "E8", "E9", "F9", "G9", "L2",
    ]);
    // 双表块布局：立案表头第 1 行，强执表头 = 立案末行(3) + 5 = 8
    assert.deepEqual(info.sheets, ["Sheet1"]);
    assert.equal(info.cells.A1, "原告");
    assert.equal(info.cells.E1, "立案状态");
    assert.equal(info.cells.G1, "案号");
    assert.equal(info.cells.E8, "强执状态");
    // 数据值
    assert.equal(info.cells.E2, "立案成功");
    assert.equal(info.cells.F2, "2026-07-22");
    assert.equal(info.cells.G2, "（2026）京0000民初00001号");
    assert.equal(info.cells.I3, "2026-07-28");
    assert.equal(info.cells.J3, "请补充材料。");
    assert.equal(info.cells.E9, "强执成功");
    assert.equal(info.cells.F9, "2026-06-03");
    assert.equal(info.cells.G9, "（2026）京0000执00001号");
    assert.equal(info.cells.L2, "2026-08-03");
    // 图片锚点：立案成功 H2、驳回 K3、强执成功 H9（0 基）
    assert.equal(info.image_count, 3);
    assert.deepEqual(info.anchors, [
      { col: 7, row: 1 },
      { col: 10, row: 2 },
      { col: 7, row: 8 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

test("样式复刻：表头加粗/填充/行高、数据行高（ExcelJS 读回）", async () => {
  const wb = await buildExportWorkbook({ cases: [rec()] });
  const ws = wb.getWorksheet("Sheet1");
  assert.equal(ws.getCell("A1").font.bold, true);
  assert.equal(ws.getCell("A1").fill.fgColor.argb, "FF92D050");
  assert.equal(ws.getRow(1).height, 27);
  assert.equal(ws.getRow(2).height, 28);
  assert.equal(ws.getColumn("J").width, 39.63);
  assert.equal(ws.getCell("F2").numFmt, "mm-dd-yy");
});
