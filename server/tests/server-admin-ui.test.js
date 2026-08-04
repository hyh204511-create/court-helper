import test from 'node:test';
import assert from 'node:assert/strict';

import { buildApp, loadConfig } from '../src/app.ts';
import { hashPassword } from '../src/auth/password.ts';
import { MemoryAuthRepository } from '../src/auth/memory-repository.ts';
import { MemoryCaseRepository } from '../src/cases/memory-repository.ts';
import { MemoryPlatformAccountRepository } from '../src/platform-accounts/memory-repository.ts';
import { MemoryScreenshotRepository } from '../src/screenshots/memory-repository.ts';
import { MemoryStorageBackend } from '../src/storage/memory.ts';

const TEST_KEY = Buffer.alloc(32, 37).toString('base64');
const ADMIN_PASSWORD = 'Admin-pass-1';
const WORKER_PASSWORD = 'Worker-pass-1';
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const WORKER_ID = '00000000-0000-0000-0000-000000000002';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000010';
const CASE_ID = '00000000-0000-0000-0000-000000000100';
const NOW = new Date('2026-08-31T12:00:00.000Z');

function config() {
  return loadConfig({
    PORT: '3111',
    DATABASE_URL: 'postgres://test:secret@localhost:5432/court_helper',
    CREDENTIAL_MASTER_KEY: TEST_KEY,
    CORS_EXTENSION_ORIGINS: 'chrome-extension://test-extension',
    CORS_ADMIN_ORIGINS: 'https://admin.example.test',
    OBJECT_STORAGE_ENDPOINT: 'https://cos.example.test',
    OBJECT_STORAGE_BUCKET: 'private-test-bucket',
    ADMIN_INITIAL_PASSWORD: ADMIN_PASSWORD,
  });
}

function userRecord(id, username, role, passwordHash, enabled = true) {
  const createdAt = new Date('2026-08-01T00:00:00.000Z');
  return {
    id,
    username,
    passwordHash,
    role,
    enabled,
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function accountRecord() {
  const createdAt = new Date('2026-08-01T00:00:00.000Z');
  return {
    id: ACCOUNT_ID,
    label: 'synthetic-account',
    secretCiphertext: Buffer.from('ciphertext'),
    secretIv: Buffer.alloc(12, 1),
    secretTag: Buffer.alloc(16, 2),
    secretVersion: 1,
    enabled: true,
    deletedAt: null,
    createdBy: ADMIN_ID,
    createdAt,
    updatedAt: createdAt,
  };
}

function caseRecord() {
  return {
    id: CASE_ID,
    clientUid: 'client-admin-ui',
    platformAccountId: ACCOUNT_ID,
    kind: 'li',
    plaintiff: 'synthetic plaintiff',
    defendant: 'synthetic defendant',
    status: '已驳回',
    filedTime: '2026-08-30',
    caseNumber: 'CASE-ADMIN-UI',
    rejectTime: '2026-08-30',
    rejectReason: '<script>alert("must stay text")</script>',
    queryTime: new Date('2026-08-31T10:00:00.000Z'),
    needsHuman: false,
    errorCode: null,
    sourceEventId: 'event-admin-ui',
    sourceUpdatedAt: new Date('2026-08-31T10:00:00.000Z'),
    revision: 1,
    createdAt: new Date('2026-08-31T10:00:00.000Z'),
    updatedAt: new Date('2026-08-31T10:00:00.000Z'),
  };
}

function cookieHeader(response) {
  const value = response.headers['set-cookie'];
  const first = Array.isArray(value) ? value[0] : value;
  assert.ok(first, 'expected admin session cookie');
  return first.split(';', 1)[0];
}

async function makeApp() {
  const adminHash = await hashPassword(ADMIN_PASSWORD);
  const workerHash = await hashPassword(WORKER_PASSWORD);
  const authRepository = new MemoryAuthRepository([
    userRecord(ADMIN_ID, 'admin', 'admin', adminHash),
    userRecord(WORKER_ID, 'worker', 'user', workerHash),
  ]);
  const app = buildApp({
    config: config(),
    clock: () => new Date(NOW),
    retention: { scheduleDaily: () => () => {} },
    dependencies: {
      database: { check: async () => true },
      objectStorage: { check: async () => true },
    },
    authRepository,
    platformAccountRepository: new MemoryPlatformAccountRepository([accountRecord()]),
    caseRepository: new MemoryCaseRepository([caseRecord()]),
    screenshotRepository: new MemoryScreenshotRepository(),
    storageBackend: new MemoryStorageBackend(),
  });
  await app.ready();
  return { app, authRepository };
}

async function login(app, username, password) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: 'https://admin.example.test' },
    payload: { username, password, clientType: 'admin_ui' },
  });
  assert.equal(response.statusCode, 200);
  return {
    cookie: cookieHeader(response),
    csrfToken: response.json().csrfToken,
    response,
  };
}

test('admin login shell and static assets are same-origin, CSP protected, and REST-only', async () => {
  const { app } = await makeApp();
  try {
    const page = await app.inject({ method: 'GET', url: '/admin/login' });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.match(page.body, /\/admin\/assets\/admin\.css/);
    assert.match(page.body, /\/admin\/assets\/admin\.js/);
    assert.doesNotMatch(page.body, /<script>[^<]/);

    const css = await app.inject({ method: 'GET', url: '/admin/assets/admin.css' });
    assert.equal(css.statusCode, 200);
    assert.match(css.headers['content-type'], /^text\/css/);
    assert.match(css.body, /--ink/);

    const script = await app.inject({ method: 'GET', url: '/admin/assets/admin.js' });
    assert.equal(script.statusCode, 200);
    assert.match(script.headers['content-type'], /^text\/javascript/);
    assert.match(script.body, /const API_BASE = ['"]\/api\/v1['"]/);
    assert.match(script.body, /credentials:\s*['"]same-origin['"]/);
    assert.match(script.body, /账号或密码错误\/账号不可用/);
    assert.match(script.body, /textContent/);
    assert.doesNotMatch(script.body, /innerHTML/);
    assert.doesNotMatch(script.body, /https?:\/\//);
  } finally {
    await app.close();
  }
});

test('admin and user page reachability is role-isolated, while unauthenticated pages redirect', async () => {
  const { app } = await makeApp();
  try {
    const anonymous = await app.inject({ method: 'GET', url: '/admin/cases' });
    assert.equal(anonymous.statusCode, 302);
    assert.equal(anonymous.headers.location, '/admin/login');

    const admin = await login(app, 'admin', ADMIN_PASSWORD);
    const worker = await login(app, 'worker', WORKER_PASSWORD);

    const adminCases = await app.inject({
      method: 'GET',
      url: '/admin/cases',
      headers: { cookie: admin.cookie },
    });
    assert.equal(adminCases.statusCode, 200);
    assert.match(adminCases.body, /data-page="cases"/);
    assert.match(adminCases.body, /\/admin\/users/);
    assert.match(adminCases.body, /\/admin\/platform-accounts/);

    const workerCases = await app.inject({
      method: 'GET',
      url: '/admin/cases',
      headers: { cookie: worker.cookie },
    });
    assert.equal(workerCases.statusCode, 200);
    assert.match(workerCases.body, /data-page="cases"/);
    assert.doesNotMatch(workerCases.body, /\/admin\/users/);
    assert.doesNotMatch(workerCases.body, /\/admin\/platform-accounts/);

    for (const route of ['/admin/users', '/admin/platform-accounts']) {
      const denied = await app.inject({ method: 'GET', url: route, headers: { cookie: worker.cookie } });
      assert.equal(denied.statusCode, 403);
      assert.match(denied.body, /403/);
      assert.match(denied.body, /无权访问/);
    }

    const directApi = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: { cookie: worker.cookie },
    });
    assert.equal(directApi.statusCode, 403);
  } finally {
    await app.close();
  }
});

test('admin management pages expose safe forms without credentials and cases detail stays read-only', async () => {
  const { app } = await makeApp();
  try {
    const admin = await login(app, 'admin', ADMIN_PASSWORD);
    const users = await app.inject({ method: 'GET', url: '/admin/users', headers: { cookie: admin.cookie } });
    assert.equal(users.statusCode, 200);
    assert.match(users.body, /data-page="users"/);
    assert.match(users.body, /autocomplete="new-password"/);
    assert.match(users.body, /重置密码/);
    assert.doesNotMatch(users.body, /Admin-pass-1|Worker-pass-1|passwordHash|password_hash/);

    const accounts = await app.inject({
      method: 'GET',
      url: '/admin/platform-accounts',
      headers: { cookie: admin.cookie },
    });
    assert.equal(accounts.statusCode, 200);
    assert.match(accounts.body, /data-page="platform-accounts"/);
    assert.match(accounts.body, /autocomplete="new-password"/);
    assert.match(accounts.body, /已设置/);
    assert.match(accounts.body, /未设置/);
    assert.doesNotMatch(accounts.body, /ciphertext|Worker-pass-1/);

    const detail = await app.inject({
      method: 'GET',
      url: `/admin/cases/${CASE_ID}`,
      headers: { cookie: admin.cookie },
    });
    assert.equal(detail.statusCode, 200);
    assert.match(detail.body, /data-page="case-detail"/);
    assert.match(detail.body, new RegExp(`data-case-id="${CASE_ID}"`));
    assert.doesNotMatch(detail.body, /private-test-bucket|object_key|objectKey/);
    assert.doesNotMatch(detail.body, /must stay text/);
    assert.match(detail.body, /截图/);
  } finally {
    await app.close();
  }
});

test('case UI assets implement visible-only 4-second polling, retry messaging, and safe screenshot URLs', async () => {
  const { app } = await makeApp();
  try {
    const script = await app.inject({ method: 'GET', url: '/admin/assets/admin.js' });
    assert.equal(script.statusCode, 200);
    assert.match(script.body, /setInterval\(loadCases, 4000\)/);
    assert.match(script.body, /visibilitychange/);
    assert.match(script.body, /document\.visibilityState/);
    assert.match(script.body, /服务器不可达，请重试/);
    assert.match(script.body, /手动重试/);
    assert.match(script.body, /screenshots/);
    assert.match(script.body, /screenshot\.id/);
    assert.match(script.body, /download/);
    assert.doesNotMatch(script.body, /objectKey|bucket|signature|presign/i);
  } finally {
    await app.close();
  }
});
