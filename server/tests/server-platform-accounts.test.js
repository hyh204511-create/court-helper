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

async function loginAdmin(app) {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin: 'https://admin.example.test' },
    payload: { username: 'admin', password: ADMIN_PASSWORD, clientType: 'admin_ui' },
  });
  assert.equal(response.statusCode, 200);
  return { cookie: cookieHeader(response), csrfToken: response.json().csrfToken };
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

test('platform accounts hide credentials, enforce role visibility, and decrypt only for admin sessions', async () => {
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
      url: '/platform-accounts',
      headers: { authorization: `Bearer ${workerToken}` },
    });
    assert.equal(workerList.statusCode, 200);
    assert.deepEqual(workerList.json().platformAccounts, [created.json()]);

    const cookieCredential = await app.inject({
      method: 'POST',
      url: `/platform-accounts/${created.json().id}/credential`,
      headers: { cookie: admin.cookie },
    });
    assert.equal(cookieCredential.statusCode, 200);
    assert.deepEqual(cookieCredential.json(), { account: 'court-user', password: 'court-pass' });

    const credential = await app.inject({
      method: 'POST',
      url: `/platform-accounts/${created.json().id}/credential`,
      headers: { authorization: `Bearer ${workerToken}` },
    });
    assert.equal(credential.statusCode, 403);
    assert.equal(credential.json().error.code, 'FORBIDDEN');

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
      url: `/platform-accounts/${created.json().id}/credential`,
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

test('credential authentication failures and authenticated decryption failures never disclose secrets', async () => {
  const { app, platformAccountRepository } = await makeApp();

  try {
    const admin = await loginAdmin(app);
    const created = await app.inject({
      method: 'POST',
      url: '/platform-accounts',
      headers: adminHeaders(admin),
      payload: { label: 'tamper-test', account: 'secret-account', password: 'secret-password' },
    });
    const adminToken = await loginExtension(app, 'admin', ADMIN_PASSWORD);

    const stored = await platformAccountRepository.findById(created.json().id);
    stored.secretTag[0] ^= 0xff;
    await platformAccountRepository.update(created.json().id, { secretTag: stored.secretTag });

    const response = await app.inject({
      method: 'POST',
      url: `/platform-accounts/${created.json().id}/credential`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'CREDENTIAL_UNAVAILABLE');
    assert.equal(response.body.includes('secret-account'), false);
    assert.equal(response.body.includes('secret-password'), false);
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
