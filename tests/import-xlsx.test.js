import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";

import { importXlsx } from "../extension/data/import-xlsx.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "立案与强执查询表-脱敏模板.xlsx");
const fixtureBuffer = () => readFileSync(FIXTURE);

/** 复制 fixture 并修改指定单元格后返回 buffer */
async function mutateFixture(mutator) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fixtureBuffer());
  const ws = wb.getWorksheet("Sheet1");
  mutator(ws);
  return wb.xlsx.writeBuffer();
}

test("fixture 导入：双块各 3 行，字段映射正确，DISPIMG 跳过", async () => {
  const { liRows, qzRows, skipped, reasons } = await importXlsx(fixtureBuffer());
  assert.equal(liRows.length, 3);
  assert.equal(qzRows.length, 3);
  assert.equal(skipped, 0);
  assert.deepEqual(reasons, []);

  // 立案第 1 行：审核中，只带查询时间
  assert.deepEqual(liRows[0], {
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
  });
  // 立案第 2 行：立案成功（H3 是 DISPIMG 公式 → successImage 必须为 null 且不报错）
  assert.equal(liRows[1].status, "立案成功");
  assert.equal(liRows[1].filedTime, "2026-07-22");
  assert.equal(liRows[1].caseNumber, "（2026）京0000民初00001号");
  assert.equal(liRows[1].successImage, null);
  // 立案第 3 行：已驳回
  assert.equal(liRows[2].status, "已驳回");
  assert.equal(liRows[2].rejectTime, "2026-07-28");
  assert.ok(liRows[2].rejectReason.includes("测试用驳回原因"));
  // 强执块
  assert.equal(qzRows[1].status, "强执成功");
  assert.equal(qzRows[1].filedTime, "2026-06-03");
  assert.equal(qzRows[1].caseNumber, "（2026）京0000执00001号");
});

test("表头不匹配 → 抛错", async () => {
  const buf = await mutateFixture((ws) => { ws.getCell("A1").value = "原告X"; });
  await assert.rejects(importXlsx(buf), /模板不匹配/);
});

test("强执表头缺失 → 抛错", async () => {
  const buf = await mutateFixture((ws) => { ws.getCell("E9").value = "其它状态"; });
  await assert.rejects(importXlsx(buf), /未找到强执表头行/);
});

test("必填列缺失 → 跳过并记录原因", async () => {
  const buf = await mutateFixture((ws) => { ws.getCell("A2").value = null; });
  const { liRows, skipped, reasons } = await importXlsx(buf);
  assert.equal(liRows.length, 2);
  assert.equal(skipped, 1);
  assert.ok(reasons[0].includes("第2行"));
});

test("状态不在枚举 → 跳过；状态为空 → UNKNOWN", async () => {
  const buf = await mutateFixture((ws) => {
    ws.getCell("E2").value = "已判决";
    ws.getCell("E3").value = null;
  });
  const { liRows, skipped, reasons } = await importXlsx(buf);
  assert.equal(liRows.length, 2);
  assert.equal(skipped, 1);
  assert.ok(reasons[0].includes("已判决"));
  assert.equal(liRows.find((r) => r.account === "TEST-ACCOUNT-002").status, "UNKNOWN");
});
