import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { test, after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "scripts", "login-helper-server.py");
let BASE = "";
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
    "acct-spacing   leading  inner  ",
  ].join("\n"),
  "utf8",
);

const OCR_SUCCESS_DIR = join(TEMP_DIR, "ocr-success");
const OCR_MISSING_DIR = join(TEMP_DIR, "ocr-missing");
mkdirSync(OCR_SUCCESS_DIR);
mkdirSync(OCR_MISSING_DIR);
writeFileSync(
  join(OCR_SUCCESS_DIR, "ddddocr.py"),
  [
    "class DdddOcr:",
    "    def __init__(self, show_ad=False):",
    "        pass",
    "    def classification(self, data):",
    "        return '  OCR-OK  '",
  ].join("\n"),
  "utf8",
);
writeFileSync(join(OCR_MISSING_DIR, "ddddocr.py"), "raise ImportError('optional dependency unavailable')\n", "utf8");

const children = new Set();
let serverQueue = Promise.resolve();
const STOP_TIMEOUT_MS = 2000;
const FORCE_KILL_TIMEOUT_MS = 5000;

function startServer(accountsPath, env = {}) {
  const port = 20000 + Math.floor(Math.random() * 40001);
  const base = `http://127.0.0.1:${port}`;
  BASE = base;
  const child = spawn("python", [SERVER, "--accounts", accountsPath, "--port", String(port)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  children.add(child);
  return { child, base, getOutput: () => output };
}

async function waitHealthy(server) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) return false;
    try {
      const response = await fetch(`${server.base}/health`);
      if (response.ok) return true;
    } catch {
      // Python process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export function buildTaskkillArgs(pid) {
  return ["/PID", String(pid), "/T", "/F"];
}

function forceKillProcessTree(pid, spawnImpl = spawn, timeoutMs = FORCE_KILL_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let killer;
    try {
      killer = spawnImpl("taskkill", buildTaskkillArgs(pid), { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }

    let timer;
    let settled = false;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      killer.removeListener("error", onError);
      killer.removeListener("exit", onExit);
    };
    const finish = (success) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(success);
    };
    const onError = () => finish(false);
    const onExit = (code) => finish(code === 0);

    killer.once("error", onError);
    killer.once("exit", onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function waitForExit(child, timeoutMs = STOP_TIMEOUT_MS, timerApi = {}) {
  if (child.exitCode !== null) return true;
  const setTimeoutImpl = timerApi.setTimeout ?? setTimeout;
  const clearTimeoutImpl = timerApi.clearTimeout ?? clearTimeout;

  return new Promise((resolve) => {
    let timer;
    let settled = false;
    const onExit = () => finish(true);
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeoutImpl(timer);
      child.removeListener("exit", onExit);
      resolve(exited || child.exitCode !== null);
    };

    child.once("exit", onExit);
    timer = setTimeoutImpl(() => finish(false), timeoutMs);
    if (settled && timer !== undefined) clearTimeoutImpl(timer);
  });
}

async function stopServer(
  server,
  forceKill = forceKillProcessTree,
  waitForExitImpl = waitForExit,
) {
  const child = server?.child;
  if (!child) return;
  if (child.exitCode !== null) {
    children.delete(child);
    return;
  }

  child.kill();
  let exited = await waitForExitImpl(child);
  if (!exited && child.exitCode === null) {
    const forceKillSucceeded = await forceKill(child.pid);
    if (forceKillSucceeded === false) {
      throw new Error(`local server force kill failed: ${child.pid}`);
    }
    exited = await waitForExitImpl(child);
  }
  if (!exited) throw new Error(`本地服务进程未退出: ${child.pid}`);
  children.delete(child);
}

test("stopServer：普通 kill 超时后强杀进程树并确认退出", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.pid = 54321;
  child.kill = () => {};
  const taskkillPids = [];
  let waitCalls = 0;
  const quickWaitForExit = async (candidate) => {
    assert.equal(candidate, child);
    waitCalls += 1;
    return waitCalls > 1;
  };

  await stopServer({ child }, async (pid) => {
    taskkillPids.push(pid);
    child.exitCode = 1;
    child.emit("exit", 1, null);
  }, quickWaitForExit);

  assert.deepEqual(taskkillPids, [54321]);
  assert.notEqual(child.exitCode, null);
  assert.equal(waitCalls, 2);
});

test("buildTaskkillArgs 使用 taskkill 所需的单斜杠参数", () => {
  assert.deepEqual(buildTaskkillArgs(54321), ["/PID", "54321", "/T", "/F"]);
});

test("forceKillProcessTree 将 taskkill 非零退出码视为失败", async () => {
  const killer = new EventEmitter();
  let spawnCall;
  const result = forceKillProcessTree(54321, (command, args, options) => {
    spawnCall = { command, args, options };
    queueMicrotask(() => killer.emit("exit", 1, null));
    return killer;
  });

  assert.equal(await result, false);
  assert.deepEqual(spawnCall, {
    command: "taskkill",
    args: ["/PID", "54321", "/T", "/F"],
    options: { stdio: "ignore" },
  });
  assert.equal(killer.listenerCount("exit"), 0);
});

test("forceKillProcessTree 超时视为失败", async () => {
  const killer = new EventEmitter();
  const result = await forceKillProcessTree(54321, () => killer, 10);

  assert.equal(result, false);
  assert.equal(killer.listenerCount("error"), 0);
  assert.equal(killer.listenerCount("exit"), 0);
});

test("waitForExit 在 exit 后移除监听器并清理超时定时器", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  const timers = [];
  const clearedTimers = [];
  const timerApi = {
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      clearedTimers.push(timer);
    },
  };

  const waiting = waitForExit(child, 5000, timerApi);
  assert.equal(child.listenerCount("exit"), 1);
  child.exitCode = 0;
  child.emit("exit", 0, null);

  assert.equal(await waiting, true);
  assert.equal(child.listenerCount("exit"), 0);
  assert.deepEqual(clearedTimers, [timers[0]]);
});

async function withServer(accountsPath, callback, env = {}, dependencies = {}) {
  const {
    startServer: startServerImpl = startServer,
    waitHealthy: waitHealthyImpl = waitHealthy,
    stopServer: stopServerImpl = stopServer,
  } = dependencies;
  const previous = serverQueue;
  let release;
  serverQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  let server;
  try {
    server = startServerImpl(accountsPath, env);
    assert.equal(await waitHealthyImpl(server), true, "本地服务未能启动");
    return await callback(server);
  } finally {
    try {
      if (server) await stopServerImpl(server);
    } finally {
      release();
    }
  }
}

async function cleanupChildren(stopServerImpl = stopServer, childSet = children) {
  const errors = [];
  for (const child of childSet) {
    try {
      await stopServerImpl({ child });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "failed to clean up child processes");
  }
}

test("withServer 在 stopServer 抛错后仍释放串行队列", async () => {
  const firstServer = { child: { name: "first" }, base: "fake://first" };
  const stopError = new Error("injected stop failure");
  let firstStopCalls = 0;

  await assert.rejects(
    withServer(
      "unused",
      async () => {},
      {},
      {
        startServer: () => firstServer,
        waitHealthy: async () => true,
        stopServer: async () => {
          firstStopCalls += 1;
          throw stopError;
        },
      },
    ),
    (error) => error === stopError,
  );

  const secondServer = { child: { name: "second" }, base: "fake://second" };
  let secondAcquired = false;
  await Promise.race([
    withServer(
      "unused",
      async () => {
        secondAcquired = true;
      },
      {},
      {
        startServer: () => secondServer,
        waitHealthy: async () => true,
        stopServer: async () => {},
      },
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error("server queue remained locked")), 100)),
  ]);

  assert.equal(firstStopCalls, 1);
  assert.equal(secondAcquired, true);
});

test("cleanupChildren 尝试全部 child 并最终抛出 AggregateError", async () => {
  const firstChild = { name: "first" };
  const secondChild = { name: "second" };
  const firstError = new Error("first cleanup failed");
  const secondError = new Error("second cleanup failed");
  const attempts = [];

  await assert.rejects(
    cleanupChildren(async ({ child }) => {
      attempts.push(child);
      throw attempts.length === 1 ? firstError : secondError;
    }, new Set([firstChild, secondChild])),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [firstError, secondError]);
      return true;
    },
  );
  assert.deepEqual(attempts, [firstChild, secondChild]);
});

after(async () => {
  try {
    await cleanupChildren();
  } finally {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  }
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
        { account: "acct-spacing", password: "  leading  inner  " },
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

test("POST /ocr 合法 JSON 经可选 ddddocr 返回 trim 后文本", async () => {
  await withServer(
    ACCOUNTS_FILE,
    async (server) => {
      const image = "Y2FwdHVyZS1ieXRlcw==";
      const response = await fetch(`${BASE}/ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, text: "OCR-OK" });
      assert.equal(server.getOutput().includes(image), false);
      assert.equal(server.getOutput().includes("OCR-OK"), false);
    },
    { PYTHONPATH: [OCR_SUCCESS_DIR, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
  );
});

test("POST /ocr 未安装 ddddocr 时返回精确 DDDDOCR_MISSING", async () => {
  await withServer(
    ACCOUNTS_FILE,
    async () => {
      const response = await fetch(`${BASE}/ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: "Y2FwdHVyZS1ieXRlcw==" }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: false, error: "DDDDOCR_MISSING" });
    },
    { PYTHONPATH: [OCR_MISSING_DIR, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
  );
});

test("POST /ocr 缺失/空 image 与非法 JSON 返回稳定非敏感错误", async () => {
  await withServer(
    ACCOUNTS_FILE,
    async () => {
      for (const body of [{}, { image: "" }]) {
        const response = await fetch(`${BASE}/ocr`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { ok: false, error: "IMAGE_REQUIRED" });
      }

      const invalid = await fetch(`${BASE}/ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json-captcha-body",
      });
      assert.equal(invalid.status, 400);
      const invalidBody = await invalid.json();
      assert.deepEqual(invalidBody, { ok: false, error: "BAD_REQUEST" });
      assert.equal(JSON.stringify(invalidBody).includes("not-json-captcha-body"), false);
    },
    { PYTHONPATH: [OCR_MISSING_DIR, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
  );
});

test("POST /ocr 超过大小上限返回 413，不进入识别流程", async () => {
  await withServer(
    ACCOUNTS_FILE,
    async () => {
      const response = await fetch(`${BASE}/ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: "x".repeat(2 * 1024 * 1024) }),
      });
      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), { ok: false, error: "REQUEST_TOO_LARGE" });
    },
    { PYTHONPATH: [OCR_MISSING_DIR, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
  );
});
