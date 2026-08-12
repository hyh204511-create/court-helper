import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildApp, loadConfig } from '../src/app.ts';
import { MemoryAuthRepository } from '../src/auth/memory-repository.ts';
import { MemoryCaseRepository } from '../src/cases/memory-repository.ts';
import { MemoryPlatformAccountRepository } from '../src/platform-accounts/memory-repository.ts';
import { MemoryScreenshotRepository } from '../src/screenshots/memory-repository.ts';
import { MemoryStorageBackend } from '../src/storage/memory.ts';

const TEST_KEY = Buffer.alloc(32, 41).toString('base64');
const ADMIN_PASSWORD = 'Admin-pass-1';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000010';
const WEBHOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-test-key';
const IMAGE = Buffer.from('synthetic-image-content');

function config(webhookUrl = WEBHOOK) {
  return loadConfig({
    PORT: '3120',
    DATABASE_URL: 'postgres://test:secret@localhost:5432/court_helper',
    CREDENTIAL_MASTER_KEY: TEST_KEY,
    CORS_EXTENSION_ORIGINS: 'chrome-extension://test-extension',
    CORS_ADMIN_ORIGINS: 'https://admin.example.test',
    OBJECT_STORAGE_ENDPOINT: 'https://cos.example.test',
    OBJECT_STORAGE_BUCKET: 'private-test-bucket',
    ADMIN_INITIAL_PASSWORD: ADMIN_PASSWORD,
    ...(webhookUrl == null ? {} : { WECOM_WEBHOOK_URL: webhookUrl }),
  });
}

function cookieHeader(response) {
  const value = response.headers['set-cookie'];
  return (Array.isArray(value) ? value[0] : value).split(';', 1)[0];
}

async function makeApp({ webhookUrl = WEBHOOK, responses = [{ errcode: 0 }, { errcode: 0 }] } = {}) {
  const authRepository = new MemoryAuthRepository();
  const caseRepository = new MemoryCaseRepository();
  const screenshotRepository = new MemoryScreenshotRepository();
  const storageBackend = new MemoryStorageBackend();
  const calls = [];
  const app = buildApp({
    config: config(webhookUrl),
    dependencies: { database: { check: async () => true }, objectStorage: storageBackend },
    authRepository,
    caseRepository,
    screenshotRepository,
    storageBackend,
    platformAccountRepository: new MemoryPlatformAccountRepository(),
    wecomTransport: async (url, payload) => {
      calls.push({ url, payload });
      return responses[calls.length - 1] ?? { errcode: 0 };
    },
  });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin: 'https://admin.example.test' },
    payload: { username: 'admin', password: ADMIN_PASSWORD, clientType: 'admin_ui' },
  });
  assert.equal(login.statusCode, 200);
  const admin = await authRepository.findUserByUsername('admin');
  const caseValue = await caseRepository.create({
    createdBy: admin.id,
    clientUid: 'synthetic-case-1',
    platformAccountId: ACCOUNT_ID,
    kind: 'li',
    plaintiff: '脱敏原告甲',
    defendant: '脱敏被告乙',
    status: '已驳回',
    filedTime: null,
    caseNumber: 'SYNTHETIC-001',
    rejectTime: '2026-08-10',
    rejectReason: '脱敏驳回内容',
    queryTime: new Date('2026-08-10T05:00:00.000Z'),
    needsHuman: false,
    errorCode: null,
    sourceEventId: 'synthetic-event-1',
    sourceUpdatedAt: new Date('2026-08-10T05:00:00.000Z'),
  });
  const screenshot = await screenshotRepository.create({
    caseId: caseValue.id,
    type: 'reject',
    objectKey: 'screenshots/synthetic/reject.png',
    contentType: 'image/png',
    byteSize: IMAGE.length,
    sha256: createHash('sha256').update(IMAGE).digest('hex'),
    capturedAt: new Date('2026-08-10T05:00:00.000Z'),
  });
  await storageBackend.put(screenshot.objectKey, IMAGE, 'image/png');
  return {
    app,
    calls,
    caseId: caseValue.id,
    cookie: cookieHeader(login),
    csrfToken: login.json().csrfToken,
    screenshotRepository,
    storageBackend,
  };
}

function request(appState, overrides = {}) {
  return appState.app.inject({
    method: 'POST',
    url: `/cases/${appState.caseId}/wecom-notifications`,
    headers: {
      origin: 'https://admin.example.test',
      cookie: appState.cookie,
      'x-csrf-token': appState.csrfToken,
    },
    payload: {
      salespersonMobile: '13800138000',
      assistantMobile: '13900139000',
      ...overrides,
    },
  });
}

test('pushes matching evidence image then server-owned result text and mentions both recipients', async () => {
  const state = await makeApp();
  try {
    const response = await request(state, { plaintiff: '客户端伪造原告' });
    assert.equal(response.statusCode, 400, 'unknown client fields must be rejected');

    const delivered = await request(state);
    assert.equal(delivered.statusCode, 200);
    assert.deepEqual(delivered.json(), { delivered: true });
    assert.equal(state.calls.length, 2);
    assert.equal(state.calls[0].url, WEBHOOK);
    assert.deepEqual(state.calls[0].payload, {
      msgtype: 'image',
      image: {
        base64: IMAGE.toString('base64'),
        md5: createHash('md5').update(IMAGE).digest('hex'),
      },
    });
    assert.equal(state.calls[1].payload.msgtype, 'text');
    assert.match(state.calls[1].payload.text.content, /原告：脱敏原告甲/);
    assert.match(state.calls[1].payload.text.content, /被告：脱敏被告乙/);
    assert.match(state.calls[1].payload.text.content, /结果：已驳回/);
    assert.match(state.calls[1].payload.text.content, /相关内容：脱敏驳回内容/);
    assert.doesNotMatch(state.calls[1].payload.text.content, /客户端伪造/);
    assert.deepEqual(state.calls[1].payload.text.mentioned_mobile_list, ['13800138000', '13900139000']);
  } finally {
    await state.app.close();
  }
});

test('requires admin UI cookie, CSRF, valid mobiles, configured webhook, and matching screenshot', async () => {
  const state = await makeApp();
  try {
    const anonymous = await state.app.inject({ method: 'POST', url: `/cases/${state.caseId}/wecom-notifications`, payload: {} });
    assert.equal(anonymous.statusCode, 401);
    const noCsrf = await state.app.inject({
      method: 'POST', url: `/cases/${state.caseId}/wecom-notifications`,
      headers: { origin: 'https://admin.example.test', cookie: state.cookie },
      payload: { salespersonMobile: '13800138000', assistantMobile: '13900139000' },
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal((await request(state, { assistantMobile: '@all' })).statusCode, 400);
    await state.screenshotRepository.delete((await state.screenshotRepository.listByCaseId(state.caseId))[0].id);
    const missing = await request(state);
    assert.equal(missing.statusCode, 409);
    assert.equal(missing.json().error.code, 'WECOM_SCREENSHOT_MISSING');
    assert.equal(state.calls.length, 0);
  } finally {
    await state.app.close();
  }

  const unconfigured = await makeApp({ webhookUrl: null });
  try {
    const response = await request(unconfigured);
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'WECOM_NOT_CONFIGURED');
  } finally {
    await unconfigured.app.close();
  }
});

test('returns a stable redacted error when WeCom rejects delivery', async () => {
  const state = await makeApp({ responses: [{ errcode: 93000, errmsg: 'private upstream response' }] });
  try {
    const response = await request(state);
    assert.equal(response.statusCode, 502);
    const serialized = JSON.stringify(response.json());
    assert.match(serialized, /WECOM_DELIVERY_FAILED/);
    assert.doesNotMatch(serialized, /private upstream response|synthetic-test-key|13800138000|脱敏原告/);
  } finally {
    await state.app.close();
  }
});

test('validates the configured webhook allowlist', () => {
  assert.throws(() => config('https://example.test/cgi-bin/webhook/send?key=x'), /WECOM_WEBHOOK_URL/);
  assert.throws(() => config('http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x'), /WECOM_WEBHOOK_URL/);
  assert.throws(() => config('https://qyapi.weixin.qq.com/cgi-bin/webhook/send'), /WECOM_WEBHOOK_URL/);
});
