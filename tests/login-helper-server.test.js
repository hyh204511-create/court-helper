import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test, after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "scripts", "login-helper-server.py");
const PORT = 8765;
const BASE = `http://127.0.0.1:${PORT}`;
const TEMP_DIR = mkdtempSync(join(tmpdir(), "court-helper-login-test-"));
const ACCOUNTS_FILE = join(TEMP_DIR, "accounts.txt");

writeFileSync(
  ACCOUNTS_FILE,
  [
    "# 注释行应跳过",
    "",
    "  # 前导空白注释也应跳过",
    "acct-first first password with spaces",
    "账号甲 密码甲 含有 空格",
  ].join("\n"),
  "utf8",
);

const children = new Set();
let serverQueue = Promise.resolve();

function startServer(accountsPath) {
  const child = spawn("python", [SERVER, "--accounts", accountsPath], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  children.add(child);
  return { child, getOutput: () => output };
}

async function waitHealthy(server) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) return false;
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return true;
    } catch {
      // Python process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill();
  await Promise.race([
    once(server.child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  children.delete(server.child);
}

async function withServer(accountsPath, callback) {
  const previous = serverQueue;
  let release;
  serverQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  const server = startServer(accountsPath);
  try {
    assert.equal(await waitHealthy(server), true, "本地服务未能启动");
    return await callback(server);
  } finally {
    await stopServer(server);
    release();
  }
}

after(async () => {
  for (const child of children) {
    await stopServer({ child });
  }
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

test("GET /health 返回 ok:true 与 UTF-8 JSON", async () => {
  await withServer(ACCOUNTS_FILE, async () => {
    const response = await fetch(`${BASE}/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json; charset=utf-8$/i);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test("GET /accounts 过滤注释/空行，按首个空格拆分且保留密码内空格与 UTF-8", async () => {
  await withServer(ACCOUNTS_FILE, async (server) => {
    const response = await fetch(`${BASE}/accounts`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      accounts: [
        { account: "acct-first", password: "first password with spaces" },
        { account: "账号甲", password: "密码甲 含有 空格" },
      ],
    });
    assert.equal(server.getOutput().includes("acct-first"), false);
    assert.equal(server.getOutput().includes("first password with spaces"), false);
  });
});

test("账号文件不存在时返回空数组", async () => {
  await withServer(join(TEMP_DIR, "missing-accounts.txt"), async () => {
    const response = await fetch(`${BASE}/accounts`);
    assert.deepEqual(await response.json(), { ok: true, accounts: [] });
  });
});

test("OPTIONS 与 JSON 响应带 CORS 约定", async () => {
  await withServer(ACCOUNTS_FILE, async () => {
    const response = await fetch(`${BASE}/ocr`, { method: "OPTIONS" });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.match(response.headers.get("access-control-allow-methods") ?? "", /GET/);
    assert.match(response.headers.get("access-control-allow-methods") ?? "", /POST/);

    const health = await fetch(`${BASE}/health`);
    assert.equal(health.headers.get("access-control-allow-origin"), "*");
  });
});

test("未知路由返回稳定的非敏感 404", async () => {
  await withServer(ACCOUNTS_FILE, async () => {
    const response = await fetch(`${BASE}/unknown-route`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { ok: false, error: "NOT_FOUND" });
  });
});
