import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { newDb } from 'pg-mem';

import { buildApp, loadConfig } from '../src/app.ts';
import { hashPassword } from '../src/auth/password.ts';
import { MemoryAuthRepository } from '../src/auth/memory-repository.ts';
import { MemoryPlatformAccountRepository } from '../src/platform-accounts/memory-repository.ts';
import { PgPlatformAccountRepository } from '../src/platform-accounts/repository.ts';
import { runMigrations } from '../src/db/migrator.ts';

const TEST_KEY = Buffer.alloc(32, 17).toString('base64');
const ADMIN_PASSWORD = 'Admin-pass-1';

function config() {
  return loadConfig({
    PORT: '3102',
    DATABASE_URL: 'postgres://test:secret@localhost:5432/court_helper',
    CREDENTIAL_MASTER_KEY: TEST_KEY,
    CORS_EXTENSION_ORIGINS: 'chrome-extension://test-extension',
    CORS_ADMIN_ORIGINS: 'https://admin.example.test',
    OBJECT_STORAGE_ENDPOINT: 'https://cos.example.test',
    OBJECT_STORAGE_BUCKET: 'private-test-bucket',
    ADMIN_INITIAL_PASSWORD: ADMIN_PASSWORD,
  });
}

async function addUser(repository, {
  username,
  password,
  role = 'user',
  enabled = true,
} = {}) {
  return repository.createUser({
    username,
    passwordHash: await hashPassword(password),
    role,
    enabled,
  });
}

async function makeApp() {
  const authRepository = new MemoryAuthRepository();
  const platformAccountRepository = new MemoryPlatformAccountRepository();
  const app = buildApp({
    config: config(),
    dependencies: {
      database: { check: async () => true },
      objectStorage: { check: async () => true },
    },
    authRepository,
    platformAccountRepository,
  });
  await app.ready();
  await addUser(authRepository, {
    username: 'worker',
    password: 'Worker-pass-1',
  });
  return { app, authRepository, platformAccountRepository };
}

function cookieHeader(response) {
  const setCookie = response.headers['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(first);
  return first.split(';', 1)[0];
}

async function loginAdminUi(app, username = 'admin', password = ADMIN_PASSWORD) {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin: 'https://admin.example.test' },
    payload: { username, password, clientType: 'admin_ui' },
  });
  assert.equal(response.statusCode, 200);
  return { cookie: cookieHeader(response), csrfToken: response.json().csrfToken };
}

async function loginAdmin(app) {
  return loginAdminUi(app);
}

async function loginExtension(app, username = 'worker', password = 'Worker-pass-1') {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin: 'chrome-extension://test-extension' },
    payload: { username, password, clientType: 'extension' },
  });
  assert.equal(response.statusCode, 200);
  return response.json().token;
}

function adminHeaders(admin) {
  return {
    cookie: admin.cookie,
    origin: 'https://admin.example.test',
    'x-csrf-token': admin.csrfToken,
  };
}

function tokenFromCookie(cookie) {
  const separator = cookie.indexOf('=');
  assert.notEqual(separator, -1);
  return cookie.slice(separator + 1);
}

function assertCredentialError(response, {
  statusCode,
  code,
  cacheControl,
  credential,
}) {
  assert.equal(response.statusCode, statusCode);
  assert.equal(response.json().error.code, code);
  assert.equal(response.headers['cache-control'], cacheControl);
  assert.equal(response.body.includes(credential.account), false);
  assert.equal(response.body.includes(credential.password), false);
}

test('platform accounts hide credentials, enforce role visibility, and re-encrypt replacements', async () => {
  const { app, platformAccountRepository } = await makeApp();

  try {
    const admin = await loginAdmin(app);
    const created = await app.inject({
      method: 'POST',
      url: '/platform-accounts',
      headers: adminHeaders(admin),
      payload: { label: 'primary', account: 'court-user', password: 'court-pass' },
    });

    assert.equal(created.statusCode, 201);
    assert.deepEqual(Object.keys(created.json()).sort(), ['enabled', 'id', 'label', 'updatedAt']);
    assert.equal(created.body.includes('court-user'), false);
    assert.equal(created.body.includes('court-pass'), false);

    const stored = await platformAccountRepository.findById(created.json().id);
    assert.ok(stored);
    assert.notEqual(stored.secretCiphertext.toString('utf8'), JSON.stringify({ account: 'court-user', password: 'court-pass' }));
    assert.equal(stored.secretIv.length, 12);
    assert.equal(stored.secretTag.length, 16);
    assert.equal(stored.secretVersion, 1);

    const workerToken = await loginExtension(app);
    const workerList = await app.inject({
      method: 'GET',
      url: '/api/v1/platform-accounts',
      headers: { authorization: `Bearer ${workerToken}` },
    });
    assert.equal(workerList.statusCode, 200);
    assert.deepEqual(workerList.json().platformAccounts, [created.json()]);
    assert.equal(workerList.body.includes('court-user'), false);
    assert.equal(workerList.body.includes('court-pass'), false);

    const replacement = await app.inject({
      method: 'PATCH',
      url: `/platform-accounts/${created.json().id}`,
      headers: adminHeaders(admin),
      payload: { account: 'court-user-2', password: 'court-pass-2' },
    });
    assert.equal(replacement.statusCode, 200);
    const adminToken = await loginExtension(app, 'admin', ADMIN_PASSWORD);
    const replacementCredential = await app.inject({
      method: 'POST',
      url: `/api/v1/platform-accounts/${created.json().id}/credential`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(replacementCredential.statusCode, 200);
    assert.deepEqual(replacementCredential.json(), { account: 'court-user-2', password: 'court-pass-2' });
    assert.equal(replacementCredential.headers['cache-control'], 'no-store');

    const replaced = await platformAccountRepository.findById(created.json().id);
    assert.notDeepEqual(replaced.secretIv, stored.secretIv);
  } finally {
    await app.close();
  }
});

test('credential view accepts only admin_ui cookie sessions for admin and user roles', async () => {
  const { app } = await makeApp();

  try {
    const admin = await loginAdmin(app);
    const backOfficeUser = await loginAdminUi(app, 'worker', 'Worker-pass-1');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/platform-accounts',
      headers: adminHeaders(admin),
      payload: { label: 'credential-view', account: 'view-account', password: 'view-password' },
    });
    assert.equal(created.statusCode, 201);

    const adminView = await app.inject({
      method: 'GET',
      url: `/api/v1/platform-accounts/${created.json().id}/credential-view`,
      headers: { cookie: admin.cookie },
    });
    assert.equal(adminView.statusCode, 200);
    assert.deepEqual(adminView.json(), { account: 'view-account', password: 'view-password' });
    assert.equal(adminView.headers['cache-control'], 'private, no-store');

    const userView = await app.inject({
      method: 'GET',
      url: `/api/v1/platform-accounts/${created.json().id}/credential-view`,
      headers: { cookie: backOfficeUser.cookie },
    });
    assert.equal(userView.statusCode, 200);
    assert.deepEqual(userView.json(), { account: 'view-account', password: 'view-password' });
    assert.equal(userView.headers['cache-control'], 'private, no-store');

    const bareView = await app.inject({
      method: 'GET',
      url: `/platform-accounts/${created.json().id}/credential-view`,
      headers: { cookie: admin.cookie },
    });
    assert.equal(bareView.statusCode, 404);
    assert.equal(bareView.json().error.code, 'NOT_FOUND');
    assert.equal(bareView.body.includes('view-account'), false);
    assert.equal(bareView.body.includes('view-password'), false);

    const extensionUserToken = await loginExtension(app);
    const extensionAdminToken = await loginExtension(app, 'admin', ADMIN_PASSWORD);
    for (const authorization of [
      `Bearer ${extensionUserToken}`,
      `Bearer ${extensionAdminToken}`,
      `Bearer ${tokenFromCookie(admin.cookie)}`,
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/platform-accounts/${created.json().id}/credential-view`,
        headers: { authorization },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error.code, 'FORBIDDEN');
    }

    const extensionCookie = await app.inject({
      method: 'GET',
      url: `/api/v1/platform-accounts/${created.json().id}/credential-view`,
      headers: { cookie: `court_helper_session=${extensionUserToken}` },
    });
    assert.equal(extensionCookie.statusCode, 403);
    assert.equal(extensionCookie.json().error.code, 'FORBIDDEN');
  } finally {
    await app.close();
  }
});

test('credential automation endpoint accepts only extension bearer sessions for admin and user roles', async () => {
  const { app } = await makeApp();

  try {
    const admin = await loginAdmin(app);
    const backOfficeUser = await loginAdminUi(app, 'worker', 'Worker-pass-1');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/platform-accounts',
      headers: adminHeaders(admin),
      payload: { label: 'automation-credential', account: 'automation-account', password: 'automation-password' },
    });
    assert.equal(created.statusCode, 201);

    for (const cookie of [admin.cookie, backOfficeUser.cookie]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/platform-accounts/${created.json().id}/credential`,
        headers: { cookie },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error.code, 'FORBIDDEN');
    }

    const extensionUserToken = await loginExtension(app);
    const extensionAdminToken = await loginExtension(app, 'admin', ADMIN_PASSWORD);
    for (const url of [
      `/platform-accounts/${created.json().id}/credential`,
      `/api/v1/platform-accounts/${created.json().id}/credential`,
    ]) {
      for (const token of [extensionUserToken, extensionAdminToken]) {
        const response = await app.inject({
          method: 'POST',
          url,
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json(), { account: 'automation-account', password: 'automation-password' });
        assert.equal(response.headers['cache-control'], 'no-store');
      }
    }

    const extensionCookie = await app.inject({
      method: 'POST',
      url: `/api/v1/platform-accounts/${created.json().id}/credential`,
      headers: { cookie: `court_helper_session=${extensionUserToken}` },
    });
    assert.equal(extensionCookie.statusCode, 403);
    assert.equal(extensionCookie.json().error.code, 'FORBIDDEN');

    const backOfficeBearer = await app.inject({
      method: 'POST',
      url: `/api/v1/platform-accounts/${created.json().id}/credential`,
      headers: { authorization: `Bearer ${tokenFromCookie(admin.cookie)}` },
    });
    assert.equal(backOfficeBearer.statusCode, 403);
    assert.equal(backOfficeBearer.json().error.code, 'FORBIDDEN');
  } finally {
    await app.close();
  }
});

test('credential endpoints report disabled and deleted accounts as non-cacheable ACCOUNT_DISABLED without credentials', async () => {
  const { app } = await makeApp();

  try {
    const admin = await loginAdmin(app);
    const extensionToken = await loginExtension(app);
    const disabledSecret = { account: 'disabled-account', password: 'disabled-password' };
    const disabled = await app.inject({
      method: 'POST',
      url: '/api/v1/platform-accounts',
      headers: adminHeaders(admin),
      payload: { label: 'disabled-credential', ...disabledSecret },
    });
    assert.equal(disabled.statusCode, 201);
    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/v1/platform-accounts/${disabled.json().id}`,
      headers: adminHeaders(admin),
      payload: { enabled: false },
    });
    assert.equal(disable.statusCode, 200);

    const disabledView = await app.inject({
      method: 'GET',
      url: `/api/v1/platform-accounts/${disabled.json().id}/credential-view`,
      headers: { cookie: admin.cookie },
    });
    assertCredentialError(disabledView, {
      statusCode: 409,
      code: 'ACCOUNT_DISABLED',
      cacheControl: 'private, no-store',
      credential: disabledSecret,
    });

    const disabledAutomation = await app.inject({
      method: 'POST',
      url: `/api/v1/platform-accounts/${disabled.json().id}/credential`,
      headers: { authorization: `Bearer ${extensionToken}` },
    });
    assertCredentialError(disabledAutomation, {
      statusCode: 409,
      code: 'ACCOUNT_DISABLED',
      cacheControl: 'no-store',
      credential: disabledSecret,
    });

    const deletedSecret = { account: 'deleted-account', password: 'deleted-password' };
    const deleted = await app.inject({
      method: 'POST',
      url: '/api/v1/platform-accounts',
      headers: adminHeaders(admin),
      payload: { label: 'deleted-credential', ...deletedSecret },
    });
    assert.equal(deleted.statusCode, 201);
    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/v1/platform-accounts/${deleted.json().id}`,
      headers: adminHeaders(admin),
    });
    assert.equal(remove.statusCode, 200);

    const deletedView = await app.inject({
      method: 'GET',
      url: `/api/v1/platform-accounts/${deleted.json().id}/credential-view`,
      headers: { cookie: admin.cookie },
    });
    assertCredentialError(deletedView, {
      statusCode: 409,
      code: 'ACCOUNT_DISABLED',
      cacheControl: 'private, no-store',
      credential: deletedSecret,
    });

    const deletedAutomation = await app.inject({
      method: 'POST',
      url: `/api/v1/platform-accounts/${deleted.json().id}/credential`,
      headers: { authorization: `Bearer ${extensionToken}` },
    });
    assertCredentialError(deletedAutomation, {
      statusCode: 409,
      code: 'ACCOUNT_DISABLED',
      cacheControl: 'no-store',
      credential: deletedSecret,
    });
  } finally {
    await app.close();
  }
});

test('admins see disabled accounts, users do not, and deletion is soft', async () => {
  const { app, platformAccountRepository } = await makeApp();

  try {
    const admin = await loginAdmin(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/platform-accounts',
      headers: adminHeaders(admin),
      payload: { label: 'secondary', account: 'secondary-user', password: 'secondary-pass' },
    });
    assert.equal(created.statusCode, 201);

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/v1/platform-accounts/${created.json().id}`,
      headers: adminHeaders(admin),
      payload: { enabled: false },
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.json().enabled, false);

    const workerToken = await loginExtension(app);
    const workerList = await app.inject({
      method: 'GET',
      url: '/api/v1/platform-accounts',
      headers: { authorization: `Bearer ${workerToken}` },
    });
    assert.equal(workerList.statusCode, 200);
    assert.deepEqual(workerList.json(), { platformAccounts: [] });

    const adminList = await app.inject({
      method: 'GET',
      url: '/api/v1/platform-accounts',
      headers: { cookie: admin.cookie },
    });
    assert.equal(adminList.statusCode, 200);
    assert.equal(adminList.json().platformAccounts[0].enabled, false);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/platform-accounts/${created.json().id}`,
      headers: adminHeaders(admin),
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(removed.json().enabled, false);
    const row = await platformAccountRepository.findById(created.json().id);
    assert.ok(row.deletedAt instanceof Date);
  } finally {
    await app.close();
  }
});

test('credential decryption failures never disclose secrets and are not cacheable', async () => {
  const { app, platformAccountRepository } = await makeApp();

  try {
    const admin = await loginAdmin(app);
    const secret = { account: 'secret-account', password: 'secret-password' };
    const created = await app.inject({
      method: 'POST',
      url: '/platform-accounts',
      headers: adminHeaders(admin),
      payload: { label: 'tamper-test', ...secret },
    });
    const adminToken = await loginExtension(app, 'admin', ADMIN_PASSWORD);

    const stored = await platformAccountRepository.findById(created.json().id);
    stored.secretTag[0] ^= 0xff;
    await platformAccountRepository.update(created.json().id, { secretTag: stored.secretTag });

    const requests = [
      {
        method: 'GET',
        url: `/api/v1/platform-accounts/${created.json().id}/credential-view`,
        headers: { cookie: admin.cookie },
        cacheControl: 'private, no-store',
      },
      {
        method: 'POST',
        url: `/platform-accounts/${created.json().id}/credential`,
        headers: { authorization: `Bearer ${adminToken}` },
        cacheControl: 'no-store',
      },
      {
        method: 'POST',
        url: `/api/v1/platform-accounts/${created.json().id}/credential`,
        headers: { authorization: `Bearer ${adminToken}` },
        cacheControl: 'no-store',
      },
    ];
    for (const request of requests) {
      const response = await app.inject(request);
      assertCredentialError(response, {
        statusCode: 503,
        code: 'CREDENTIAL_UNAVAILABLE',
        cacheControl: request.cacheControl,
        credential: secret,
      });
    }
  } finally {
    await app.close();
  }
});

test('postgres platform-account repository persists encrypted columns and soft deletion', async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();

  try {
    await runMigrations(pool);
    const userId = randomUUID();
    await pool.query(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES ($1, 'admin', 'hash', 'admin')
    `, [userId]);

    const repository = new PgPlatformAccountRepository(pool);
    const now = new Date();
    const created = await repository.create({
      label: 'pg-primary',
      secretCiphertext: Buffer.from('ciphertext'),
      secretIv: Buffer.alloc(12, 1),
      secretTag: Buffer.alloc(16, 2),
      secretVersion: 1,
      enabled: true,
      createdBy: userId,
    });

    assert.equal(created.label, 'pg-primary');
    assert.equal(created.secretCiphertext.toString(), 'ciphertext');
    assert.equal((await repository.list({ includeDeleted: true })).length, 1);
    const removed = await repository.softDelete(created.id);
    assert.equal(removed.enabled, false);
    assert.ok(removed.deletedAt instanceof Date);
    assert.equal((await repository.list({ enabledOnly: true })).length, 0);
    assert.ok(now <= created.createdAt);
  } finally {
    await pool.end();
  }
});
