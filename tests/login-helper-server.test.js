// login-helper-server.test.js — 本地账号/OCR 服务契约测试（node --test）
// 规格：docs/specs/login-module.md §6
// 用 node 子进程 spawn python 起服务，验证 /health /accounts /ocr 与 CORS。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "scripts", "login-helper-server.py");

const tmpDir = mkdtempSync(join(tmpdir(), "login-helper-test-"));
const accountsFixture = join(tmpDir, "accounts.txt");
writeFileSync(
  accountsFixture,
  [
    "# 注释行应跳过",
    "",
    "13800000000 my-pass-1",
    "91350000XXXXXXXXXX my pass with spaces",
    "  91350000YYYYYYYYYY   padded-pass  ",
  ].join("\n"),
  "utf-8",
);

let childA;
let outputA = "";
function startServer(port, accountsPath) {
  const child = spawn(
    "python",
    [SERVER, "--port", String(port), "--accounts", accountsPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (d) => (outputA += d));
  child.stderr.on("data", (d) => (outputA += d));
  return child;
}

async function waitHealthy(base, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return true;
    } catch {
      /* 服务未就绪，重试 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const PORT_A = 18765;
const PORT_B = 18766;
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;

before(async () => {
  childA = startServer(PORT_A, accountsFixture);
  assert.equal(await waitHealthy(BASE_A), true, `server A not healthy:\n${outputA}`);
});

after(() => {
  childA?.kill();
  rmSync(tmpDir, { recursive: true, force: true });
});

test("/health 返回 ok:true", async () => {
  const r = await fetch(`${BASE_A}/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test("/accounts 解析账号文件（注释/空行跳过，密码可含空格，行首尾空白修剪）", async () => {
  const r = await fetch(`${BASE_A}/accounts`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.accounts, [
    { account: "13800000000", password: "my-pass-1" },
    { account: "91350000XXXXXXXXXX", password: "my pass with spaces" },
    { account: "91350000YYYYYYYYYY", password: "padded-pass" },
  ]);
});

test("/accounts 文件不存在 → ok:true + 空列表（不报错）", async () => {
  const childB = startServer(PORT_B, join(tmpDir, "no-such-file.txt"));
  try {
    assert.equal(await waitHealthy(BASE_B), true);
    const r = await fetch(`${BASE_B}/accounts`);
    const body = await r.json();
    assert.deepEqual(body, { ok: true, accounts: [] });
  } finally {
    childB.kill();
  }
});

test("/ocr 未安装 ddddocr → 明确错误 DDDDOCR_MISSING（不猜测、不崩溃）", async () => {
  const r = await fetch(`${BASE_A}/ocr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: "aGVsbG8=" }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "DDDDOCR_MISSING");
});

test("/ocr 缺少 image 字段 → 400 IMAGE_REQUIRED", async () => {
  const r = await fetch(`${BASE_A}/ocr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error, "IMAGE_REQUIRED");
});

test("响应带 CORS 头（content script 跨域 fetch 需要）", async () => {
  const r = await fetch(`${BASE_A}/health`);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

test("OPTIONS 预检 → 204 + CORS 头", async () => {
  const r = await fetch(`${BASE_A}/ocr`, { method: "OPTIONS" });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

test("未知路径 → 404", async () => {
  const r = await fetch(`${BASE_A}/nope`);
  assert.equal(r.status, 404);
});
