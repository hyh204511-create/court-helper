import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { newDb } from 'pg-mem';

import { buildApp, loadConfig } from '../src/app.ts';
import { hashPassword } from '../src/auth/password.ts';
import { MemoryAuthRepository } from '../src/auth/memory-repository.ts';
import { MemoryPlatformAccountRepository } from '../src/platform-accounts/memory-repository.ts';
import { runMigrations, rollbackLastMigration } from '../src/db/migrator.ts';
import { LoginCommandService } from '../src/login-commands/service.ts';
import { MemoryLoginCommandRepository } from '../src/login-commands/memory-repository.ts';
import { PgLoginCommandRepository } from '../src/login-commands/repository.ts';

const TEST_KEY = Buffer.alloc(32, 71).toString('base64');
const ADMIN_PASSWORD = 'Admin-pass-1';
const WORKER_PASSWORD = 'Worker-pass-1';
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const WORKER_ID = '00000000-0000-0000-0000-000000000002';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000010';

function config() {
  return loadConfig({
    PORT: '3112',
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

function accountRecord(id = ACCOUNT_ID, label = 'synthetic-account', enabled = true) {
  const createdAt = new Date('2026-08-01T00:00:00.000Z');
  return {
    id,
    label,
    secretCiphertext: Buffer.from('ciphertext'),
    secretIv: Buffer.alloc(12, 1),
    secretTag: Buffer.alloc(16, 2),
    secretVersion: 1,
    enabled,
    deletedAt: null,
    createdBy: ADMIN_ID,
    createdAt,
    updatedAt: createdAt,
  };
}

async function authRepository() {
  return new MemoryAuthRepository([
    userRecord(ADMIN_ID, 'admin', 'admin', await hashPassword(ADMIN_PASSWORD)),
    userRecord(WORKER_ID, 'worker', 'user', await hashPassword(WORKER_PASSWORD)),
  ]);
}

async function makeApp() {
  const auth = await authRepository();
  const platformAccounts = new MemoryPlatformAccountRepository([accountRecord()]);
  const loginCommands = new MemoryLoginCommandRepository(platformAccounts);
  const app = buildApp({
    config: config(),
    dependencies: {
      database: { check: async () => true },
      objectStorage: { check: async () => true },
    },
    authRepository: auth,
    platformAccountRepository: platformAccounts,
    loginCommandRepository: loginCommands,
    clock: () => new Date('2026-08-05T10:00:00.000Z'),
  });
  await app.ready();
  return { app, loginCommands };
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
    url: '/api/v1/auth/login',
    headers: { origin: 'https://admin.example.test' },
    payload: { username: 'admin', password: ADMIN_PASSWORD, clientType: 'admin_ui' },
  });
  assert.equal(response.statusCode, 200);
  return { cookie: cookieHeader(response), csrfToken: response.json().csrfToken };
}

async function loginExtension(app, username = 'worker', password = WORKER_PASSWORD) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: 'chrome-extension://test-extension' },
    payload: { username, password, clientType: 'extension' },
  });
  assert.equal(response.statusCode, 200);
  return response.json().token;
}

function adminHeaders(admin, includeCsrf = true) {
  return {
    cookie: admin.cookie,
    origin: 'https://admin.example.test',
    ...(includeCsrf ? { 'x-csrf-token': admin.csrfToken } : {}),
  };
}

test('login command service creates, deduplicates, claims atomically, expires, rolls back leases, and completes results', async () => {
  let now = new Date('2026-08-05T10:00:00.000Z');
  const repository = new MemoryLoginCommandRepository(new MemoryPlatformAccountRepository([accountRecord()]));
  const service = new LoginCommandService(repository, { now: () => new Date(now) });

  const first = await service.create(ACCOUNT_ID, ADMIN_ID);
  assert.equal(first.status, 'pending');

  await assert.rejects(
    service.create(ACCOUNT_ID, ADMIN_ID),
    (error) => error?.code === 'DUPLICATE_PENDING' && error?.statusCode === 409,
  );

  const [claimA, claimB] = await Promise.all([
    service.claimNext('device-a'),
    service.claimNext('device-b'),
  ]);
  const claims = [claimA, claimB].filter(Boolean);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].id, first.id);
  assert.equal(claims[0].platformAccountId, ACCOUNT_ID);

  await assert.rejects(
    service.complete(first.id, 'device-b', { ok: true }),
    (error) => error?.code === 'FORBIDDEN' && error?.statusCode === 403,
  );

  const success = await service.complete(first.id, 'device-a', { ok: true });
  assert.equal(success.status, 'success');
  assert.equal(success.resultCode, null);

  const failed = await service.create(ACCOUNT_ID, ADMIN_ID);
  const claimedFailed = await service.claimNext('device-a');
  assert.equal(claimedFailed.id, failed.id);
  const completedFailed = await service.complete(failed.id, 'device-a', {
    ok: false,
    code: 'FORM_NOT_READY',
    message: 'x'.repeat(240),
  });
  assert.equal(completedFailed.status, 'failed');
  assert.equal(completedFailed.resultCode, 'FORM_NOT_READY');
  assert.equal(completedFailed.resultMessage.length, 200);

  const leased = await service.create(ACCOUNT_ID, ADMIN_ID);
  const leasedClaim = await service.claimNext('device-a');
  assert.equal(leasedClaim.id, leased.id);
  now = new Date('2026-08-05T10:01:01.000Z');
  const reclaimed = await service.claimNext('device-b');
  assert.equal(reclaimed.id, leased.id);
  await service.complete(reclaimed.id, 'device-b', { ok: true });

  const expiring = await service.create(randomUUID(), ADMIN_ID);
  now = new Date('2026-08-05T10:06:10.000Z');
  assert.equal(await service.claimNext('device-c'), null);
  assert.equal((await service.get(expiring.id)).status, 'expired');
});

test('login command routes enforce admin and extension permissions, CSRF, duplicate conflicts, and claimed_by ownership', async () => {
  const { app } = await makeApp();
  try {
    const admin = await loginAdmin(app);
    const extensionToken = await loginExtension(app);
    const otherExtensionToken = await loginExtension(app, 'admin', ADMIN_PASSWORD);

    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/login-commands',
      headers: adminHeaders(admin, false),
      payload: { platformAccountId: ACCOUNT_ID },
    });
    assert.equal(noCsrf.statusCode, 403);

    const extensionCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/login-commands',
      headers: { authorization: `Bearer ${extensionToken}` },
      payload: { platformAccountId: ACCOUNT_ID },
    });
    assert.equal(extensionCreate.statusCode, 403);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/login-commands',
      headers: adminHeaders(admin),
      payload: { platformAccountId: ACCOUNT_ID },
    });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(Object.keys(created.json()).sort(), ['createdAt', 'id', 'status']);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/login-commands',
      headers: adminHeaders(admin),
      payload: { platformAccountId: ACCOUNT_ID },
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error.code, 'DUPLICATE_PENDING');

    const adminClaim = await app.inject({
      method: 'GET',
      url: '/api/v1/login-commands?status=pending',
      headers: { cookie: admin.cookie },
    });
    assert.equal(adminClaim.statusCode, 403);

    const claimed = await app.inject({
      method: 'GET',
      url: '/api/v1/login-commands?status=pending',
      headers: { authorization: `Bearer ${extensionToken}` },
    });
    assert.equal(claimed.statusCode, 200);
    assert.deepEqual(claimed.json(), {
      command: { id: created.json().id, platformAccountId: ACCOUNT_ID },
    });

    const strangerResult = await app.inject({
      method: 'POST',
      url: `/api/v1/login-commands/${created.json().id}/result`,
      headers: { authorization: `Bearer ${otherExtensionToken}` },
      payload: { ok: false, code: 'NO_TAB', message: 'no login tab' },
    });
    assert.equal(strangerResult.statusCode, 403);

    const result = await app.inject({
      method: 'POST',
      url: `/api/v1/login-commands/${created.json().id}/result`,
      headers: { authorization: `Bearer ${extensionToken}` },
      payload: { ok: true },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().status, 'success');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/login-commands?limit=100',
      headers: { cookie: admin.cookie },
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().commands.length, 1);
    assert.equal(list.json().commands[0].accountLabel, 'synthetic-account');
    assert.equal(list.json().commands[0].status, 'success');
    assert.equal(list.body.includes('court-user'), false);
    assert.equal(list.body.includes('court-pass'), false);
  } finally {
    await app.close();
  }
});

test('postgres login command repository persists the queue and lists account labels', async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();

  try {
    await runMigrations(pool);
    await pool.query(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES ($1, 'admin', 'hash', 'admin')
    `, [ADMIN_ID]);
    await pool.query(`
      INSERT INTO platform_accounts
        (id, label, secret_ciphertext, secret_iv, secret_tag, created_by)
      VALUES ($1, 'pg-primary', $2, $3, $4, $5)
    `, [
      ACCOUNT_ID,
      Buffer.from('cipher'),
      Buffer.alloc(12, 1),
      Buffer.alloc(16, 2),
      ADMIN_ID,
    ]);

    const repository = new PgLoginCommandRepository(pool);
    const now = new Date('2026-08-05T10:00:00.000Z');
    const command = await repository.create({
      platformAccountId: ACCOUNT_ID,
      createdBy: ADMIN_ID,
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    });
    const claimed = await repository.claimNext('device-a', now, new Date(now.getTime() + 60 * 1000));
    assert.equal(claimed.id, command.id);
    await repository.complete(command.id, 'device-a', {
      ok: false,
      code: 'NO_TAB',
      message: 'no login tab',
    });

    const list = await repository.listAdmin(100);
    assert.equal(list[0].accountLabel, 'pg-primary');
    assert.equal(list[0].status, 'failed');
    assert.equal(list[0].resultCode, 'NO_TAB');
  } finally {
    await pool.end();
  }
});

test('003 login command migration has reversible table, constraints, and indexes', async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();

  try {
    await runMigrations(pool);
    const applied = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(applied.rows.map((row) => row.version), [
      '001_initial',
      '002_add_cases_created_by',
      '003_login_commands',
    ]);

    const columns = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'login_commands'
    `);
    const names = new Set(columns.rows.map((row) => row.column_name));
    for (const column of [
      'id',
      'platform_account_id',
      'status',
      'result_code',
      'result_message',
      'claimed_by',
      'created_by',
      'created_at',
      'updated_at',
      'expires_at',
    ]) {
      assert.equal(names.has(column), true, `missing login_commands.${column}`);
    }

    await pool.query(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES ('00000000-0000-0000-0000-000000000001', 'admin', 'hash', 'admin')
    `);
    await pool.query(`
      INSERT INTO platform_accounts
        (id, label, secret_ciphertext, secret_iv, secret_tag, created_by)
      VALUES (
        '00000000-0000-0000-0000-000000000010',
        'primary',
        'cipher',
        'iv',
        'tag',
        '00000000-0000-0000-0000-000000000001'
      )
    `);
    await assert.rejects(pool.query(`
      INSERT INTO login_commands (id, platform_account_id, status, created_by, expires_at)
      VALUES (
        '00000000-0000-0000-0000-000000000300',
        '00000000-0000-0000-0000-000000000010',
        'bad-status',
        '00000000-0000-0000-0000-000000000001',
        now()
      )
    `));

    assert.equal(await rollbackLastMigration(pool), '003_login_commands');
    const afterRollback = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'login_commands'
    `);
    assert.equal(afterRollback.rows.length, 0);
  } finally {
    await pool.end();
  }
});

test('admin UI exposes remote login controls and the recent login command section without credentials', async () => {
  const { app } = await makeApp();
  try {
    const admin = await loginAdmin(app);
    const page = await app.inject({
      method: 'GET',
      url: '/admin/platform-accounts',
      headers: { cookie: admin.cookie },
    });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /登录指令/);
    assert.doesNotMatch(page.body, /secret_ciphertext|secretCiphertext|court-pass/);

    const script = await app.inject({ method: 'GET', url: '/admin/assets/admin.js' });
    assert.equal(script.statusCode, 200);
    assert.match(script.body, /远程登录/);
    assert.match(script.body, /loadLoginCommands/);
    assert.match(script.body, /setInterval\([^,]+,\s*2000\)/);
    assert.doesNotMatch(script.body, /secretCiphertext|secret_ciphertext|court-pass/);
  } finally {
    await app.close();
  }
});
