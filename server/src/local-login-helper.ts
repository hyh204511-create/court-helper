import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface LocalLoginHelper {
  ensureRunning(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Bind OCR helper availability to the backend lifecycle without making OCR a
 * prerequisite for the administrative service itself to listen.
 */
export async function startBoundLocalLoginHelper(helper: LocalLoginHelper | undefined): Promise<void> {
  try {
    await helper?.ensureRunning();
  } catch {
    // The caller keeps the backend available; login automation will degrade
    // through its existing SERVICE_UNAVAILABLE / NEEDS_HUMAN path.
  }
}

interface LocalLoginHelperOptions {
  helperPath?: string;
  pythonCommand?: string;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  environment?: NodeJS.ProcessEnv;
}

const DEFAULT_HELPER_PATH = fileURLToPath(new URL('../../scripts/login-helper-server.py', import.meta.url));
const HEALTH_URL = 'http://127.0.0.1:8765/health';
const HELPER_ENV_KEYS = ['COMSPEC', 'PATH', 'PATHEXT', 'PYTHONHOME', 'PYTHONPATH', 'SYSTEMROOT', 'WINDIR'];

function helperEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    HELPER_ENV_KEYS.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]),
  );
}

async function healthy(fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(HEALTH_URL, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

function exited(child: ChildProcess | undefined): boolean {
  return !child || (child.exitCode !== null || child.signalCode !== null);
}

function running(child: ChildProcess | undefined): boolean {
  return !exited(child);
}

function waitForExit(child: ChildProcess, timeoutMs = 2_000): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onExit = () => finish(true);
    function finish(didExit: boolean) {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(didExit || exited(child));
    }
    child.once('exit', onExit);
  });
}

export function createLocalLoginHelper(options: LocalLoginHelperOptions = {}): LocalLoginHelper {
  const helperPath = options.helperPath ?? DEFAULT_HELPER_PATH;
  const pythonCommand = options.pythonCommand ?? 'python';
  const fetchImpl = options.fetchImpl ?? fetch;
  const spawnImpl = options.spawnImpl ?? spawn;
  const environment = helperEnvironment(options.environment ?? process.env);
  let child: ChildProcess | undefined;
  let starting: Promise<void> | undefined;
  let closing = false;

  async function ensureRunning(): Promise<void> {
    if (closing || await healthy(fetchImpl) || closing || running(child)) return;
    if (starting) return starting;

    starting = Promise.resolve().then(() => {
      if (closing || running(child)) return;
      let launched: ChildProcess;
      try {
        launched = spawnImpl(pythonCommand, [helperPath, '--ocr-only'], {
          stdio: 'ignore',
          windowsHide: true,
          env: environment,
        });
      } catch {
        return;
      }
      child = launched;
      launched.on('error', () => {
        if (child === launched) child = undefined;
      });
      launched.once('exit', () => {
        if (child === launched) child = undefined;
      });
      launched.unref();
    }).finally(() => {
      starting = undefined;
    });
    return starting;
  }

  async function stop(): Promise<void> {
    closing = true;
    await starting;
    const launched = child;
    if (!launched || exited(launched)) return;
    launched.kill();
    let didExit = await waitForExit(launched);
    if (!didExit && process.platform === 'win32' && typeof launched.pid === 'number') {
      try {
        const killer = spawn('taskkill', ['/PID', String(launched.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          env: environment,
        });
        await waitForExit(killer);
      } catch {
        // The failure below remains observable through the child not exiting.
      }
      didExit = await waitForExit(launched);
    }
    if (!didExit) throw new Error('Local OCR helper did not exit during shutdown');
  }

  return { ensureRunning, stop };
}
