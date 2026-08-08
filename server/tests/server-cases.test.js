import test from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';

import { buildApp, loadConfig } from '../src/app.ts';
import { hashPassword } from '../src/auth/password.ts';
import { MemoryAuthRepository } from '../src/auth/memory-repository.ts';
import { PgPlatformAccountRepository } from '../src/platform-accounts/repository.ts';
import { MemoryPlatformAccountRepository } from '../src/platform-accounts/memory-repository.ts';
import { MemoryCaseRepository } from '../src/cases/memory-repository.ts';
import { PgCaseRepository } from '../src/cases/repository.ts';
import { runMigrations } from '../src/db/migrator.ts';
import { MemoryScreenshotRepository } from '../src/screenshots/memory-repository.ts';
import { MemoryStorageBackend } from '../src/storage/memory.ts';
import { bindPairedExtensionRepository, pairedExtensionTokenForApp } from './paired-extension.ts';

const TEST_KEY = Buffer.alloc(32, 23).toString('base64');
const ADMIN_PASSWORD = 'Admin-pass-1';
const WORKER_PASSWORD = 'Worker-pass-1';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000010';
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';

function config() {
  return loadConfig({
    PORT: '3103',
    DATABASE_URL: 'postgres://test:secret@localhost:5432/court_helper',
    CREDENTIAL_MASTER_KEY: TEST_KEY,
    CORS_EXTENSION_ORIGINS: 'chrome-extension://test-extension',
    CORS_ADMIN_ORIGINS: 'https://admin.example.test',
    OBJECT_STORAGE_ENDPOINT: 'https://cos.example.test',
    OBJECT_STORAGE_BUCKET: 'private-test-bucket',
    ADMIN_INITIAL_PASSWORD: ADMIN_PASSWORD,
  });
}

function accountRecord(enabled = true) {
  const now = new Date('2026-08-04T00:00:00.000Z');
  return {
    id: ACCOUNT_ID,
    label: 'synthetic-account',
    secretCiphertext: Buffer.from('ciphertext'),
    secretIv: Buffer.alloc(12, 1),
    secretTag: Buffer.alloc(16, 2),
    secretVersion: 1,
    enabled,
    deletedAt: enabled ? null : now,
    createdBy: ADMIN_ID,
    createdAt: now,
    updatedAt: now,
  };
}

async function addUser(repository, {
  username = 'worker',
  password = WORKER_PASSWORD,
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

async function makeApp({ accountEnabled = true } = {}) {
  const authRepository = new MemoryAuthRepository();
  const platformAccountRepository = new MemoryPlatformAccountRepository([accountRecord(accountEnabled)]);
  const caseRepository = new MemoryCaseRepository();
  const screenshotRepository = new MemoryScreenshotRepository();
  const storageBackend = new MemoryStorageBackend();
  const app = buildApp({
    config: config(),
    dependencies: {
      database: { check: async () => true },
      objectStorage: storageBackend,
    },
    authRepository,
    platformAccountRepository,
    caseRepository,
    screenshotRepository,
    storageBackend,
  });
  await app.ready();
  bindPairedExtensionRepository(app, authRepository);
  await addUser(authRepository);
  return {
    app,
    authRepository,
    platformAccountRepository,
    caseRepository,
    screenshotRepository,
    storageBackend,
  };
}

async function loginExtension(app, username = 'worker', password = WORKER_PASSWORD) {
  void password;
  return (await pairedExtensionTokenForApp(app, username)).token;
}

function caseItem(overrides = {}) {
  return {
    eventId: 'event-1',
    clientUid: 'client-1',
    platformAccountId: ACCOUNT_ID,
    kind: 'li',
    plaintiff: 'first synthetic plaintiff',
    defendant: 'synthetic defendant',
    status: '立案成功',
    filedTime: '2026-08-04',
    caseNumber: 'SYNTHETIC-001',
    rejectTime: null,
    rejectReason: null,
    queryTime: '2026-08-04T01:02:03.000Z',
    needsHuman: false,
    errorCode: null,
    sourceUpdatedAt: '2026-08-04T01:02:03.000Z',
    ...overrides,
  };
}

async function sync(app, token, items) {
  return app.inject({
    method: 'POST',
    url: '/sync/cases',
    headers: { authorization: `Bearer ${token}` },
    payload: { batchId: 'batch-synthetic-1', items },
  });
}

test('sync cases performs idempotent upserts and preserves newer data on conflicts', async () => {
  const { app, caseRepository } = await makeApp();

  try {
    const token = await loginExtension(app);
    const original = caseItem();

    const first = await sync(app, token, [original]);
    assert.equal(first.statusCode, 200);
    const firstBody = first.json();
    assert.equal(firstBody.accepted.length, 1);
    assert.equal(firstBody.conflicts.length, 0);
    assert.equal(firstBody.accepted[0].clientUid, original.clientUid);
    assert.equal(firstBody.accepted[0].eventId, original.eventId);
    assert.equal(firstBody.accepted[0].revision, 1);
    assert.equal(firstBody.cursor, 1);

    const repeated = await sync(app, token, [original]);
    assert.equal(repeated.statusCode, 200);
    assert.deepEqual(repeated.json().accepted[0], firstBody.accepted[0]);
    assert.equal((await caseRepository.list()).length, 1);

    const newer = await sync(app, token, [caseItem({
      eventId: 'event-2',
      sourceUpdatedAt: '2026-08-04T02:02:03.000Z',
      queryTime: '2026-08-04T02:02:03.000Z',
      defendant: 'newer synthetic defendant',
    })]);
    assert.equal(newer.statusCode, 200);
    assert.equal(newer.json().accepted[0].revision, 2);

    const old = await sync(app, token, [caseItem({
      eventId: 'event-0',
      sourceUpdatedAt: '2026-08-04T01:00:00.000Z',
      defendant: 'older synthetic defendant',
    })]);
    assert.equal(old.statusCode, 200);
    assert.equal(old.json().accepted.length, 0);
    assert.equal(old.json().conflicts[0].code, 'CONFLICT');

    const oldButOtherwiseSame = await sync(app, token, [caseItem({
      eventId: 'event-4',
      sourceUpdatedAt: '2026-08-04T01:00:00.000Z',
      defendant: 'newer synthetic defendant',
    })]);
    assert.equal(oldButOtherwiseSame.statusCode, 200);
    assert.equal(oldButOtherwiseSame.json().conflicts[0].code, 'CONFLICT');

    const sameTimeDifferentContent = await sync(app, token, [caseItem({
      eventId: 'event-3',
      defendant: 'same-time synthetic defendant',
    })]);
    assert.equal(sameTimeDifferentContent.statusCode, 200);
    assert.equal(sameTimeDifferentContent.json().conflicts[0].code, 'CONFLICT');

    const stored = (await caseRepository.list())[0];
    assert.equal(stored.defendant, 'newer synthetic defendant');
    assert.equal(stored.revision, 2);
    assert.equal(JSON.stringify(stored).includes('password'), false);
  } finally {
    await app.close();
  }
});

test('sync cases rejects invalid batches and enforces per-item account availability', async () => {
  const { app } = await makeApp();

  try {
    const token = await loginExtension(app);

    const unknownStatus = await sync(app, token, [caseItem({ status: '平台返回的新状态' })]);
    assert.equal(unknownStatus.statusCode, 400);
    assert.equal(unknownStatus.json().error.code, 'VALIDATION_ERROR');

    const kindMismatch = await sync(app, token, [caseItem({ kind: 'qz' })]);
    assert.equal(kindMismatch.statusCode, 400);
    assert.equal(kindMismatch.json().error.code, 'VALIDATION_ERROR');

    const unknownWithoutHumanFlag = await sync(app, token, [caseItem({
      status: 'UNKNOWN',
      needsHuman: false,
    })]);
    assert.equal(unknownWithoutHumanFlag.statusCode, 400);
    assert.equal(unknownWithoutHumanFlag.json().error.code, 'VALIDATION_ERROR');

    const tooMany = await sync(app, token, Array.from({ length: 51 }, (_, index) => caseItem({
      eventId: `event-${index}`,
      clientUid: `client-${index}`,
    })));
    assert.equal(tooMany.statusCode, 400);
    assert.equal(tooMany.json().error.code, 'VALIDATION_ERROR');
  } finally {
    await app.close();
  }

  const disabled = await makeApp({ accountEnabled: false });
  try {
    const token = await loginExtension(disabled.app);
    const response = await sync(disabled.app, token, [caseItem()]);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().conflicts[0].code, 'ACCOUNT_DISABLED');
  } finally {
    await disabled.app.close();
  }

  const missing = await makeApp();
  try {
    const token = await loginExtension(missing.app);
    const response = await sync(missing.app, token, [caseItem({ platformAccountId: 'missing-account' })]);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().conflicts[0].code, 'NOT_FOUND');
  } finally {
    await missing.app.close();
  }
});

test('cases list, detail, filters, cursor pagination, and change polling require authentication', async () => {
  const { app } = await makeApp();

  try {
    const anonymous = await app.inject({ method: 'GET', url: '/cases' });
    assert.equal(anonymous.statusCode, 401);

    const token = await loginExtension(app);
    const first = await sync(app, token, [caseItem()]);
    const firstRevision = first.json().accepted[0].revision;
    const second = await sync(app, token, [caseItem({
      eventId: 'event-2',
      clientUid: 'client-2',
      kind: 'qz',
      status: '已驳回',
      plaintiff: 'second synthetic plaintiff',
      defendant: 'second synthetic defendant',
      filedTime: '2026-08-03',
      caseNumber: null,
      rejectTime: '2026-08-03',
      rejectReason: 'synthetic reject reason',
      queryTime: '2026-08-03T01:02:03.000Z',
      needsHuman: true,
      errorCode: 'REJECTED',
      sourceUpdatedAt: '2026-08-03T01:02:03.000Z',
    })]);
    const secondId = second.json().accepted[0].id;

    const page = await app.inject({
      method: 'GET',
      url: '/cases?limit=1',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(page.statusCode, 200);
    assert.equal(page.json().cases.length, 1);
    assert.ok(page.json().nextCursor);
    const nextPage = await app.inject({
      method: 'GET',
      url: `/cases?limit=1&cursor=${encodeURIComponent(page.json().nextCursor)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(nextPage.statusCode, 200);
    assert.equal(nextPage.json().cases[0].clientUid, 'client-2');

    const filtered = await app.inject({
      method: 'GET',
      url: `/cases?kind=qz&status=${encodeURIComponent('已驳回')}&platformAccountId=${ACCOUNT_ID}&needsHuman=true&from=2026-08-01&to=2026-08-04`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(filtered.statusCode, 200);
    assert.deepEqual(filtered.json().cases.map((item) => item.id), [secondId]);

    const plaintiffKeyword = await app.inject({
      method: 'GET',
      url: `/cases?platformAccountId=${ACCOUNT_ID}&keyword=${encodeURIComponent('first synthetic plaintiff')}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(plaintiffKeyword.statusCode, 200);
    assert.deepEqual(plaintiffKeyword.json().cases.map((item) => item.clientUid), ['client-1']);

    const defendantKeyword = await app.inject({
      method: 'GET',
      url: `/cases?platformAccountId=${ACCOUNT_ID}&keyword=${encodeURIComponent('SECOND SYNTHETIC DEFENDANT')}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(defendantKeyword.statusCode, 200);
    assert.deepEqual(defendantKeyword.json().cases.map((item) => item.clientUid), ['client-2']);

    const caseNumberKeyword = await app.inject({
      method: 'GET',
      url: `/cases?platformAccountId=${ACCOUNT_ID}&keyword=${encodeURIComponent('SYNTHETIC-001')}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(caseNumberKeyword.statusCode, 200);
    assert.deepEqual(caseNumberKeyword.json().cases.map((item) => item.clientUid), ['client-1']);

    const blankKeyword = await app.inject({
      method: 'GET',
      url: '/cases?keyword=%20',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(blankKeyword.statusCode, 400);
    assert.equal(blankKeyword.json().error.code, 'VALIDATION_ERROR');

    const tooLarge = await app.inject({
      method: 'GET',
      url: '/cases?limit=201',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(tooLarge.statusCode, 400);
    assert.equal(tooLarge.json().error.code, 'VALIDATION_ERROR');

    const detail = await app.inject({
      method: 'GET',
      url: `/cases/${secondId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().clientUid, 'client-2');
    assert.equal(detail.body.includes('secretCiphertext'), false);
    assert.equal(detail.body.includes('password'), false);

    const changes = await app.inject({
      method: 'GET',
      url: `/sync/changes?after=${firstRevision}&limit=200`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(changes.statusCode, 200);
    assert.deepEqual(changes.json().cases.map((item) => item.clientUid), ['client-2']);
    assert.equal(changes.json().cases[0].revision > firstRevision, true);
    assert.equal(changes.body.includes('secretCiphertext'), false);

    const missing = await app.inject({
      method: 'GET',
      url: '/cases/does-not-exist',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('postgres case repository persists revisions and supports change queries in pg-mem', async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();

  try {
    await runMigrations(pool);
    await pool.query(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES ($1, 'admin', 'hash', 'admin')
    `, [ADMIN_ID]);
    const accounts = new PgPlatformAccountRepository(pool);
    await accounts.create({
      id: ACCOUNT_ID,
      label: 'pg-synthetic-account',
      secretCiphertext: Buffer.from('ciphertext'),
      secretIv: Buffer.alloc(12, 1),
      secretTag: Buffer.alloc(16, 2),
      secretVersion: 1,
      enabled: true,
      createdBy: ADMIN_ID,
    });

    const repository = new PgCaseRepository(pool);
    const created = await repository.create(caseItem({
      id: '00000000-0000-0000-0000-000000000100',
    }));
    assert.equal(created.revision, 1);
    assert.equal(created.clientUid, 'client-1');

    const updated = await repository.update(created.id, {
      ...caseItem({
        id: created.id,
        eventId: 'event-2',
        sourceUpdatedAt: '2026-08-04T02:02:03.000Z',
        queryTime: '2026-08-04T02:02:03.000Z',
        defendant: 'updated synthetic defendant',
      }),
    });
    assert.ok(updated);
    assert.equal(updated.revision, 2);
    assert.equal(updated.defendant, 'updated synthetic defendant');
    assert.equal((await repository.findByClientUid('client-1')).revision, 2);
    assert.deepEqual((await repository.listChanges(1, 200)).map((item) => item.revision), [2]);
    assert.deepEqual(
      (await repository.list({ platformAccountId: ACCOUNT_ID, keyword: 'UPDATED SYNTHETIC DEFENDANT' })).map((item) => item.clientUid),
      ['client-1'],
    );
    assert.deepEqual(
      await repository.list({ platformAccountId: ACCOUNT_ID, keyword: '%' }),
      [],
    );
    assert.deepEqual(
      await repository.list({ platformAccountId: ACCOUNT_ID, keyword: '_' }),
      [],
    );
    assert.deepEqual(
      await repository.list({ platformAccountId: ACCOUNT_ID, keyword: '\\' }),
      [],
    );

    await repository.create(caseItem({
      id: '00000000-0000-0000-0000-000000000101',
      clientUid: 'client-old',
      eventId: 'event-old',
      queryTime: '2026-07-01T01:02:03.000Z',
      sourceUpdatedAt: '2026-07-01T01:02:03.000Z',
    }));
    const firstExpiredPage = await repository.listExpired(new Date('2026-09-01T00:00:00.000Z'), 1);
    assert.equal(firstExpiredPage.items.length, 1);
    assert.equal(firstExpiredPage.items[0].clientUid, 'client-old');
    assert.ok(firstExpiredPage.nextCursor);
    const secondExpiredPage = await repository.listExpired(
      new Date('2026-09-01T00:00:00.000Z'),
      1,
      firstExpiredPage.nextCursor,
    );
    assert.equal(secondExpiredPage.items.length, 1);
    assert.equal(secondExpiredPage.items[0].clientUid, 'client-1');
  } finally {
    await pool.end();
  }
});

test('case and screenshot reads are isolated by case creator', async () => {
  const {
    app,
    authRepository,
    caseRepository,
    screenshotRepository,
    storageBackend,
  } = await makeApp();

  try {
    await addUser(authRepository, {
      username: 'user-a',
      password: 'User-a-pass-1',
    });
    const userBToken = await loginExtension(app);
    const userAToken = await loginExtension(app, 'user-a', 'User-a-pass-1');

    const userBCase = await sync(app, userBToken, [caseItem({
      eventId: 'event-user-b',
      clientUid: 'client-user-b',
    })]);
    assert.equal(userBCase.statusCode, 200);
    const userBCaseId = userBCase.json().accepted[0].id;

    const screenshotContent = Buffer.from('synthetic user B screenshot');
    const screenshotObjectKey = 'screenshots/user-b/private-object';
    await storageBackend.put(screenshotObjectKey, screenshotContent, 'image/jpeg');
    const userBScreenshot = await screenshotRepository.create({
      caseId: userBCaseId,
      type: 'success',
      objectKey: screenshotObjectKey,
      contentType: 'image/jpeg',
      byteSize: screenshotContent.length,
      sha256: 'a'.repeat(64),
      capturedAt: new Date('2026-08-04T01:02:03.000Z'),
    });

    const userACase = await sync(app, userAToken, [caseItem({
      eventId: 'event-user-a',
      clientUid: 'client-user-a',
      caseNumber: 'SYNTHETIC-A-001',
    })]);
    assert.equal(userACase.statusCode, 200);

    const attemptedOverwrite = await sync(app, userAToken, [caseItem({
      eventId: 'event-user-a-overwrite',
      clientUid: 'client-user-b',
      sourceUpdatedAt: '2026-08-04T02:02:03.000Z',
      defendant: 'unauthorized overwrite',
    })]);
    assert.equal(attemptedOverwrite.statusCode, 200);
    assert.deepEqual(attemptedOverwrite.json().conflicts, [{
      clientUid: 'client-user-b',
      eventId: 'event-user-a-overwrite',
      code: 'CONFLICT',
    }]);
    assert.equal((await caseRepository.findById(userBCaseId)).defendant, 'synthetic defendant');

    const userACases = await app.inject({
      method: 'GET',
      url: '/cases?limit=200',
      headers: { authorization: `Bearer ${userAToken}` },
    });
    assert.equal(userACases.statusCode, 200);
    assert.deepEqual(userACases.json().cases.map((value) => value.clientUid), ['client-user-a']);

    const userAChanges = await app.inject({
      method: 'GET',
      url: '/sync/changes?after=0&limit=200',
      headers: { authorization: `Bearer ${userAToken}` },
    });
    assert.equal(userAChanges.statusCode, 200);
    assert.deepEqual(userAChanges.json().cases.map((value) => value.clientUid), ['client-user-a']);

    const hiddenCase = await app.inject({
      method: 'GET',
      url: `/cases/${userBCaseId}`,
      headers: { authorization: `Bearer ${userAToken}` },
    });
    assert.equal(hiddenCase.statusCode, 404);

    const hiddenScreenshots = await app.inject({
      method: 'GET',
      url: `/cases/${userBCaseId}/screenshots`,
      headers: { authorization: `Bearer ${userAToken}` },
    });
    assert.equal(hiddenScreenshots.statusCode, 404);

    const hiddenContent = await app.inject({
      method: 'GET',
      url: `/screenshots/${userBScreenshot.id}/content`,
      headers: { authorization: `Bearer ${userAToken}` },
    });
    assert.equal(hiddenContent.statusCode, 404);

    const adminToken = await loginExtension(app, 'admin', ADMIN_PASSWORD);
    const adminCase = await app.inject({
      method: 'GET',
      url: `/cases/${userBCaseId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(adminCase.statusCode, 200);

    const adminScreenshots = await app.inject({
      method: 'GET',
      url: `/cases/${userBCaseId}/screenshots`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(adminScreenshots.statusCode, 200);
    assert.deepEqual(adminScreenshots.json().screenshots.map((value) => value.id), [userBScreenshot.id]);
  } finally {
    await app.close();
  }
});
