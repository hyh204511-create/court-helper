import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXTENSION_PAIRING_ALARM_NAME,
  createExtensionPairer,
} from '../extension/sw/extension-pairing.js';

const BASE_URL = 'https://court-helper.test';
const DEVICE_ID = '6b520a09-87bc-4adb-bacd-4b4f7c5ab4d1';
const REPAIRED_DEVICE_ID = '7c520a09-87bc-4adb-bacd-4b4f7c5ab4d2';
const EXCHANGE_SECRET = 'F5u7-dSlxHTwnl_JMiCNomrTHnrqWy3dyzyIVI7-WaM';
const PAIRING_ID = '00000000-0000-4000-8000-000000000001';
const REPLACEMENT_PAIRING_ID = '00000000-0000-4000-8000-000000000002';
const LOOPBACK_SERVER_URL = 'http://127.0.0.1:3000';

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function makeChrome(storageData = {}) {
  const data = { serverUrl: BASE_URL, ...storageData };
  const calls = { set: [], remove: [], alarms: [], cleared: [] };
  return {
    data,
    calls,
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, data[key]]));
        },
        async set(value) { Object.assign(data, value); calls.set.push(value); },
        async remove(keys) {
          for (const key of (Array.isArray(keys) ? keys : [keys])) delete data[key];
          calls.remove.push(Array.isArray(keys) ? keys : [keys]);
        },
      },
    },
    alarms: {
      create(name, info) { calls.alarms.push({ name, info }); },
      clear(name) { calls.cleared.push(name); },
    },
  };
}

function scheduler() {
  const intervals = new Map();
  return {
    intervals,
    setInterval(fn, delay) { const id = intervals.size + 1; intervals.set(id, { fn, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
  };
}

test('a new installation saves the loopback server URL and creates exactly one pairing on explicit request', async () => {
  const chromeApi = makeChrome({
    serverUrl: '',
    token: 'old-device-token',
    expiresAt: Date.now() + 60_000,
    remoteLoginEnabled: true,
    browserCommandDeviceId: DEVICE_ID,
    extensionDeviceId: DEVICE_ID,
    extensionPairingId: PAIRING_ID,
    extensionPairingSecret: EXCHANGE_SECRET,
    extensionPairingBlockedCode: 'DEVICE_REVOKED',
  });
  const calls = [];
  const pairer = createExtensionPairer({
    chromeApi,
    scheduler: scheduler(),
    randomUuid: () => REPAIRED_DEVICE_ID,
    randomSecret: () => EXCHANGE_SECRET,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return response({ pairing: { id: PAIRING_ID, verificationCode: '123456', status: 'pending', expiresAt: '2026-08-07T00:05:00.000Z' } }, 201);
    },
  });

  const result = await pairer.requestPairing({ serverUrl: `${LOOPBACK_SERVER_URL}/` });

  assert.equal(result.status, 'awaiting_approval');
  assert.equal(chromeApi.data.serverUrl, LOOPBACK_SERVER_URL);
  assert.equal(chromeApi.data.token, undefined);
  assert.equal(chromeApi.data.expiresAt, undefined);
  assert.equal(chromeApi.data.browserCommandDeviceId, undefined);
  assert.equal(chromeApi.data.extensionDeviceId, REPAIRED_DEVICE_ID);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${LOOPBACK_SERVER_URL}/api/v1/auth/extension-pairings`);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    deviceId: REPAIRED_DEVICE_ID,
    label: 'Edge extension',
    exchangeSecret: EXCHANGE_SECRET,
  });
  assert.equal(calls[0].init.body.includes('old-device-token'), false);
});

test('switching the server discards an old in-flight exchange before it can restore a token', async () => {
  const chromeApi = makeChrome({
    serverUrl: BASE_URL,
    extensionDeviceId: DEVICE_ID,
    extensionPairingId: PAIRING_ID,
    extensionPairingSecret: EXCHANGE_SECRET,
    extensionPairingVerificationCode: '123456',
  });
  const calls = [];
  let resolveOldExchange;
  const pairer = createExtensionPairer({
    chromeApi,
    scheduler: scheduler(),
    randomUuid: () => REPAIRED_DEVICE_ID,
    randomSecret: () => EXCHANGE_SECRET,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith(`/auth/extension-pairings/${PAIRING_ID}/exchange`)) {
        return new Promise((resolve) => { resolveOldExchange = resolve; });
      }
      if (String(url).endsWith('/auth/extension-pairings')) {
        return response({ pairing: {
          id: REPLACEMENT_PAIRING_ID,
          verificationCode: '654321',
          status: 'pending',
          expiresAt: '2026-08-07T00:05:00.000Z',
        } }, 201);
      }
      throw new Error(`unexpected request ${url}`);
    },
  });

  const oldPoll = pairer.pollOnce();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(typeof resolveOldExchange, 'function');

  const reconfigured = pairer.requestPairing({ serverUrl: LOOPBACK_SERVER_URL });
  await new Promise((resolve) => setTimeout(resolve, 0));
  resolveOldExchange(response({ token: 'old-device-token', expiresAt: '2026-09-06T00:00:00.000Z' }));

  await oldPoll;
  const result = await reconfigured;
  assert.equal(result.status, 'awaiting_approval');
  assert.equal(chromeApi.data.serverUrl, LOOPBACK_SERVER_URL);
  assert.equal(chromeApi.data.token, undefined);
  assert.equal(chromeApi.data.browserCommandDeviceId, undefined);
  assert.equal(chromeApi.data.extensionDeviceId, REPAIRED_DEVICE_ID);
  assert.equal(chromeApi.data.extensionPairingId, REPLACEMENT_PAIRING_ID);
  assert.equal(calls.filter(({ url }) => url.endsWith('/auth/extension-pairings')).length, 1);
});

test('extension creates a one-time pairing without a server password and exchanges it once after approval', async () => {
  const chromeApi = makeChrome();
  const calls = [];
  let exchangeCount = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/auth/extension-pairings')) {
      return response({ pairing: { id: PAIRING_ID, verificationCode: '123456', status: 'pending', expiresAt: '2026-08-07T00:05:00.000Z' } }, 201);
    }
    if (String(url).endsWith(`/auth/extension-pairings/${PAIRING_ID}/exchange`)) {
      exchangeCount += 1;
      if (exchangeCount === 1) return response({ error: { code: 'PAIRING_PENDING' } }, 409);
      return response({ token: 'device-token', expiresAt: '2026-09-06T00:00:00.000Z', device: { id: 'device-record' } });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const pairer = createExtensionPairer({
    chromeApi,
    fetchImpl,
    scheduler: scheduler(),
    randomUuid: () => DEVICE_ID,
    randomSecret: () => EXCHANGE_SECRET,
  });

  const requested = await pairer.start({ immediate: false });
  assert.equal(requested.status, 'awaiting_approval');
  assert.equal(chromeApi.data.extensionDeviceId, DEVICE_ID);
  assert.equal(chromeApi.data.extensionPairingId, PAIRING_ID);
  assert.equal(chromeApi.data.extensionPairingSecret, EXCHANGE_SECRET);
  assert.equal(JSON.stringify(chromeApi.calls.set).includes('server password'), false);
  assert.deepEqual(chromeApi.calls.alarms, [{ name: EXTENSION_PAIRING_ALARM_NAME, info: { periodInMinutes: 1 } }]);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    deviceId: DEVICE_ID,
    label: 'Edge extension',
    exchangeSecret: EXCHANGE_SECRET,
  });

  const waiting = await pairer.pollOnce();
  assert.equal(waiting.status, 'awaiting_approval');
  assert.equal(pairer.getStatus().verificationCode, '123456');

  const authorized = await pairer.pollOnce();
  assert.equal(authorized.status, 'authorized');
  assert.equal(chromeApi.data.token, 'device-token');
  assert.equal(chromeApi.data.remoteLoginEnabled, true);
  assert.equal(chromeApi.data.browserCommandDeviceId, DEVICE_ID);
  assert.equal(chromeApi.data.extensionPairingId, undefined);
  assert.equal(chromeApi.data.extensionPairingSecret, undefined);
  assert.deepEqual(chromeApi.calls.remove, [[
    'extensionPairingId',
    'extensionPairingSecret',
    'extensionPairingVerificationCode',
    'extensionPairingExpiresAt',
  ]]);
});

test('extension pairing survives a service-worker restart without losing the administrator verification code', async () => {
  const chromeApi = makeChrome();
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/auth/extension-pairings')) {
      return response({ pairing: { id: PAIRING_ID, verificationCode: '123456', status: 'pending', expiresAt: '2026-08-07T00:05:00.000Z' } }, 201);
    }
    if (String(url).endsWith(`/auth/extension-pairings/${PAIRING_ID}/exchange`)) {
      return response({ error: { code: 'PAIRING_PENDING' } }, 409);
    }
    throw new Error(`unexpected request ${url}`);
  };
  const firstWorker = createExtensionPairer({
    chromeApi,
    fetchImpl,
    scheduler: scheduler(),
    randomUuid: () => DEVICE_ID,
    randomSecret: () => EXCHANGE_SECRET,
  });
  await firstWorker.start({ immediate: false });

  const restartedWorker = createExtensionPairer({ chromeApi, fetchImpl, scheduler: scheduler() });
  const status = await restartedWorker.start({ immediate: false });

  assert.equal(status.status, 'awaiting_approval');
  assert.equal(status.verificationCode, '123456');
  assert.equal(status.expiresAt, '2026-08-07T00:05:00.000Z');
  assert.equal(chromeApi.data.extensionPairingVerificationCode, '123456');
  assert.equal(chromeApi.data.extensionPairingExpiresAt, '2026-08-07T00:05:00.000Z');
});

test('extension pairing does not expose a token on rejected exchange and reports a safe status', async () => {
  const chromeApi = makeChrome({ extensionDeviceId: DEVICE_ID, extensionPairingId: PAIRING_ID, extensionPairingSecret: EXCHANGE_SECRET });
  const fetchImpl = async (url) => {
    if (String(url).endsWith(`/auth/extension-pairings/${PAIRING_ID}/exchange`)) {
      return response({ error: { code: 'DEVICE_REVOKED' } }, 409);
    }
    throw new Error(`unexpected request ${url}`);
  };
  const pairer = createExtensionPairer({ chromeApi, fetchImpl, scheduler: scheduler() });
  const result = await pairer.pollOnce();
  assert.equal(result.status, 'rejected');
  assert.equal(result.code, 'DEVICE_REVOKED');
  assert.equal(chromeApi.data.token, undefined);
  assert.equal(pairer.getStatus().verificationCode, null);
});

test('a revoked device does not retry automatically and only an explicit new request rotates its device id', async () => {
  const chromeApi = makeChrome({ extensionDeviceId: DEVICE_ID, extensionPairingId: PAIRING_ID, extensionPairingSecret: EXCHANGE_SECRET });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith(`/auth/extension-pairings/${PAIRING_ID}/exchange`)) {
      return response({ error: { code: 'DEVICE_REVOKED' } }, 409);
    }
    if (String(url).endsWith('/auth/extension-pairings')) {
      return response({ pairing: { id: PAIRING_ID, verificationCode: '654321', status: 'pending', expiresAt: '2026-08-07T00:05:00.000Z' } }, 201);
    }
    throw new Error(`unexpected request ${url}`);
  };
  const pairer = createExtensionPairer({
    chromeApi,
    fetchImpl,
    scheduler: scheduler(),
    randomUuid: () => REPAIRED_DEVICE_ID,
    randomSecret: () => EXCHANGE_SECRET,
  });

  assert.equal((await pairer.pollOnce()).code, 'DEVICE_REVOKED');
  assert.equal(chromeApi.data.extensionDeviceId, DEVICE_ID);
  assert.equal((await pairer.pollOnce()).code, 'DEVICE_REVOKED');
  assert.equal(calls.length, 1);

  const replacement = await pairer.requestPairing();
  assert.equal(replacement.status, 'awaiting_approval');
  assert.equal(chromeApi.data.extensionDeviceId, REPAIRED_DEVICE_ID);
  assert.equal(JSON.parse(calls.at(-1).init.body).deviceId, REPAIRED_DEVICE_ID);
});

test('disabling backend authorization clears the device token and stops pairing polling', async () => {
  const chromeApi = makeChrome({
    token: 'device-token',
    expiresAt: Date.now() + 60_000,
    remoteLoginEnabled: true,
    browserCommandDeviceId: DEVICE_ID,
    extensionPairingId: PAIRING_ID,
    extensionPairingSecret: EXCHANGE_SECRET,
    extensionPairingVerificationCode: '123456',
    extensionPairingExpiresAt: '2026-08-07T00:05:00.000Z',
  });
  const timers = scheduler();
  const pairer = createExtensionPairer({ chromeApi, scheduler: timers });
  await pairer.start({ immediate: false });

  assert.deepEqual(await pairer.disable(), { ok: true });
  assert.equal(chromeApi.data.token, undefined);
  assert.equal(chromeApi.data.expiresAt, undefined);
  assert.equal(chromeApi.data.browserCommandDeviceId, undefined);
  assert.equal(chromeApi.data.remoteLoginEnabled, false);
  assert.equal(chromeApi.data.extensionPairingId, undefined);
  assert.equal(timers.intervals.size, 0);
  assert.equal(pairer.getStatus().status, 'stopped');
});
