import "fake-indexeddb/auto";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";

import {
  STORE_CASES,
  STORE_ENFORCEMENT,
  applyImport,
  query,
  resetDb,
  upsert,
} from "../extension/data/db.js";
import { importXlsx } from "../extension/data/import-xlsx.js";
import { buildExportWorkbook } from "../extension/data/xlsx-io.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "立案与强执查询表-脱敏模板.xlsx");
const IMG = (n) => new Blob([new Uint8Array([n, n + 1, n + 2])], { type: "image/png" });

beforeEach(async () => {
  await resetDb();
});

test("往返：旧模板导入 → 模拟查询写库 → 新 21 列报表导出 → openpyxl 双读对比", async () => {
  // 1) 导入脱敏 fixture（3 立案 + 3 强执，H3 为 DISPIMG）
  const parsed = await importXlsx(readFileSync(FIXTURE));
  assert.equal(parsed.liRows.length, 3);
  assert.equal(parsed.qzRows.length, 3);
  const imp1 = await applyImport(STORE_CASES, parsed.liRows);
  const imp2 = await applyImport(STORE_ENFORCEMENT, parsed.qzRows);
  assert.deepEqual({ ...imp1 }, { imported: 3, updated: 0 });
  assert.deepEqual({ ...imp2 }, { imported: 3, updated: 0 });

  // 2) 模拟批量查询结果：状态 + 截图写库
  await upsert(STORE_CASES, { ...parsed.liRows[1], status: "立案成功", successImage: IMG(1) }); // 账号 002
  await upsert(STORE_CASES, { ...parsed.liRows[2], status: "已驳回", rejectImage: IMG(2) }); // 账号 003
  await upsert(STORE_ENFORCEMENT, { ...parsed.qzRows[1], status: "强执成功", successImage: IMG(3) }); // 账号 005
  // 账号 001 仍是导入时的「审核中」

  // 3) 导出
  const wb = await buildExportWorkbook({
    cases: await query(STORE_CASES),
    enforcementCases: await query(STORE_ENFORCEMENT),
    salesperson: "测试业务员甲",
  });
  const dir = mkdtempSync(path.join(tmpdir(), "court-helper-roundtrip-"));
  const file = path.join(dir, "立案与强执查询表-往返测试.xlsx");
  try {
    await wb.xlsx.writeFile(file);

    // 4a) openpyxl 读回：结构 + 值 + 图片锚点
    const res = spawnSync("python", [
      "scripts/verify-export.py", file,
      "--cells", "A1,E1,L1,M1,T1,U1,U2,U6,E2,E3,F3,G3,E4,I4,K4,M5,M6,N6,O6,L3",
    ], { encoding: "utf8", cwd: ROOT });
    assert.equal(res.status, 0, `verify-export.py 失败: ${res.stderr}`);
    const info = JSON.parse(res.stdout);
    assert.equal(info.cells.A1, "原告");
    assert.equal(info.cells.E1, "立案状态");
    assert.equal(info.cells.E2, "审核中");          // 账号 001 未更新
    assert.equal(info.cells.E3, "立案成功");          // 账号 002
    assert.equal(info.cells.F3, "2026-07-22");
    assert.equal(info.cells.G3, "（2026）京0000民初00001号");
    assert.equal(info.cells.E4, "已驳回");            // 账号 003
    assert.equal(info.cells.I4, "2026-07-28");
    assert.equal(info.cells.K4, "");                 // 图片列本身无值
    assert.equal(info.cells.L1, "立案查询时间");
    assert.equal(info.cells.M1, "强执状态");
    assert.equal(info.cells.T1, "强执查询时间");
    assert.equal(info.cells.U1, "业务员");
    assert.equal(info.cells.U2, "测试业务员甲");
    assert.equal(info.cells.U6, "测试业务员甲");
    assert.equal(info.cells.M5, "审核中");
    assert.equal(info.cells.M6, "强执成功");
    assert.equal(info.cells.N6, "2026-06-03");
    assert.equal(info.cells.O6, "（2026）京0000执00001号");
    assert.equal(info.cells.L3, "2026-08-03");
    // 3 张图：H3(立案成功) K4(驳回) P6(强执成功)
    assert.equal(info.image_count, 3);
    assert.deepEqual(info.anchors, [
      { col: 7, row: 2 },
      { col: 10, row: 3 },
      { col: 15, row: 5 },
    ]);

    // 4b) ExcelJS 读回（双读之二）：日期值一致
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.readFile(file);
    const ws2 = wb2.getWorksheet("Sheet1");
    const fmt = (d) => (d instanceof Date
      ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
      : d);
    assert.equal(fmt(ws2.getCell("F3").value), "2026-07-22");
    assert.equal(fmt(ws2.getCell("I4").value), "2026-07-28");
    assert.equal(fmt(ws2.getCell("L3").value), "2026-08-03");
    assert.equal(ws2.getCell("M6").value, "强执成功");
    assert.equal(ws2.getCell("O6").value, "（2026）京0000执00001号");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("往返：重复导入同一文件 → 全部 updated", async () => {
  const parsed = await importXlsx(readFileSync(FIXTURE));
  await applyImport(STORE_CASES, parsed.liRows);
  const again = await applyImport(STORE_CASES, parsed.liRows);
  assert.deepEqual({ ...again }, { imported: 0, updated: 3 });
});
