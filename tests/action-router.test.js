import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BROWSER_CONTROL_PATH,
  routeExtensionAction,
} from "../extension/sw/action-router.js";

function chromeWith(storageData) {
  const calls = { tabs: [], options: 0 };
  return {
    calls,
    storage: { local: { get: async () => storageData } },
    tabs: { create: async (value) => { calls.tabs.push(value); } },
    runtime: { openOptionsPage: async () => { calls.options += 1; } },
  };
}

test("已授权扩展点击图标打开后台控制台", async () => {
  const chromeApi = chromeWith({
    serverUrl: "http://127.0.0.1:3000",
    token: "paired-device-token",
    expiresAt: 20_000,
    remoteLoginEnabled: true,
    browserCommandDeviceId: "device-1",
  });

  const result = await routeExtensionAction({ chromeApi, now: () => 10_000 });

  assert.deepEqual(result, { destination: "console" });
  assert.deepEqual(chromeApi.calls.tabs, [{ url: `http://127.0.0.1:3000${BROWSER_CONTROL_PATH}` }]);
  assert.equal(chromeApi.calls.options, 0);
});

test("未配置、未授权或授权过期时点击图标只打开 Options/Setup", async () => {
  for (const storageData of [
    {},
    { serverUrl: "http://127.0.0.1:3000" },
    {
      serverUrl: "http://127.0.0.1:3000",
      token: "expired-token",
      expiresAt: 9_999,
      remoteLoginEnabled: true,
      browserCommandDeviceId: "device-1",
    },
  ]) {
    const chromeApi = chromeWith(storageData);
    const result = await routeExtensionAction({ chromeApi, now: () => 10_000 });
    assert.deepEqual(result, { destination: "setup" });
    assert.deepEqual(chromeApi.calls.tabs, []);
    assert.equal(chromeApi.calls.options, 1);
  }
});
