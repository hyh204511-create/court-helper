import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { HEADER_LI, exportWorkbook } from "../extension/data/xlsx-io.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 1x1 像素 PNG（标准 67 字节 base64，最小合法 PNG）
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function verifyWithOpenpyxl(file) {
  const res = spawnSync("python", [path.join(ROOT, "scripts", "verify-export.py"), file], { encoding: "utf8" });
  assert.equal(res.status, 0, `verify-export.py 失败: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

test("导出含图片 xlsx：openpyxl 读回 1 张图且锚定 H2", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "court-helper-"));
  const file = path.join(dir, "export-test.xlsx");
  try {
    await exportWorkbook(file, {
      header: HEADER_LI,
      rows: [[
        "测试原告甲", "测试被告A", "TEST-ACCOUNT-001", "test-pass-001",
        "立案成功", new Date(2026, 6, 22), "（2026）京0000民初00001号",
        null, null, null, null, new Date(2026, 7, 3),
      ]],
      images: [{ col: 7, row: 1, buffer: PNG_1PX, width: 60, height: 34 }],
    });
    const info = verifyWithOpenpyxl(file);
    assert.equal(info.image_count, 1, `image_count=${info.image_count}`);
    assert.deepEqual(info.anchors[0], { col: 7, row: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
