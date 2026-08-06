import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { buildApp, loadConfig } from '../src/app.ts';
import { hashPassword } from '../src/auth/password.ts';
import { MemoryAuthRepository } from '../src/auth/memory-repository.ts';
import { MemoryCaseRepository } from '../src/cases/memory-repository.ts';
import { MemoryPlatformAccountRepository } from '../src/platform-accounts/memory-repository.ts';
import { MemoryReportExportRepository } from '../src/report-exports/memory-repository.ts';
import { REPORT_EXPORT_CONTENT_TYPE } from '../src/report-exports/types.ts';
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

function reportExportRecord(id, createdBy, fileName, byteSize, createdAt) {
  const timestamp = new Date(createdAt);
  return {
    id,
    fileName,
    objectKey: `report-exports/${id}.xlsx`,
    contentType: REPORT_EXPORT_CONTENT_TYPE,
    byteSize,
    sha256: id.replaceAll('-', '').padEnd(64, 'a').slice(0, 64),
    createdBy,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function cookieHeader(response) {
  const value = response.headers['set-cookie'];
  const first = Array.isArray(value) ? value[0] : value;
  assert.ok(first, 'expected admin session cookie');
  return first.split(';', 1)[0];
}

async function makeApp(reportExports = []) {
  const adminHash = await hashPassword(ADMIN_PASSWORD);
  const workerHash = await hashPassword(WORKER_PASSWORD);
  const authRepository = new MemoryAuthRepository([
    userRecord(ADMIN_ID, 'admin', 'admin', adminHash),
    userRecord(WORKER_ID, 'worker', 'user', workerHash),
  ]);
  const storageBackend = new MemoryStorageBackend();
  const reportExportRepository = new MemoryReportExportRepository(reportExports);
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
    reportExportRepository,
    screenshotRepository: new MemoryScreenshotRepository(),
    storageBackend,
  });
  await app.ready();
  return { app, authRepository, reportExportRepository, storageBackend };
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
    const root = await app.inject({ method: 'GET', url: '/' });
    assert.equal(root.statusCode, 302);
    assert.equal(root.headers.location, '/admin/browser-control');

    const adminRoot = await app.inject({ method: 'GET', url: '/admin' });
    assert.equal(adminRoot.statusCode, 302);
    assert.equal(adminRoot.headers.location, '/admin/browser-control');

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

    const browserControl = await app.inject({
      method: 'GET',
      url: '/admin/browser-control',
      headers: { cookie: admin.cookie },
    });
    assert.equal(browserControl.statusCode, 200);
    assert.match(browserControl.body, /data-page="browser-control"/);
    assert.match(browserControl.body, /id="browser-command-form"/);
    assert.match(browserControl.body, /id="platform-login-form"/);
    assert.match(browserControl.body, /id="platform-credential-show"/);
    assert.match(browserControl.body, /id="current-backoffice-user"/);
    assert.match(browserControl.body, /id="import-batch-form"/);
    assert.match(browserControl.body, /id="browser-command-rows"/);
    assert.match(browserControl.body, /浏览器连接/);
    assert.match(browserControl.body, /法院标签页/);
    assert.match(browserControl.body, /未确认/);
    const browserControlScript = await app.inject({ method: 'GET', url: '/admin/assets/admin.js' });
    assert.match(browserControlScript.body, /\/browser-commands/);
    assert.match(browserControlScript.body, /\/import-batches/);
    assert.match(browserControlScript.body, /visibilitychange/);
    assert.match(browserControlScript.body, /window\.location\.assign\('\/admin\/browser-control'\)/);

    const workerCases = await app.inject({
      method: 'GET',
      url: '/admin/cases',
      headers: { cookie: worker.cookie },
    });
    assert.equal(workerCases.statusCode, 200);
    assert.match(workerCases.body, /data-page="cases"/);
    assert.doesNotMatch(workerCases.body, /\/admin\/users/);
    assert.doesNotMatch(workerCases.body, /\/admin\/platform-accounts/);

    const workerBrowserControl = await app.inject({
      method: 'GET',
      url: '/admin/browser-control',
      headers: { cookie: worker.cookie },
    });
    assert.equal(workerBrowserControl.statusCode, 200);
    assert.match(workerBrowserControl.body, /data-page="browser-control"/);

    const platformAccounts = await app.inject({
      method: 'GET',
      url: '/admin/platform-accounts',
      headers: { cookie: admin.cookie },
    });
    assert.equal(platformAccounts.statusCode, 200);
    assert.doesNotMatch(platformAccounts.body, /远程登录|登录指令/);
    assert.doesNotMatch(browserControlScript.body, /data-action=["']remote-login|loadLoginCommands/);

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

test('browser control renders full session and creator names, separates LOGIN, and reveals credentials on demand', async () => {
  const { app } = await makeApp();
  try {
    const admin = await login(app, 'admin', ADMIN_PASSWORD);
    const worker = await login(app, 'worker', WORKER_PASSWORD);
    const script = await app.inject({ method: 'GET', url: '/admin/assets/admin.js' });

    const sessions = [
      { cookie: admin.cookie, id: ADMIN_ID, username: 'admin-console-full', role: 'admin', creatorId: WORKER_ID, creatorName: 'worker-creator-full' },
      { cookie: worker.cookie, id: WORKER_ID, username: 'worker-console-full', role: 'user', creatorId: WORKER_ID, creatorName: 'worker-console-full' },
    ];

    for (const session of sessions) {
      const page = await app.inject({
        method: 'GET',
        url: '/admin/browser-control',
        headers: { cookie: session.cookie },
      });
      const dom = new JSDOM(page.body, {
        runScripts: 'outside-only',
        url: 'https://admin.example.test/admin/browser-control',
      });
      try {
      const requests = [];
      let commands = [{
        id: '00000000-0000-0000-0000-000000000301',
        type: 'QUERY_LI',
        status: 'succeeded',
        platformAccountId: ACCOUNT_ID,
        clientBatchId: null,
        requestedBy: session.creatorId,
        resultCode: 'SUCCESS',
        resultSummary: '',
        progress: 100,
        createdAt: NOW.toISOString(),
      }];
      const jsonResponse = (body, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get() { return null; } },
        async json() { return body; },
      });
      dom.window.Headers = Headers;
      dom.window.fetch = async (input, options = {}) => {
        const requestUrl = new URL(String(input), dom.window.location.href);
        const method = String(options.method || 'GET').toUpperCase();
        requests.push({ method, path: requestUrl.pathname + requestUrl.search, body: options.body });
        if (requestUrl.pathname === '/api/v1/auth/me') {
          return jsonResponse({ id: session.id, username: session.username, role: session.role, csrfToken: 'ui-csrf' });
        }
        if (requestUrl.pathname === '/api/v1/users') {
          assert.equal(session.role, 'admin');
          return jsonResponse({ users: [{ id: WORKER_ID, username: session.creatorName, role: 'user', enabled: true }] });
        }
        if (requestUrl.pathname === '/api/v1/platform-accounts') {
          return jsonResponse({ platformAccounts: [{ id: ACCOUNT_ID, label: 'synthetic-account', enabled: true }] });
        }
        if (requestUrl.pathname === `/api/v1/platform-accounts/${ACCOUNT_ID}/credential-view`) {
          return jsonResponse({ account: 'synthetic-view-account', password: 'synthetic-view-password' });
        }
        if (requestUrl.pathname === '/api/v1/import-batches') {
          return jsonResponse({ importBatches: [], nextCursor: null });
        }
        if (requestUrl.pathname === '/api/v1/auth/extension-pairings') return jsonResponse({ pairings: [] });
        if (requestUrl.pathname === '/api/v1/auth/extension-devices') return jsonResponse({ devices: [] });
        if (requestUrl.pathname === '/api/v1/browser-commands' && method === 'POST') {
          const payload = JSON.parse(String(options.body));
          commands = [{ ...commands[0], id: '00000000-0000-0000-0000-000000000302', ...payload, requestedBy: session.id, status: 'pending' }, ...commands];
          return jsonResponse({ command: commands[0] }, 201);
        }
        if (requestUrl.pathname === '/api/v1/browser-commands') {
          return jsonResponse({ commands, nextCursor: null });
        }
        throw new Error(`unexpected request ${method} ${requestUrl.pathname}`);
      };
      dom.window.eval(script.body);
      dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));

      const waitFor = async (predicate) => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        assert.fail('timed out waiting for browser control UI');
      };
      await waitFor(() => dom.window.document.querySelector('[data-command-creator]')?.textContent === session.creatorName);
      assert.equal(dom.window.document.querySelector('#current-backoffice-user').textContent, session.username);
      assert.equal(dom.window.document.querySelector('[data-command-creator]').textContent, session.creatorName);
      assert.doesNotMatch(dom.window.document.body.textContent, /a\*\*\*l|w\*\*\*r/);

      const taskTypes = [...dom.window.document.querySelector('#browser-command-type').options].map((option) => option.value);
      assert.deepEqual(taskTypes, ['QUERY_LI', 'QUERY_QZ', 'EXPORT_REPORT']);

      await waitFor(() => dom.window.document.querySelector('#platform-login-account').value === ACCOUNT_ID);
      dom.window.document.querySelector('#platform-login-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await waitFor(() => requests.some((request) => request.method === 'POST' && request.path === '/api/v1/browser-commands'));
      const loginRequest = requests.find((request) => request.method === 'POST' && request.path === '/api/v1/browser-commands');
      assert.deepEqual(JSON.parse(String(loginRequest.body)), { type: 'LOGIN', platformAccountId: ACCOUNT_ID });

      await waitFor(() => dom.window.document.querySelector('#platform-credential-show').disabled === false);
      dom.window.document.querySelector('#platform-credential-show').click();
      await waitFor(() => dom.window.document.querySelector('#platform-credential-password').textContent === 'synthetic-view-password');
      assert.equal(dom.window.document.querySelector('#platform-credential-account').textContent, 'synthetic-view-account');

      dom.window.document.querySelector('#platform-login-account').dispatchEvent(new dom.window.Event('change'));
      assert.equal(dom.window.document.querySelector('#platform-credential-account').textContent, '');
      assert.equal(dom.window.document.querySelector('#platform-credential-password').textContent, '');

      dom.window.document.querySelector('#platform-credential-show').click();
      await waitFor(() => dom.window.document.querySelector('#platform-credential-password').textContent === 'synthetic-view-password');
      dom.window.dispatchEvent(new dom.window.Event('pagehide'));
      assert.equal(dom.window.document.querySelector('#platform-credential-account').textContent, '');
      assert.equal(dom.window.document.querySelector('#platform-credential-password').textContent, '');

      } finally {
        dom.window.close();
      }
    }
  } finally {
    await app.close();
  }
});

test('report export page is available to both roles and supports filtered listing, download, and deletion', async () => {
  const adminExport = reportExportRecord(
    '00000000-0000-0000-0000-000000000201',
    ADMIN_ID,
    'admin-report.xlsx',
    2048,
    '2026-08-30T10:00:00.000Z',
  );
  const workerExport = reportExportRecord(
    '00000000-0000-0000-0000-000000000202',
    WORKER_ID,
    'worker-report.xlsx',
    3 * 1024 * 1024,
    '2026-08-29T10:00:00.000Z',
  );
  const otherExport = reportExportRecord(
    '00000000-0000-0000-0000-000000000203',
    '00000000-0000-0000-0000-000000000003',
    'other-report.xlsx',
    1024,
    '2026-08-28T10:00:00.000Z',
  );
  const { app, storageBackend } = await makeApp([adminExport, workerExport, otherExport]);
  await storageBackend.put(
    workerExport.objectKey,
    Buffer.alloc(workerExport.byteSize, 0x58),
    workerExport.contentType,
  );

  try {
    const anonymous = await app.inject({ method: 'GET', url: '/admin/report-exports' });
    assert.equal(anonymous.statusCode, 302);
    assert.equal(anonymous.headers.location, '/admin/login');

    const admin = await login(app, 'admin', ADMIN_PASSWORD);
    const worker = await login(app, 'worker', WORKER_PASSWORD);
    const adminPage = await app.inject({
      method: 'GET',
      url: '/admin/report-exports',
      headers: { cookie: admin.cookie },
    });
    assert.equal(adminPage.statusCode, 200);
    assert.match(adminPage.body, /data-page="report-exports"/);
    assert.match(adminPage.body, /href="\/admin\/report-exports"[^>]*aria-current="page"/);
    assert.match(adminPage.body, /<th>导出人<\/th>/);

    const workerPage = await app.inject({
      method: 'GET',
      url: '/admin/report-exports',
      headers: { cookie: worker.cookie },
    });
    assert.equal(workerPage.statusCode, 200);
    assert.match(workerPage.body, /data-page="report-exports"/);
    assert.doesNotMatch(workerPage.body, /<th>导出人<\/th>/);
    assert.match(workerPage.body, /报表导出/);

    const adminList = await app.inject({
      method: 'GET',
      url: '/api/v1/report-exports?limit=200',
      headers: { cookie: admin.cookie },
    });
    assert.equal(adminList.statusCode, 200);
    assert.equal(adminList.json().reportExports.length, 3);

    const workerList = await app.inject({
      method: 'GET',
      url: '/api/v1/report-exports?limit=200',
      headers: { cookie: worker.cookie },
    });
    assert.equal(workerList.statusCode, 200);
    assert.deepEqual(workerList.json().reportExports.map((item) => item.id), [workerExport.id]);

    const downloaded = await app.inject({
      method: 'GET',
      url: `/api/v1/report-exports/${workerExport.id}/download`,
      headers: { cookie: worker.cookie },
    });
    assert.equal(downloaded.statusCode, 200);
    assert.equal(downloaded.rawPayload.length, workerExport.byteSize);
    assert.equal(downloaded.headers['x-content-sha256'], workerExport.sha256);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/report-exports/${workerExport.id}`,
      headers: {
        cookie: worker.cookie,
        origin: 'https://admin.example.test',
        'x-csrf-token': worker.csrfToken,
      },
    });
    assert.equal(deleted.statusCode, 204);

    const script = await app.inject({ method: 'GET', url: '/admin/assets/admin.js' });
    assert.equal(script.statusCode, 200);
    const dom = new JSDOM(adminPage.body, {
      runScripts: 'outside-only',
      url: 'https://admin.example.test/admin/report-exports',
    });
    const requests = [];
    let visibleExports = [adminExport, workerExport].map((value) => ({
      id: value.id,
      fileName: value.fileName,
      byteSize: value.byteSize,
      sha256: value.sha256,
      createdAt: value.createdAt.toISOString(),
      createdBy: value.createdBy,
    }));
    const jsonResponse = (body, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get() { return null; } },
      async json() { return body; },
    });
    dom.window.Headers = Headers;
    dom.window.fetch = async (input, options = {}) => {
      const requestUrl = new URL(String(input), dom.window.location.href);
      const method = String(options.method || 'GET').toUpperCase();
      requests.push({ method, path: requestUrl.pathname + requestUrl.search });
      if (requestUrl.pathname === '/api/v1/auth/me') return jsonResponse({ csrfToken: 'ui-csrf' });
      if (requestUrl.pathname === '/api/v1/users') {
        return jsonResponse({ users: [
          { id: ADMIN_ID, username: 'admin-user-3', role: 'admin', enabled: true },
          { id: WORKER_ID, username: 'worker', role: 'user', enabled: true },
        ] });
      }
      if (requestUrl.pathname === '/api/v1/report-exports' && method === 'GET') {
        return jsonResponse({ reportExports: visibleExports, nextCursor: null });
      }
      if (requestUrl.pathname.endsWith('/download')) {
        return {
          ok: true,
          status: 200,
          headers: { get(name) {
            return name.toLowerCase() === 'content-disposition'
              ? `attachment; filename*=UTF-8''${encodeURIComponent(adminExport.fileName)}`
              : null;
          } },
          async blob() { return new dom.window.Blob(['fixture']); },
        };
      }
      if (requestUrl.pathname.startsWith('/api/v1/report-exports/') && method === 'DELETE') {
        const id = decodeURIComponent(requestUrl.pathname.split('/').pop());
        visibleExports = visibleExports.filter((value) => value.id !== id);
        return jsonResponse(null, 204);
      }
      throw new Error(`unexpected request ${method} ${requestUrl.pathname}`);
    };
    dom.window.confirm = () => true;
    dom.window.URL.createObjectURL = () => 'blob:report-export';
    dom.window.URL.revokeObjectURL = () => {};
    dom.window.HTMLAnchorElement.prototype.click = function click() {
      this.dataset.clicked = 'true';
    };
    dom.window.eval(script.body);

    const waitFor = async (predicate) => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.fail('timed out waiting for report export UI');
    };
    await waitFor(() => dom.window.document.querySelectorAll('#report-export-rows tr').length === 2);
    const rows = dom.window.document.querySelectorAll('#report-export-rows tr');
    assert.equal(rows[0].children[0].textContent, adminExport.fileName);
    assert.equal(rows[0].children[1].textContent, '2.0 KB');
    assert.equal(rows[0].children[2].textContent, adminExport.sha256.slice(0, 8));
    assert.equal(rows[0].children[3].textContent, 'a***3');
    assert.doesNotMatch(dom.window.document.querySelector('.data-table').textContent, /admin-user-3/);

    const downloadButton = rows[0].querySelector('[data-action="download-report-export"]');
    downloadButton.click();
    await waitFor(() => requests.some((request) => request.path.endsWith(`/report-exports/${adminExport.id}/download`)));

    const deleteButton = dom.window.document.querySelector(
      `[data-action="delete-report-export"][data-id="${workerExport.id}"]`,
    );
    deleteButton.click();
    await waitFor(() => dom.window.document.querySelectorAll('#report-export-rows tr').length === 1);
    assert.ok(requests.some((request) => request.method === 'DELETE' && request.path.endsWith(workerExport.id)));
    dom.window.close();
  } finally {
    await app.close();
  }
});

test('report export page appends cursor pages and hides the load-more button at the end', async () => {
  const firstExport = reportExportRecord(
    'report-page-001',
    ADMIN_ID,
    'first-page.xlsx',
    1024,
    '2026-08-30T10:00:00.000Z',
  );
  const secondExport = reportExportRecord(
    'report-page-002',
    ADMIN_ID,
    'second-page.xlsx',
    2048,
    '2026-08-29T10:00:00.000Z',
  );
  const { app } = await makeApp();

  try {
    const admin = await login(app, 'admin', ADMIN_PASSWORD);
    const page = await app.inject({
      method: 'GET',
      url: '/admin/report-exports',
      headers: { cookie: admin.cookie },
    });
    const script = await app.inject({ method: 'GET', url: '/admin/assets/admin.js' });
    const dom = new JSDOM(page.body, {
      runScripts: 'outside-only',
      url: 'https://admin.example.test/admin/report-exports',
    });
    const requests = [];
    const jsonResponse = (body, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get() { return null; } },
      async json() { return body; },
    });
    dom.window.Headers = Headers;
    dom.window.fetch = async (input, options = {}) => {
      const requestUrl = new URL(String(input), dom.window.location.href);
      const method = String(options.method || 'GET').toUpperCase();
      requests.push({ method, path: requestUrl.pathname + requestUrl.search });
      if (requestUrl.pathname === '/api/v1/auth/me') return jsonResponse({ csrfToken: 'ui-csrf' });
      if (requestUrl.pathname === '/api/v1/users') {
        return jsonResponse({ users: [{ id: ADMIN_ID, username: 'admin-user-3', role: 'admin', enabled: true }] });
      }
      if (requestUrl.pathname === '/api/v1/report-exports' && method === 'GET') {
        return requestUrl.searchParams.get('cursor') === 'page-two-cursor'
          ? jsonResponse({
            reportExports: [secondExport].map((value) => ({
              id: value.id,
              fileName: value.fileName,
              byteSize: value.byteSize,
              sha256: value.sha256,
              createdAt: value.createdAt.toISOString(),
              createdBy: value.createdBy,
            })),
            nextCursor: null,
          })
          : jsonResponse({
            reportExports: [firstExport].map((value) => ({
              id: value.id,
              fileName: value.fileName,
              byteSize: value.byteSize,
              sha256: value.sha256,
              createdAt: value.createdAt.toISOString(),
              createdBy: value.createdBy,
            })),
            nextCursor: 'page-two-cursor',
          });
      }
      throw new Error(`unexpected request ${method} ${requestUrl.pathname}`);
    };
    dom.window.eval(script.body);

    const waitFor = async (predicate) => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.fail('timed out waiting for paginated report export UI');
    };
    await waitFor(() => dom.window.document.querySelectorAll('#report-export-rows tr').length === 1);
    const next = dom.window.document.querySelector('#report-export-next');
    assert.ok(next);
    assert.equal(next.textContent, '加载更多');
    assert.equal(next.style.display, 'inline-flex');

    next.click();
    await waitFor(() => dom.window.document.querySelectorAll('#report-export-rows tr').length === 2);
    assert.equal(dom.window.document.querySelectorAll('#report-export-rows tr')[1].children[0].textContent, secondExport.fileName);
    assert.equal(next.style.display, 'none');
    assert.ok(requests.some((request) => request.path.includes('cursor=page-two-cursor')));
    dom.window.close();
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
