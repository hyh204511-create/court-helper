import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { newDb } from 'pg-mem';

import { buildApp, loadConfig } from '../src/app.ts';
import { hashPassword } from '../src/auth/password.ts';
import { MemoryAuthRepository } from '../src/auth/memory-repository.ts';
import { MemoryPlatformAccountRepository } from '../src/platform-accounts/memory-repository.ts';
import { runMigrations, rollbackLastMigration } from '../src/db/migrator.ts';
import { MemoryImportBatchRepository } from '../src/import-batches/memory-repository.ts';
import { MemoryStorageBackend } from '../src/storage/memory.ts';
import { bindPairedExtensionRepository, pairedExtensionTokenForApp } from './paired-extension.ts';

const TEST_KEY = Buffer.alloc(32, 73).toString('base64');
const ADMIN_PASSWORD = 'Admin-pass-1';
const USER_PASSWORD = 'User-pass-1';
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000002';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000010';
const IMPORT_BATCH_ID = '00000000-0000-0000-0000-000000000020';
const EXPIRED_IMPORT_BATCH_ID = '00000000-0000-0000-0000-000000000021';

function config() {
  return loadConfig({
    PORT: '3114',
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

function importBatchRecord(
  id = IMPORT_BATCH_ID,
  expiresAt = new Date('2026-09-05T10:00:00.000Z'),
) {
  const createdAt = new Date('2026-08-06T10:00:00.000Z');
  return {
    id,
    fileName: 'synthetic-import.xlsx',
    objectKey: `import-batches/${id}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    byteSize: 1024,
    sha256: 'a'.repeat(64),
    liRows: 0,
    qzRows: 0,
    skippedRows: 0,
    createdBy: ADMIN_ID,
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(expiresAt),
  };
}

async function authRepository() {
  return new MemoryAuthRepository([
    userRecord(ADMIN_ID, 'admin', 'admin', await hashPassword(ADMIN_PASSWORD)),
    userRecord(USER_ID, 'worker', 'user', await hashPassword(USER_PASSWORD)),
  ]);
}

async function browserModule() {
  return import('../src/browser-commands/index.ts');
}

async function makeService(
  now = new Date('2026-08-06T10:00:00.000Z'),
  importBatchRecords = [importBatchRecord()],
  verifyEvidence = async () => true,
) {
  const {
    BrowserCommandService,
    MemoryBrowserCommandRepository,
  } = await browserModule();
  const repository = new MemoryBrowserCommandRepository();
  const importBatchRepository = new MemoryImportBatchRepository(importBatchRecords);
  let currentNow = new Date(now);
  const service = new BrowserCommandService(repository, importBatchRepository, {
    now: () => new Date(currentNow),
    verifyEvidence,
  });
  return {
    repository,
    importBatchRepository,
    service,
    setNow: (value) => { currentNow = new Date(value); },
  };
}

function commandInput(type, overrides = {}) {
  const queryCommand = type === 'QUERY_LI' || type === 'QUERY_QZ' || type === 'QUERY_ALL_EXPORT';
  const payload = type === 'LOGIN'
    ? {}
    : type === 'QUERY_ALL_EXPORT'
      ? { salesperson: '测试业务员甲' }
      : { batchId: 'batch-safe-1', kind: 'li' };
  return {
    type,
    platformAccountId: ACCOUNT_ID,
    ...(queryCommand ? { importBatchId: IMPORT_BATCH_ID } : {}),
    payload,
    requestedBy: ADMIN_ID,
    ...overrides,
  };
}

async function makeApp(options = {}) {
  const {
    MemoryBrowserCommandRepository,
  } = await browserModule();
  const auth = await authRepository();
  const platformAccounts = new MemoryPlatformAccountRepository([accountRecord()]);
  const browserCommands = new MemoryBrowserCommandRepository();
  const importBatchRepository = options.importBatchRepository
    ?? new MemoryImportBatchRepository([importBatchRecord()]);
  const storageBackend = new MemoryStorageBackend();
  await storageBackend.put(
    `import-batches/${IMPORT_BATCH_ID}.xlsx`,
    readFileSync(new URL('../../tests/fixtures/立案与强执查询表-脱敏模板.xlsx', import.meta.url)),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  const app = buildApp({
    config: config(),
    dependencies: {
      database: { check: async () => true },
      objectStorage: { check: async () => true },
    },
    authRepository: auth,
    platformAccountRepository: platformAccounts,
    browserCommandRepository: browserCommands,
    importBatchRepository,
    storageBackend,
    clock: () => new Date('2026-08-06T10:00:00.000Z'),
  });
  await app.ready();
  bindPairedExtensionRepository(app, auth);
  return { app, browserCommands, importBatchRepository };
}

function cookieHeader(response) {
  const setCookie = response.headers['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(first);
  return first.split(';', 1)[0];
}

async function loginUi(app, username, password) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: 'https://admin.example.test' },
    payload: { username, password, clientType: 'admin_ui' },
  });
  assert.equal(response.statusCode, 200);
  return { cookie: cookieHeader(response), csrfToken: response.json().csrfToken };
}

async function loginExtension(app, username = 'worker', password = USER_PASSWORD) {
  void password;
  return (await pairedExtensionTokenForApp(app, username)).token;
}

async function pairAdministratorExtension(app) {
  const deviceId = randomUUID();
  const exchangeSecret = 'PZmwk1B9s7U0-vmCh0a9ebZhH1tl1TSeKVXIUb4VQyQ';
  const pairing = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/extension-pairings',
    headers: { origin: 'chrome-extension://test-extension' },
    payload: { deviceId, label: 'test extension', exchangeSecret },
  });
  assert.equal(pairing.statusCode, 201);
  const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
  const approved = await app.inject({
    method: 'POST',
    url: `/api/v1/auth/extension-pairings/${pairing.json().pairing.id}/approve`,
    headers: cookieHeaders(admin),
    payload: { verificationCode: pairing.json().pairing.verificationCode },
  });
  assert.equal(approved.statusCode, 200);
  const exchanged = await app.inject({
    method: 'POST',
    url: `/api/v1/auth/extension-pairings/${pairing.json().pairing.id}/exchange`,
    headers: { origin: 'chrome-extension://test-extension' },
    payload: { exchangeSecret },
  });
  assert.equal(exchanged.statusCode, 200);
  return exchanged.json().token;
}

function cookieHeaders(session) {
  return {
    cookie: session.cookie,
    origin: 'https://admin.example.test',
    'x-csrf-token': session.csrfToken,
  };
}

async function createCommand(app, session, prefix = '/api/v1', overrides = {}) {
  const type = overrides.type ?? 'QUERY_LI';
  const { requestedBy: _requestedBy, ...body } = { ...commandInput(type), ...overrides };
  return app.inject({
    method: 'POST',
    url: `${prefix}/browser-commands`,
    headers: cookieHeaders(session),
    payload: body,
  });
}

async function postgres() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const pg = db.adapters.createPg();
  return { db, pool: new pg.Pool() };
}

test('extension pending feed and execution-data lease authorization are claimant bound', async () => {
  const { app, browserCommands } = await makeApp();
  const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
  const extensionToken = await loginExtension(app);
  const created = await createCommand(app, admin, '/api/v1', {
    type: 'QUERY_LI',
    importBatchId: IMPORT_BATCH_ID,
    payload: {},
  });
  assert.equal(created.statusCode, 201);
  const commandId = created.json().command.id;

  const next = await app.inject({
    method: 'GET',
    url: '/api/v1/browser-commands/next',
    headers: { authorization: `Bearer ${extensionToken}`, origin: 'chrome-extension://test-extension' },
  });
  assert.equal(next.statusCode, 200);
  assert.equal(next.json().command.id, commandId);

  const claim = await app.inject({
    method: 'POST',
    url: `/api/v1/browser-commands/${commandId}/claim`,
    headers: { authorization: `Bearer ${extensionToken}`, origin: 'chrome-extension://test-extension' },
    payload: { deviceId: 'device-bound-test' },
  });
  assert.equal(claim.statusCode, 200);
  assert.notEqual((await browserCommands.get(commandId)).claimedBy, 'device-bound-test');
  const { claimToken } = claim.json();
  const executionData = await app.inject({
    method: 'GET',
    url: `/api/v1/import-batches/${IMPORT_BATCH_ID}/extension-data`,
    headers: {
      authorization: `Bearer ${extensionToken}`,
      origin: 'chrome-extension://test-extension',
      'x-browser-command-id': commandId,
      'x-browser-command-device': 'device-bound-test',
      'x-browser-command-claim': claimToken,
    },
  });
  assert.equal(executionData.statusCode, 200);
  assert.match(executionData.headers['cache-control'], /no-store/);
  assert.equal(executionData.json().queryMode, 'template_not_empty');
  assert.deepEqual(executionData.json().rows, []);

  const spoofedDeviceHeader = await app.inject({
    method: 'GET',
    url: `/api/v1/import-batches/${IMPORT_BATCH_ID}/extension-data`,
    headers: {
      authorization: `Bearer ${extensionToken}`,
      origin: 'chrome-extension://test-extension',
      'x-browser-command-id': commandId,
      'x-browser-command-device': 'other-device',
      'x-browser-command-claim': claimToken,
    },
  });
  assert.equal(spoofedDeviceHeader.statusCode, 200);
  const { BrowserCommandService } = await browserModule();
  assert.equal(typeof BrowserCommandService, 'function');
  const { service } = await makeService();
  const unitCommand = await service.create(commandInput('QUERY_LI', { payload: {} }));
  const unitClaim = await service.claim(unitCommand.id, 'device-bound-test');
  await assert.doesNotReject(() => service.authorizeExecutionData(
    unitCommand.id,
    IMPORT_BATCH_ID,
    'device-bound-test',
    unitClaim.claimToken,
  ));
  await assert.rejects(() => service.authorizeExecutionData(
    unitCommand.id,
    IMPORT_BATCH_ID,
    'other-device',
    unitClaim.claimToken,
  ), /lease is not valid/i);
  assert.equal(typeof claimToken, 'string');
  await app.close();
});

test('005 browser command migration creates a reversible secure queue and keeps login_commands', async () => {
  const { pool } = await postgres();
  try {
    await runMigrations(pool);
    const applied = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(applied.rows.map((row) => row.version), [
      '001_initial',
      '002_add_cases_created_by',
      '003_login_commands',
      '004_report_exports',
      '005_browser_commands',
      '006_import_batches',
      '007_extension_devices',
      '008_query_all_export',
      '009_report_exports_platform_account',
      '010_platform_account_label_reuse',
      '011_wecom_automatic_notifications',
      '012_wecom_userid_mentions',
    ]);

    const columns = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'browser_commands'
    `);
    const names = new Set(columns.rows.map((row) => row.column_name));
    for (const column of [
      'id', 'type', 'status', 'platform_account_id', 'client_batch_id',
      'requested_by', 'claimed_by', 'claim_token_hash', 'payload', 'result_code',
      'result_summary', 'progress', 'created_at', 'updated_at', 'expires_at',
    ]) {
      assert.equal(names.has(column), true, `missing browser_commands.${column}`);
    }

    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('login_commands', 'browser_commands')
    `);
    assert.deepEqual(new Set(tables.rows.map((row) => row.table_name)), new Set(['login_commands', 'browser_commands']));

    await pool.query(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES ($1, 'admin', 'hash', 'admin')
    `, [ADMIN_ID]);
    await pool.query(`
      INSERT INTO platform_accounts
        (id, label, secret_ciphertext, secret_iv, secret_tag, created_by)
      VALUES ($1, 'primary', $2, $3, $4, $5)
    `, [ACCOUNT_ID, Buffer.from('cipher'), Buffer.alloc(12, 1), Buffer.alloc(16, 2), ADMIN_ID]);
    await pool.query(`
      INSERT INTO browser_commands
        (id, type, platform_account_id, requested_by, payload, expires_at)
      VALUES ($1, 'QUERY_LI', $2, $3, $4, now() + interval '5 minutes')
    `, [randomUUID(), ACCOUNT_ID, ADMIN_ID, JSON.stringify({ batchId: 'batch-safe-1' })]);
    await assert.rejects(pool.query(`
      INSERT INTO browser_commands
        (id, type, platform_account_id, requested_by, payload, expires_at)
      VALUES ($1, 'QUERY_QZ', $2, $3, $4, now() + interval '5 minutes')
    `, [randomUUID(), ACCOUNT_ID, ADMIN_ID, JSON.stringify({ batchId: 'batch-safe-2' })]));

    assert.equal(await rollbackLastMigration(pool), '012_wecom_userid_mentions');
    assert.equal(await rollbackLastMigration(pool), '011_wecom_automatic_notifications');
    assert.equal(await rollbackLastMigration(pool), '010_platform_account_label_reuse');
    assert.equal(await rollbackLastMigration(pool), '009_report_exports_platform_account');
    assert.equal(await rollbackLastMigration(pool), '008_query_all_export');
    assert.equal(await rollbackLastMigration(pool), '007_extension_devices');
    assert.equal(await rollbackLastMigration(pool), '006_import_batches');
    assert.equal(await rollbackLastMigration(pool), '005_browser_commands');
    const afterRollback = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'browser_commands'
    `);
    assert.equal(afterRollback.rows.length, 0);
    const oldTable = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'login_commands'
    `);
    assert.equal(oldTable.rows.length, 1);
  } finally {
    await pool.end();
  }
});

test('browser command service accepts all five command types with safe payloads', async () => {
  const { service } = await makeService();
  for (const type of ['LOGIN', 'QUERY_LI', 'QUERY_QZ', 'EXPORT_REPORT', 'QUERY_ALL_EXPORT']) {
    const command = await service.create(commandInput(type, {
      platformAccountId: randomUUID(),
    }));
    assert.equal(command.type, type);
    assert.equal(command.status, 'pending');
    assert.deepEqual(command.payload, type === 'LOGIN'
      ? {}
      : type === 'QUERY_ALL_EXPORT'
        ? { salesperson: '测试业务员甲' }
        : { batchId: 'batch-safe-1', kind: 'li' });
    assert.equal(command.clientBatchId, type === 'QUERY_LI' || type === 'QUERY_QZ' || type === 'QUERY_ALL_EXPORT'
      ? IMPORT_BATCH_ID
      : null);
  }
});

test('browser command service requires a platform account for report exports', async () => {
  const { service } = await makeService();
  await assert.rejects(
    service.create(commandInput('EXPORT_REPORT', { platformAccountId: null })),
    (error) => error?.code === 'VALIDATION_ERROR' && error?.statusCode === 400,
  );
});

test('QUERY_ALL_EXPORT requires a trimmed salesperson of at most 100 characters', async () => {
  const { service } = await makeService();
  for (const salesperson of ['', '   ', '业'.repeat(101)]) {
    await assert.rejects(
      service.create(commandInput('QUERY_ALL_EXPORT', { payload: { salesperson } })),
      (error) => error?.code === 'VALIDATION_ERROR' && error?.statusCode === 400,
    );
  }
  const command = await service.create(commandInput('QUERY_ALL_EXPORT', {
    payload: { salesperson: '  测试业务员甲  ' },
  }));
  assert.deepEqual(command.payload, { salesperson: '测试业务员甲' });
});

test('browser query commands bind only an existing, unexpired import batch', async () => {
  const now = new Date('2026-08-06T10:00:00.000Z');
  const { service } = await makeService(now, [
    importBatchRecord(IMPORT_BATCH_ID, new Date('2026-08-06T10:01:00.000Z')),
    importBatchRecord(EXPIRED_IMPORT_BATCH_ID, now),
  ]);

  const li = await service.create(commandInput('QUERY_LI'));
  const qz = await service.create(commandInput('QUERY_QZ', { platformAccountId: randomUUID() }));
  assert.equal(li.clientBatchId, IMPORT_BATCH_ID);
  assert.equal(qz.clientBatchId, IMPORT_BATCH_ID);

  await assert.rejects(
    service.create(commandInput('QUERY_LI', {
      platformAccountId: randomUUID(),
      importBatchId: randomUUID(),
    })),
    (error) => error?.code === 'NOT_FOUND' && error?.statusCode === 404,
  );
  await assert.rejects(
    service.create(commandInput('QUERY_LI', {
      platformAccountId: randomUUID(),
      importBatchId: EXPIRED_IMPORT_BATCH_ID,
    })),
    (error) => error?.code === 'IMPORT_BATCH_EXPIRED' && error?.statusCode === 409,
  );
  await assert.rejects(
    service.create(commandInput('QUERY_QZ', {
      platformAccountId: randomUUID(),
      importBatchId: null,
    })),
    (error) => error?.code === 'VALIDATION_ERROR' && error?.statusCode === 400,
  );
});

test('browser query commands accept empty templates as platform-discovery baselines', async () => {
  for (const [type, rowField] of [['QUERY_LI', 'liRows'], ['QUERY_QZ', 'qzRows']]) {
    const emptyForType = importBatchRecord();
    emptyForType[rowField] = 0;
    const { service, repository } = await makeService(undefined, [emptyForType]);

    const command = await service.create(commandInput(type, { platformAccountId: randomUUID() }));
    assert.equal(command.clientBatchId, IMPORT_BATCH_ID);
    assert.equal(command.status, 'pending');
    assert.equal((await repository.list({ limit: 10 })).items.length, 1);
  }
});

test('browser query commands reject non-empty template blocks instead of falling back to row matching', async () => {
  for (const [type, rowField] of [['QUERY_LI', 'liRows'], ['QUERY_QZ', 'qzRows']]) {
    const nonEmptyForType = importBatchRecord();
    nonEmptyForType[rowField] = 1;
    const { service } = await makeService(undefined, [nonEmptyForType]);

    await assert.rejects(
      service.create(commandInput(type, { platformAccountId: randomUUID() })),
      (error) => error?.code === 'TEMPLATE_NOT_EMPTY' && error?.statusCode === 400,
    );
  }
});

test('browser command API creates a query command for an empty template', async () => {
  const emptyLiBatch = importBatchRecord();
  emptyLiBatch.liRows = 0;
  const importBatchRepository = new MemoryImportBatchRepository([emptyLiBatch]);
  const { app, browserCommands } = await makeApp({ importBatchRepository });
  try {
    const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
    const response = await createCommand(app, admin, '/api/v1', {
      type: 'QUERY_LI',
      platformAccountId: randomUUID(),
      importBatchId: IMPORT_BATCH_ID,
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().command.clientBatchId, IMPORT_BATCH_ID);
    assert.equal((await browserCommands.list({ limit: 10 })).items.length, 1);
  } finally {
    await app.close();
  }
});

test('browser command creation rejects duplicate active platform-account work atomically', async () => {
  const { service } = await makeService();
  const results = await Promise.allSettled([
    service.create(commandInput('QUERY_LI')),
    service.create(commandInput('QUERY_QZ')),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'DUPLICATE_PENDING');
  assert.equal(rejected.reason.statusCode, 409);
});

test('browser command claim is single-device, returns a one-time token, and stores only its hash', async () => {
  const { service, repository } = await makeService();
  const command = await service.create(commandInput('LOGIN'));
  const first = await service.claim(command.id, 'device-a');
  assert.equal(first.command.status, 'executing');
  assert.equal(typeof first.claimToken, 'string');
  assert.notEqual(first.claimToken, first.command.claimTokenHash);

  const stored = await repository.get(command.id);
  assert.equal(stored.claimedBy, 'device-a');
  assert.match(stored.claimTokenHash, /^[a-f0-9]{64}$/);
  assert.equal(stored.claimTokenHash.includes(first.claimToken), false);

  const retried = await service.claim(command.id, 'device-a');
  assert.equal(retried.command.id, command.id);
  assert.equal(retried.claimToken, null);
  assert.equal(
    await service.authorizeExecutionOwner(command.id, 'device-a', first.claimToken, ['LOGIN']),
    command.requestedBy,
  );
  await assert.rejects(
    service.authorizeExecutionOwner(command.id, 'device-a', 'wrong-claim-token', ['LOGIN']),
    (error) => error?.code === 'FORBIDDEN',
  );
  await assert.rejects(
    service.authorizeExecutionOwner(command.id, 'device-a', first.claimToken, ['QUERY_LI']),
    (error) => error?.code === 'FORBIDDEN',
  );
  await assert.rejects(
    service.claim(command.id, 'device-b'),
    (error) => error?.code === 'ALREADY_CLAIMED' && error?.statusCode === 409,
  );
});

test('browser command results require the claimant token and are idempotent', async () => {
  const { service } = await makeService();
  const command = await service.create(commandInput('QUERY_LI'));
  const claim = await service.claim(command.id, 'device-a');

  await assert.rejects(
    service.writeResult(command.id, {
      deviceId: 'device-b',
      claimToken: claim.claimToken,
      status: 'succeeded',
      resultCode: 'SUCCESS',
      resultSummary: 'done',
      progress: 100,
    }),
    (error) => error?.code === 'FORBIDDEN' && error?.statusCode === 403,
  );

  const success = await service.writeResult(command.id, {
    deviceId: 'device-a',
    claimToken: claim.claimToken,
    status: 'succeeded',
    resultCode: 'SUCCESS',
    resultSummary: 'done',
    progress: 100,
  });
  assert.equal(success.status, 'succeeded');
  assert.equal(success.resultCode, 'SUCCESS');
  const retried = await service.writeResult(command.id, {
    deviceId: 'device-a',
    claimToken: claim.claimToken,
    status: 'failed',
    resultCode: 'SELECTOR_CHANGED',
    resultSummary: 'changed',
    progress: 10,
  });
  assert.equal(retried.status, 'succeeded');
  assert.equal(retried.resultCode, 'SUCCESS');
  assert.equal(retried.resultSummary, 'done');
});

test('QUERY_ALL_EXPORT success requires an explicit evidence closure proof', async () => {
  const verificationCalls = [];
  const { service } = await makeService(
    undefined,
    undefined,
    async (input) => { verificationCalls.push(input); return input.evidenceEventIds[0] === 'case-proof-current'; },
  );
  const legacy = await service.create(commandInput('QUERY_ALL_EXPORT'));
  const legacyClaim = await service.claim(legacy.id, 'device-legacy');
  const rejectedSuccess = await service.writeResult(legacy.id, {
    deviceId: 'device-legacy',
    claimToken: legacyClaim.claimToken,
    status: 'succeeded',
    resultCode: 'SUCCESS',
    resultSummary: '报表已上传服务器',
    progress: null,
  });
  assert.equal(rejectedSuccess.status, 'manual_required');
  assert.equal(rejectedSuccess.resultCode, 'EVIDENCE_NOT_CLOSED');
  assert.equal(rejectedSuccess.resultSummary, '证据未完成服务器闭环');

  const closed = await service.create(commandInput('QUERY_ALL_EXPORT', {
    platformAccountId: randomUUID(),
  }));
  const closedClaim = await service.claim(closed.id, 'device-current');
  const acceptedSuccess = await service.writeResult(closed.id, {
    deviceId: 'device-current',
    claimToken: closedClaim.claimToken,
    status: 'succeeded',
    resultCode: 'SUCCESS',
    resultSummary: '报表已上传服务器',
    progress: null,
    evidenceClosed: true,
    evidenceEventIds: ['case-proof-current'],
  });
  assert.equal(acceptedSuccess.status, 'succeeded');
  assert.equal(acceptedSuccess.resultCode, 'SUCCESS');
  assert.deepEqual(verificationCalls, [{
    platformAccountId: closed.platformAccountId,
    requestedBy: closed.requestedBy,
    evidenceEventIds: ['case-proof-current'],
  }]);

  const stale = await service.create(commandInput('QUERY_ALL_EXPORT', { platformAccountId: randomUUID() }));
  const staleClaim = await service.claim(stale.id, 'device-stale');
  const staleResult = await service.writeResult(stale.id, {
    deviceId: 'device-stale',
    claimToken: staleClaim.claimToken,
    status: 'succeeded',
    resultCode: 'SUCCESS',
    resultSummary: '报表已上传服务器',
    progress: null,
    evidenceClosed: true,
    evidenceEventIds: ['case-proof-from-another-server'],
  });
  assert.equal(staleResult.status, 'manual_required');
  assert.equal(staleResult.resultCode, 'EVIDENCE_NOT_CLOSED');
});

test('browser command service expires stale pending and executing commands', async () => {
  let now = new Date('2026-08-06T10:00:00.000Z');
  const { service, setNow } = await makeService(now);
  const pending = await service.create(commandInput('QUERY_LI'));
  now = new Date('2026-08-06T10:06:00.000Z');
  setNow(now);
  assert.equal((await service.get(pending.id)).status, 'expired');

  const executing = await service.create(commandInput('QUERY_LI', { platformAccountId: randomUUID() }));
  now = new Date('2026-08-06T10:06:01.000Z');
  setNow(now);
  const claim = await service.claim(executing.id, 'device-a');
  assert.equal(claim.command.status, 'executing');
  now = new Date('2026-08-06T10:25:00.000Z');
  setNow(now);
  assert.equal((await service.get(executing.id)).status, 'executing');
  now = new Date('2026-08-06T10:27:00.000Z');
  setNow(now);
  assert.equal((await service.get(executing.id)).status, 'expired');
});

test('browser command cancellation is owner-only and terminal-state idempotent', async () => {
  const { service } = await makeService();
  const command = await service.create(commandInput('EXPORT_REPORT', { requestedBy: USER_ID }));
  await assert.rejects(
    service.cancel(command.id, ADMIN_ID),
    (error) => error?.code === 'NOT_FOUND' && error?.statusCode === 404,
  );
  const cancelled = await service.cancel(command.id, USER_ID);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await service.cancel(command.id, USER_ID)).status, 'cancelled');
});

test('browser command cleanup deletes only terminal commands in the requested ownership scope', async () => {
  const { service } = await makeService();
  const userFinished = await service.create(commandInput('EXPORT_REPORT', {
    platformAccountId: randomUUID(),
    requestedBy: USER_ID,
  }));
  const adminFinished = await service.create(commandInput('EXPORT_REPORT', {
    platformAccountId: randomUUID(),
    requestedBy: ADMIN_ID,
  }));
  const active = await service.create(commandInput('EXPORT_REPORT', {
    platformAccountId: randomUUID(),
    requestedBy: USER_ID,
  }));
  await service.cancel(userFinished.id, USER_ID);
  await service.cancel(adminFinished.id, ADMIN_ID);

  assert.equal(await service.deleteTerminal(USER_ID), 1);
  assert.equal((await service.list({ limit: 100 })).items.some((item) => item.id === userFinished.id), false);
  assert.equal((await service.get(active.id)).status, 'pending');
  assert.equal((await service.get(adminFinished.id)).status, 'cancelled');

  assert.equal(await service.deleteTerminal(), 1);
  assert.deepEqual((await service.list({ limit: 100 })).items.map((item) => item.id), [active.id]);
});

test('browser command deletion removes one terminal command and bulk filtering only removes one-click history', async () => {
  const { service } = await makeService();
  const oneClick = await service.create(commandInput('QUERY_ALL_EXPORT'));
  const anotherOneClick = await service.create(commandInput('QUERY_ALL_EXPORT', { platformAccountId: randomUUID() }));
  const otherTerminal = await service.create(commandInput('EXPORT_REPORT', { platformAccountId: randomUUID() }));
  const active = await service.create(commandInput('QUERY_ALL_EXPORT', { platformAccountId: randomUUID() }));
  await service.cancel(oneClick.id, ADMIN_ID);
  await service.cancel(anotherOneClick.id, ADMIN_ID);
  await service.cancel(otherTerminal.id, ADMIN_ID);

  await assert.rejects(
    service.deleteTerminalCommand(active.id),
    (error) => error?.code === 'TASK_ACTIVE' && error?.statusCode === 409,
  );
  assert.equal(await service.deleteTerminalCommand(oneClick.id), 1);
  await assert.rejects(service.get(oneClick.id), (error) => error?.code === 'NOT_FOUND');
  assert.equal(await service.deleteTerminal(undefined, 'QUERY_ALL_EXPORT'), 1);
  await assert.rejects(service.get(anotherOneClick.id), (error) => error?.code === 'NOT_FOUND');
  assert.equal((await service.get(otherTerminal.id)).status, 'cancelled');
  assert.equal((await service.get(active.id)).status, 'pending');
});

test('browser command service validates UUIDs, result states, progress, and safe summaries', async () => {
  const { service } = await makeService();
  await assert.rejects(
    service.create(commandInput('LOGIN', { platformAccountId: 'not-a-uuid' })),
    (error) => error?.code === 'VALIDATION_ERROR' && error?.statusCode === 400,
  );
  await assert.rejects(
    service.create(commandInput('LOGIN', { requestedBy: 'not-a-uuid' })),
    (error) => error?.code === 'VALIDATION_ERROR' && error?.statusCode === 400,
  );
  const command = await service.create(commandInput('LOGIN'));
  const claim = await service.claim(command.id, 'device-a');
  await assert.rejects(
    service.writeResult(command.id, {
      deviceId: 'device-a',
      claimToken: claim.claimToken,
      status: 'pending',
      resultCode: 'SUCCESS',
      resultSummary: 'not terminal',
      progress: 0,
    }),
    (error) => error?.code === 'VALIDATION_ERROR' && error?.statusCode === 400,
  );
  await assert.rejects(
    service.writeResult(command.id, {
      deviceId: 'device-a',
      claimToken: claim.claimToken,
      status: 'failed',
      resultCode: 'NEEDS_HUMAN',
      resultSummary: 'password=secret',
      progress: 101,
    }),
    (error) => error?.code === 'VALIDATION_ERROR' && error?.statusCode === 400,
  );
});

test('browser command routes require authentication and register both REST prefixes', async () => {
  const { app } = await makeApp();
  try {
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/browser-commands' });
    assert.equal(unauthenticated.statusCode, 401);

    const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
    const versioned = await createCommand(app, admin, '/api/v1', {
      type: 'QUERY_LI',
      platformAccountId: randomUUID(),
    });
    assert.equal(versioned.statusCode, 201);
    assert.ok(versioned.json().command.id);

    const bare = await createCommand(app, admin, '', {
      type: 'EXPORT_REPORT',
      platformAccountId: ACCOUNT_ID,
    });
    assert.equal(bare.statusCode, 201);
    assert.equal(bare.json().command.type, 'EXPORT_REPORT');
  } finally {
    await app.close();
  }
});

test('paired extension bearer cannot create, list, inspect, or cancel back-office commands', async () => {
  const { app } = await makeApp();
  try {
    const token = await pairAdministratorExtension(app);
    const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
    const created = await createCommand(app, admin, '/api/v1', {
      type: 'EXPORT_REPORT',
      platformAccountId: ACCOUNT_ID,
    });
    assert.equal(created.statusCode, 201);

    const deniedCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/browser-commands',
      headers: { authorization: `Bearer ${token}` },
      payload: { type: 'EXPORT_REPORT', platformAccountId: ACCOUNT_ID },
    });
    assert.equal(deniedCreate.statusCode, 403);

    const deniedList = await app.inject({
      method: 'GET',
      url: '/api/v1/browser-commands',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(deniedList.statusCode, 403);

    const deniedDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/browser-commands/${created.json().command.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(deniedDetail.statusCode, 403);

    const deniedCancel = await app.inject({
      method: 'POST',
      url: `/api/v1/browser-commands/${created.json().command.id}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    assert.equal(deniedCancel.statusCode, 403);

    const deniedCleanup = await app.inject({
      method: 'DELETE',
      url: '/api/v1/browser-commands',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(deniedCleanup.statusCode, 403);
  } finally {
    await app.close();
  }
});

test('browser command routes bind query importBatchId and reject free clientBatchId', async () => {
  const { app } = await makeApp();
  try {
    const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
    const created = await createCommand(app, admin, '/api/v1', {
      type: 'QUERY_LI',
      platformAccountId: randomUUID(),
      importBatchId: IMPORT_BATCH_ID,
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().command.clientBatchId, IMPORT_BATCH_ID);

    const freeBatchId = await app.inject({
      method: 'POST',
      url: '/api/v1/browser-commands',
      headers: cookieHeaders(admin),
      payload: {
        type: 'QUERY_QZ',
        platformAccountId: randomUUID(),
        clientBatchId: 'arbitrary-client-batch',
        payload: { kind: 'qz' },
      },
    });
    assert.equal(freeBatchId.statusCode, 400);
    assert.equal(freeBatchId.json().error.code, 'VALIDATION_ERROR');
    assert.equal(freeBatchId.body.includes('arbitrary-client-batch'), false);
  } finally {
    await app.close();
  }
});

test('QUERY_ALL_EXPORT requires one empty batch and persists it for the single command', async () => {
  const { app } = await makeApp();
  try {
    const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
    const created = await createCommand(app, admin, '/api/v1', {
      type: 'QUERY_ALL_EXPORT',
      platformAccountId: ACCOUNT_ID,
      importBatchId: IMPORT_BATCH_ID,
      payload: { salesperson: '  测试业务员甲  ' },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().command.type, 'QUERY_ALL_EXPORT');
    assert.equal(created.json().command.clientBatchId, IMPORT_BATCH_ID);
    assert.deepEqual(created.json().command.payload, { salesperson: '测试业务员甲' });
  } finally {
    await app.close();
  }
});

test('QUERY_ALL_EXPORT rejects either non-empty table block and receives a 40-minute claim lease', async () => {
  const now = new Date('2026-08-08T10:00:00.000Z');
  const nonEmptyId = '00000000-0000-4000-8000-000000000088';
  const { service } = await makeService(now, [
    importBatchRecord(IMPORT_BATCH_ID, new Date('2026-08-08T12:00:00.000Z')),
    { ...importBatchRecord(nonEmptyId, new Date('2026-08-08T12:00:00.000Z')), qzRows: 1 },
  ]);
  await assert.rejects(
    service.create(commandInput('QUERY_ALL_EXPORT', { importBatchId: nonEmptyId })),
    (error) => error?.code === 'TEMPLATE_NOT_EMPTY',
  );
  const command = await service.create(commandInput('QUERY_ALL_EXPORT'));
  const claim = await service.claim(command.id, 'device-all');
  assert.equal(claim.command.expiresAt.toISOString(), '2026-08-08T10:40:00.000Z');
});

test('browser command routes isolate user lists/details and allow owner cancellation', async () => {
  const { app } = await makeApp();
  try {
    const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
    const user = await loginUi(app, 'worker', USER_PASSWORD);
    const adminCreated = await createCommand(app, admin, '/api/v1', {
      type: 'QUERY_LI',
      platformAccountId: randomUUID(),
    });
    const userCreated = await createCommand(app, user, '/api/v1', {
      type: 'QUERY_QZ',
      platformAccountId: randomUUID(),
    });

    const all = await app.inject({
      method: 'GET',
      url: '/api/v1/browser-commands',
      headers: { cookie: admin.cookie },
    });
    assert.equal(all.statusCode, 200);
    assert.equal(all.json().commands.length, 2);

    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/browser-commands',
      headers: { cookie: user.cookie },
    });
    assert.equal(mine.statusCode, 200);
    assert.deepEqual(mine.json().commands.map((item) => item.id), [userCreated.json().command.id]);

    const hidden = await app.inject({
      method: 'GET',
      url: `/api/v1/browser-commands/${adminCreated.json().command.id}`,
      headers: { cookie: user.cookie },
    });
    assert.equal(hidden.statusCode, 404);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/browser-commands/${userCreated.json().command.id}/cancel`,
      headers: cookieHeaders(user),
      payload: {},
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().command.status, 'cancelled');
  } finally {
    await app.close();
  }
});

test('browser command cleanup route is CSRF protected, role scoped, and preserves active commands', async () => {
  const { app } = await makeApp();
  try {
    const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
    const user = await loginUi(app, 'worker', USER_PASSWORD);
    const adminFinished = await createCommand(app, admin, '/api/v1', {
      type: 'EXPORT_REPORT',
      platformAccountId: randomUUID(),
    });
    const userFinished = await createCommand(app, user, '/api/v1', {
      type: 'EXPORT_REPORT',
      platformAccountId: randomUUID(),
    });
    const active = await createCommand(app, user, '/api/v1', {
      type: 'EXPORT_REPORT',
      platformAccountId: randomUUID(),
    });
    for (const [session, command] of [[admin, adminFinished], [user, userFinished]]) {
      const cancelled = await app.inject({
        method: 'POST',
        url: `/api/v1/browser-commands/${command.json().command.id}/cancel`,
        headers: cookieHeaders(session),
        payload: {},
      });
      assert.equal(cancelled.statusCode, 200);
    }

    const missingCsrf = await app.inject({
      method: 'DELETE',
      url: '/api/v1/browser-commands',
      headers: { cookie: user.cookie, origin: 'https://admin.example.test' },
    });
    assert.equal(missingCsrf.statusCode, 403);

    const userCleanup = await app.inject({
      method: 'DELETE',
      url: '/api/v1/browser-commands',
      headers: cookieHeaders(user),
    });
    assert.equal(userCleanup.statusCode, 200);
    assert.deepEqual(userCleanup.json(), { deletedCount: 1 });

    const afterUserCleanup = await app.inject({
      method: 'GET',
      url: '/api/v1/browser-commands?limit=100',
      headers: { cookie: admin.cookie },
    });
    assert.deepEqual(
      new Set(afterUserCleanup.json().commands.map((item) => item.id)),
      new Set([adminFinished.json().command.id, active.json().command.id]),
    );

    const adminCleanup = await app.inject({
      method: 'DELETE',
      url: '/api/v1/browser-commands',
      headers: cookieHeaders(admin),
    });
    assert.deepEqual(adminCleanup.json(), { deletedCount: 1 });
    const remaining = await app.inject({
      method: 'GET',
      url: '/api/v1/browser-commands?limit=100',
      headers: { cookie: admin.cookie },
    });
    assert.deepEqual(remaining.json().commands.map((item) => item.id), [active.json().command.id]);
  } finally {
    await app.close();
  }
});

test('browser command delete route physically removes terminal rows and rejects active or cross-owner rows', async () => {
  const { app } = await makeApp();
  try {
    const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
    const user = await loginUi(app, 'worker', USER_PASSWORD);
    const userCommand = await createCommand(app, user, '/api/v1', {
      type: 'QUERY_ALL_EXPORT',
      platformAccountId: randomUUID(),
      importBatchId: IMPORT_BATCH_ID,
      payload: { salesperson: '测试业务员乙' },
    });
    const activeId = userCommand.json().command.id;
    const forbidden = await app.inject({
      method: 'DELETE',
      url: `/api/v1/browser-commands/${activeId}`,
      headers: cookieHeaders(admin),
    });
    assert.equal(forbidden.statusCode, 409);
    assert.equal(forbidden.json().error.code, 'TASK_ACTIVE');
    const active = await app.inject({
      method: 'DELETE',
      url: `/api/v1/browser-commands/${activeId}`,
      headers: cookieHeaders(user),
    });
    assert.equal(active.statusCode, 409);
    assert.equal(active.json().error.code, 'TASK_ACTIVE');
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/browser-commands/${activeId}/cancel`,
      headers: cookieHeaders(user),
      payload: {},
    });
    assert.equal(cancelled.statusCode, 200);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/browser-commands/${activeId}`,
      headers: cookieHeaders(user),
    });
    assert.deepEqual(deleted.json(), { deletedCount: 1 });
    const after = await app.inject({ method: 'GET', url: '/api/v1/browser-commands?limit=100', headers: cookieHeaders(admin) });
    assert.equal(after.json().commands.some((item) => item.id === activeId), false);
  } finally {
    await app.close();
  }
});

test('browser command extension claim and claimant result reject strangers and expose no token hash', async () => {
  const { app } = await makeApp();
  try {
    const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
    const extensionToken = await loginExtension(app);
    const otherExtensionToken = await loginExtension(app, 'admin', ADMIN_PASSWORD);
    const created = await createCommand(app, admin, '/api/v1', {
      type: 'QUERY_LI',
      platformAccountId: randomUUID(),
      payload: { batchId: 'batch-safe-2', kind: 'li' },
    });
    const id = created.json().command.id;

    const claim = await app.inject({
      method: 'POST',
      url: `/api/v1/browser-commands/${id}/claim`,
      headers: { authorization: `Bearer ${extensionToken}` },
      payload: { deviceId: 'device-a' },
    });
    assert.equal(claim.statusCode, 200);
    assert.notEqual(claim.json().command.claimedBy, 'device-bound-test');
    assert.equal(claim.json().command.status, 'executing');
    assert.match(claim.json().claimToken, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(claim.body.includes('claimTokenHash'), false);
    assert.equal(claim.body.includes(claim.json().claimToken), true);

    const stranger = await app.inject({
      method: 'POST',
      url: `/api/v1/browser-commands/${id}/result`,
      headers: { authorization: `Bearer ${otherExtensionToken}` },
      payload: {
        deviceId: 'device-b',
        claimToken: claim.json().claimToken,
        status: 'failed',
        resultCode: 'NEEDS_HUMAN',
        resultSummary: 'manual review',
        progress: 20,
      },
    });
    assert.equal(stranger.statusCode, 403);

    const result = await app.inject({
      method: 'POST',
      url: `/api/v1/browser-commands/${id}/result`,
      headers: { authorization: `Bearer ${extensionToken}` },
      payload: {
        deviceId: 'device-a',
        claimToken: claim.json().claimToken,
        status: 'manual_required',
        resultCode: 'NEEDS_HUMAN',
        resultSummary: 'manual review',
        progress: 20,
        evidenceClosed: false,
      },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().command.status, 'manual_required');
    assert.equal(result.body.includes('claimTokenHash'), false);
    assert.equal(result.body.includes('claimToken'), false);
  } finally {
    await app.close();
  }
});

test('browser command routes filter and cursor-paginate safely, rejecting malformed cursor UUIDs', async () => {
  const { app } = await makeApp();
  try {
    const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
    await createCommand(app, admin, '/api/v1', { type: 'QUERY_LI', platformAccountId: randomUUID() });
    const second = await createCommand(app, admin, '/api/v1', { type: 'EXPORT_REPORT', platformAccountId: randomUUID() });

    const firstPage = await app.inject({
      method: 'GET',
      url: '/api/v1/browser-commands?limit=1&type=EXPORT_REPORT',
      headers: { cookie: admin.cookie },
    });
    assert.equal(firstPage.statusCode, 200);
    assert.equal(firstPage.json().commands.length, 1);
    assert.equal(firstPage.json().commands[0].id, second.json().command.id);
    assert.equal(firstPage.json().nextCursor, null);

    const invalidCursor = await app.inject({
      method: 'GET',
      url: '/api/v1/browser-commands?cursor=not-a-valid-cursor',
      headers: { cookie: admin.cookie },
    });
    assert.equal(invalidCursor.statusCode, 400);
    assert.equal(invalidCursor.json().error.code, 'VALIDATION_ERROR');

    const invalidLimit = await app.inject({
      method: 'GET',
      url: '/api/v1/browser-commands?limit=101',
      headers: { cookie: admin.cookie },
    });
    assert.equal(invalidLimit.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('browser command routes reject malformed UUIDs and sensitive payload/result fields at the boundary', async () => {
  const { app } = await makeApp();
  try {
    const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
    const malformed = await app.inject({
      method: 'GET',
      url: '/api/v1/browser-commands/not-a-uuid',
      headers: { cookie: admin.cookie },
    });
    assert.equal(malformed.statusCode, 404);

    for (const payload of [
      { password: 'secret' },
      { captcha: '1234' },
      { caseNumber: 'CASE-PLAINTIFF-001' },
      { plaintiff: 'person' },
      { screenshot: 'data:image/png;base64,abc' },
      { nested: { verificationCode: '1234' } },
    ]) {
      const response = await createCommand(app, admin, '/api/v1', {
        type: 'EXPORT_REPORT',
        platformAccountId: ACCOUNT_ID,
        payload,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.equal(response.json().error.code, 'VALIDATION_ERROR');
    }

    const unknownField = await app.inject({
      method: 'POST',
      url: '/api/v1/browser-commands',
      headers: cookieHeaders(admin),
      payload: { type: 'EXPORT_REPORT', payload: {}, password: 'secret' },
    });
    assert.equal(unknownField.statusCode, 400);
    assert.equal(unknownField.body.includes('secret'), false);
  } finally {
    await app.close();
  }
});

test('postgres browser command repository persists safe JSON, claims atomically, completes, lists, cancels, and clears terminal rows', async () => {
  const { pool } = await postgres();
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
    `, [ACCOUNT_ID, Buffer.from('cipher'), Buffer.alloc(12, 1), Buffer.alloc(16, 2), ADMIN_ID]);
    const { PgBrowserCommandRepository } = await browserModule();
    const repository = new PgBrowserCommandRepository(pool);
    const command = await repository.create({
      type: 'QUERY_LI',
      platformAccountId: ACCOUNT_ID,
      clientBatchId: IMPORT_BATCH_ID,
      requestedBy: ADMIN_ID,
      payload: { batchId: 'batch-safe-1', kind: 'li' },
      expiresAt: new Date('2026-08-06T10:05:00.000Z'),
    });
    assert.deepEqual(command.payload, { batchId: 'batch-safe-1', kind: 'li' });
    const claim = await repository.claim(command.id, 'device-a', 'hash-only-token', new Date('2026-08-06T10:01:00.000Z'), new Date('2026-08-06T10:02:00.000Z'));
    assert.equal(claim.status, 'executing');
    const raw = await pool.query('SELECT claim_token_hash, payload FROM browser_commands WHERE id = $1', [command.id]);
    assert.equal(raw.rows[0].claim_token_hash, 'hash-only-token');
    assert.deepEqual(raw.rows[0].payload, { batchId: 'batch-safe-1', kind: 'li' });
    const result = await repository.writeResult(command.id, 'device-a', 'hash-only-token', {
      status: 'succeeded',
      resultCode: 'SUCCESS',
      resultSummary: 'done',
      progress: 100,
    }, new Date('2026-08-06T10:01:30.000Z'));
    assert.equal(result.status, 'succeeded');
    assert.equal((await repository.list({ requestedBy: ADMIN_ID, limit: 10 })).items.length, 1);
    assert.equal((await repository.cancel(command.id, ADMIN_ID, new Date('2026-08-06T10:02:00.000Z'))).status, 'succeeded');
    assert.equal(await repository.deleteTerminal(ADMIN_ID), 1);
    assert.equal((await repository.list({ requestedBy: ADMIN_ID, limit: 10 })).items.length, 0);
  } finally {
    await pool.end();
  }
});
