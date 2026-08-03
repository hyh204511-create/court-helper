import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "立案与强执查询表-脱敏模板.xlsx");

test("脱敏模板 fixture 存在且非空", () => {
  assert.ok(existsSync(FIXTURE), "fixture 缺失，请先运行 npm run fixture");
  assert.ok(statSync(FIXTURE).size > 0, "fixture 为空文件");
});

test("npm test 使用 node --test 默认发现规则", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "node --test");
});
