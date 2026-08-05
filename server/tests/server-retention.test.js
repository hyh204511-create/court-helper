import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildApp, loadConfig } from '../src/app.ts';
import { hashPassword } from '../src/auth/password.ts';
import { MemoryAuthRepository } from '../src/auth/memory-repository.ts';
import { MemoryCaseRepository } from '../src/cases/memory-repository.ts';
import { MemoryPlatformAccountRepository } from '../src/platform-accounts/memory-repository.ts';
import { MemoryReportExportRepository } from '../src/report-exports/memory-repository.ts';
import { REPORT_EXPORT_CONTENT_TYPE } from '../src/report-exports/types.ts';
import { MemoryScreenshotRepository } from '../src/screenshots/memory-repository.ts';
import { MemoryStorageBackend } from '../src/storage/memory.ts';
import { RetentionScheduler, RetentionService } from '../src/retention/index.ts';

const TEST_KEY = Buffer.alloc(32, 31).toString('base64');
const ADMIN_PASSWORD = 'Admin-pass-1';
const WORKER_PASSWORD = 'Worker-pass-1';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000010';
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const WORKER_ID = '00000000-0000-0000-0000-000000000002';
const NOW = new Date('2026-08-31T12:00:00.000Z');
const CUTOFF = new Date('2026-08-01T12:00:00.000Z');

function caseRecord(id, queryTime, revision = 1) {
  const timestamp = new Date(queryTime);
  return {
    id,
    clientUid: `client-${id}`,
    platformAccountId: ACCOUNT_ID,
    kind: 'li',
    plaintiff: 'synthetic plaintiff',
    defendant: 'synthetic defendant',
    status: '立案成功',
    filedTime: '2026-08-01',
    caseNumber: `CASE-${id}`,
    rejectTime: null,
    rejectReason: null,
    queryTime: timestamp,
    needsHuman: false,
    errorCode: null,
    sourceEventId: `event-${id}`,
    sourceUpdatedAt: timestamp,
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function screenshotRecord(id, caseId, objectKey) {
  return {
    id,
    caseId,
    type: 'success',
    objectKey,
    contentType: 'image/jpeg',
    byteSize: 7,
    sha256: createHash('sha256').update('fixture').digest('hex'),
    capturedAt: new Date('2026-08-01T12:00:00.000Z'),
    createdAt: new Date('2026-08-01T12:00:01.000Z'),
  };
}

function reportExportRecord(id, createdAt, objectKey) {
  const timestamp = new Date(createdAt);
  return {
    id,
    fileName: `${id}.xlsx`,
    objectKey,
    contentType: REPORT_EXPORT_CONTENT_TYPE,
    byteSize: 7,
    sha256: createHash('sha256').update(id).digest('hex'),
    createdBy: WORKER_ID,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function userRecord(id, username, role = 'user') {
  const createdAt = new Date('2026-08-31T00:00:00.000Z');
  return {
    id,
    username,
    passwordHash: 'fixture-hash',
    role,
    enabled: true,
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function sessionRecord(id, userId, expiresAt, revokedAt = null) {
  return {
    id,
    userId,
    tokenHash: `token-${id}`,
    clientType: 'extension',
    expiresAt: new Date(expiresAt),
    revokedAt: revokedAt ? new Date(revokedAt) : null,
    createdAt: new Date('2026-08-30T00:00:00.000Z'),
  };
}

function retentionDependencies({ cases = [], screenshots = [], reportExports = [], sessions = [], storage = new MemoryStorageBackend() } = {}) {
  return {
    authRepository: new MemoryAuthRepository([
      userRecord(ADMIN_ID, 'admin', 'admin'),
      userRecord(WORKER_ID, 'worker'),
    ], sessions),
    caseRepository: new MemoryCaseRepository(cases),
    reportExportRepository: new MemoryReportExportRepository(reportExports),
    screenshotRepository: new MemoryScreenshotRepository(screenshots),
    storageBackend: storage,
  };
}

function config() {
  return loadConfig({
    PORT: '3110',
    DATABASE_URL: 'postgres://test:secret@localhost:5432/court_helper',
    CREDENTIAL_MASTER_KEY: TEST_KEY,
    CORS_EXTENSION_ORIGINS: 'chrome-extension://test-extension',
    CORS_ADMIN_ORIGINS: 'https://admin.example.test',
    OBJECT_STORAGE_ENDPOINT: 'https://cos.example.test',
    OBJECT_STORAGE_BUCKET: 'private-test-bucket',
    ADMIN_INITIAL_PASSWORD: ADMIN_PASSWORD,
  });
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

function multipart(fields, buffer) {
  const boundary = '----court-helper-retention-boundary';
  const chunks = [];
  const add = (value) => chunks.push(Buffer.from(value, 'utf8'));
  for (const [name, value] of Object.entries(fields)) {
    add(`--${boundary}\r\n`);
    add(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
    add(`${value}\r\n`);
  }
  add(`--${boundary}\r\n`);
  add('Content-Disposition: form-data; name="file"; filename="evidence.jpg"\r\n');
  add('Content-Type: image/jpeg\r\n\r\n');
  chunks.push(buffer);
  add(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function addWorker(repository) {
  return repository.createUser({
    id: WORKER_ID,
    username: 'worker',
    passwordHash: await hashPassword(WORKER_PASSWORD),
    role: 'user',
    enabled: true,
  });
}

async function loginExtension(app) {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin: 'chrome-extension://test-extension' },
    payload: { username: 'worker', password: WORKER_PASSWORD, clientType: 'extension' },
  });
  assert.equal(response.statusCode, 200);
  return response.json().token;
}

function caseItem(overrides = {}) {
  return {
    eventId: 'event-fresh',
    clientUid: 'client-fresh',
    platformAccountId: ACCOUNT_ID,
    kind: 'li',
    plaintiff: 'synthetic plaintiff',
    defendant: 'synthetic defendant',
    status: '立案成功',
    filedTime: '2026-08-31',
    caseNumber: 'CASE-FRESH',
    rejectTime: null,
    rejectReason: null,
    queryTime: NOW.toISOString(),
    needsHuman: false,
    errorCode: null,
    sourceUpdatedAt: NOW.toISOString(),
    ...overrides,
  };
}

test('retention keeps 29-day data and the exact cutoff, but deletes 31-day cases', async () => {
  const cases = new MemoryCaseRepository([
    caseRecord('case-29', '2026-08-02T12:00:00.000Z', 1),
    caseRecord('case-boundary', CUTOFF.toISOString(), 2),
    caseRecord('case-31', '2026-07-31T12:00:00.000Z', 3),
  ]);
  const service = new RetentionService({
    authRepository: new MemoryAuthRepository(),
    caseRepository: cases,
    reportExportRepository: new MemoryReportExportRepository(),
    screenshotRepository: new MemoryScreenshotRepository(),
    storageBackend: new MemoryStorageBackend(),
  }, { clock: () => new Date(NOW) });

  await service.cleanup();

  assert.deepEqual((await cases.list()).map((value) => value.id), ['case-29', 'case-boundary']);
});

test('retention cleans expired cases in batches of 100 with a cursor', async () => {
  const cases = new MemoryCaseRepository(Array.from({ length: 300 }, (_, index) => (
    caseRecord(`case-${String(index).padStart(3, '0')}`, '2026-07-31T12:00:00.000Z', index + 1)
  )));
  const listCalls = [];
  const originalListExpired = cases.listExpired.bind(cases);
  cases.listExpired = async (...args) => {
    listCalls.push(args);
    return originalListExpired(...args);
  };
  const service = new RetentionService({
    authRepository: new MemoryAuthRepository(),
    caseRepository: cases,
    reportExportRepository: new MemoryReportExportRepository(),
    screenshotRepository: new MemoryScreenshotRepository(),
    storageBackend: new MemoryStorageBackend(),
  }, { clock: () => new Date(NOW) });

  const result = await service.cleanup();

  assert.equal(result.candidateCases, 300);
  assert.equal(result.deletedCases, 300);
  assert.deepEqual(listCalls.map(([, limit]) => limit), [100, 100, 100]);
  assert.equal(listCalls[0][2], undefined);
  assert.ok(listCalls[1][2]);
  assert.ok(listCalls[2][2]);
  assert.equal((await cases.list()).length, 0);
});

test('retention removes storage objects before screenshot metadata and then the case', async () => {
  const events = [];
  const caseValue = caseRecord('case-order', '2026-07-31T12:00:00.000Z');
  const screenshotValue = screenshotRecord('screenshot-order', caseValue.id, 'private/order.jpg');
  const cases = new MemoryCaseRepository([caseValue]);
  const screenshots = new MemoryScreenshotRepository([screenshotValue]);
  const storage = new MemoryStorageBackend();
  await storage.put(screenshotValue.objectKey, Buffer.from('fixture'), screenshotValue.contentType);

  const originalStorageDelete = storage.delete.bind(storage);
  storage.delete = async (key) => {
    events.push(`storage:${key}`);
    await originalStorageDelete(key);
  };
  const originalScreenshotDelete = screenshots.delete.bind(screenshots);
  screenshots.delete = async (id) => {
    events.push(`screenshot:${id}`);
    await originalScreenshotDelete(id);
  };
  const originalCaseDelete = cases.delete.bind(cases);
  cases.delete = async (id) => {
    events.push(`case:${id}`);
    await originalCaseDelete(id);
  };

  const service = new RetentionService({
    authRepository: new MemoryAuthRepository(),
    caseRepository: cases,
    reportExportRepository: new MemoryReportExportRepository(),
    screenshotRepository: screenshots,
    storageBackend: storage,
  }, { clock: () => new Date(NOW) });

  await service.cleanup();

  assert.deepEqual(events, [
    'storage:private/order.jpg',
    'screenshot:screenshot-order',
    'case:case-order',
  ]);
  assert.equal(await storage.exists(screenshotValue.objectKey), false);
  assert.equal(await screenshots.findById(screenshotValue.id), null);
  assert.equal(await cases.findById(caseValue.id), null);
});

test('retention leaves failed data for the next run and retries it', async () => {
  const caseValue = caseRecord('case-retry', '2026-07-31T12:00:00.000Z');
  const screenshotValue = screenshotRecord('screenshot-retry', caseValue.id, 'private/retry.jpg');
  const cases = new MemoryCaseRepository([caseValue]);
  const screenshots = new MemoryScreenshotRepository([screenshotValue]);
  const storage = new MemoryStorageBackend();
  await storage.put(screenshotValue.objectKey, Buffer.from('fixture'), screenshotValue.contentType);
  let fail = true;
  const originalDelete = storage.delete.bind(storage);
  storage.delete = async (key) => {
    if (fail) throw new Error('synthetic storage outage');
    await originalDelete(key);
  };
  const service = new RetentionService({
    authRepository: new MemoryAuthRepository(),
    caseRepository: cases,
    reportExportRepository: new MemoryReportExportRepository(),
    screenshotRepository: screenshots,
    storageBackend: storage,
  }, { clock: () => new Date(NOW), logger: { warn() {} } });

  const first = await service.cleanup();
  assert.equal(first.failedObjects, 1);
  assert.ok(await cases.findById(caseValue.id));
  assert.ok(await screenshots.findById(screenshotValue.id));
  assert.ok(await storage.exists(screenshotValue.objectKey));

  fail = false;
  await service.cleanup();
  assert.equal(await cases.findById(caseValue.id), null);
  assert.equal(await screenshots.findById(screenshotValue.id), null);
});

test('retention removes expired report exports after their storage objects, keeps the cutoff, and retries failed objects', async () => {
  const expired = reportExportRecord(
    'report-expired',
    '2026-07-31T12:00:00.000Z',
    'report-exports/report-expired.xlsx',
  );
  const boundary = reportExportRecord(
    'report-boundary',
    CUTOFF.toISOString(),
    'report-exports/report-boundary.xlsx',
  );
  const fresh = reportExportRecord(
    'report-fresh',
    '2026-08-02T12:00:00.000Z',
    'report-exports/report-fresh.xlsx',
  );
  const retry = reportExportRecord(
    'report-retry',
    '2026-07-30T12:00:00.000Z',
    'report-exports/report-retry.xlsx',
  );
  const reportExports = new MemoryReportExportRepository([expired, boundary, fresh, retry]);
  const storage = new MemoryStorageBackend();
  await storage.put(expired.objectKey, Buffer.from('expired'), expired.contentType);
  await storage.put(retry.objectKey, Buffer.from('retry'), retry.contentType);
  const events = [];
  const originalStorageDelete = storage.delete.bind(storage);
  let failRetry = true;
  storage.delete = async (key) => {
    if (key === retry.objectKey && failRetry) throw new Error('synthetic storage outage');
    events.push(`storage:${key}`);
    await originalStorageDelete(key);
  };
  const originalReportExportDelete = reportExports.delete.bind(reportExports);
  reportExports.delete = async (id) => {
    events.push(`record:${id}`);
    await originalReportExportDelete(id);
  };
  const service = new RetentionService({
    authRepository: new MemoryAuthRepository(),
    caseRepository: new MemoryCaseRepository(),
    reportExportRepository: reportExports,
    screenshotRepository: new MemoryScreenshotRepository(),
    storageBackend: storage,
  }, { clock: () => new Date(NOW), logger: { warn() {} } });

  const first = await service.cleanup();

  assert.equal(first.deletedReportExports, 1);
  assert.equal(first.failedObjects, 1);
  assert.deepEqual(events, [
    `storage:${expired.objectKey}`,
    `record:${expired.id}`,
  ]);
  assert.equal(await reportExports.findById(expired.id), null);
  assert.ok(await reportExports.findById(boundary.id));
  assert.ok(await reportExports.findById(fresh.id));
  assert.ok(await reportExports.findById(retry.id));
  assert.equal(await storage.exists(expired.objectKey), false);
  assert.equal(await storage.exists(retry.objectKey), true);

  failRetry = false;
  const second = await service.cleanup();

  assert.equal(second.deletedReportExports, 1);
  assert.equal(await reportExports.findById(retry.id), null);
  assert.equal(await storage.exists(retry.objectKey), false);
});

test('retention removes expired and revoked sessions but never users or platform accounts', async () => {
  const auth = new MemoryAuthRepository([
    userRecord(ADMIN_ID, 'admin', 'admin'),
    userRecord(WORKER_ID, 'worker'),
  ], [
    sessionRecord('session-expired', WORKER_ID, '2026-08-31T11:59:59.000Z'),
    sessionRecord('session-revoked', WORKER_ID, '2026-09-01T00:00:00.000Z', '2026-08-30T00:00:00.000Z'),
    sessionRecord('session-live', WORKER_ID, '2026-09-01T00:00:00.000Z'),
  ]);
  const service = new RetentionService({
    authRepository: auth,
    caseRepository: new MemoryCaseRepository(),
    reportExportRepository: new MemoryReportExportRepository(),
    screenshotRepository: new MemoryScreenshotRepository(),
    storageBackend: new MemoryStorageBackend(),
  }, { clock: () => new Date(NOW) });

  await service.cleanup();

  assert.deepEqual((await auth.listSessions()).map((value) => value.id), ['session-live']);
  assert.equal((await auth.listUsers()).length, 2);
});

test('retention scheduler runs once on startup and can be ticked without a real timer', async () => {
  let runs = 0;
  const scheduled = [];
  const service = {
    async cleanup() {
      runs += 1;
      return {};
    },
  };
  const scheduler = new RetentionScheduler(service, {
    scheduleDaily(task) {
      scheduled.push(task);
      return () => {};
    },
  });

  await scheduler.start();
  await scheduler.start();
  assert.equal(runs, 1);
  assert.equal(scheduled.length, 1);

  await scheduled[0]();
  assert.equal(runs, 2);
  await scheduler.stop();
});

test('retention startup does not run cleanup before the app is listening', async () => {
  const authRepository = new MemoryAuthRepository();
  const caseRepository = new MemoryCaseRepository();
  const reportExportRepository = new MemoryReportExportRepository();
  const originalListExpired = caseRepository.listExpired.bind(caseRepository);
  let cleanupCalls = 0;
  let releaseCleanup;
  const cleanupReleased = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  caseRepository.listExpired = async (...args) => {
    cleanupCalls += 1;
    await cleanupReleased;
    return originalListExpired(...args);
  };
  const app = buildApp({
    config: config(),
    retention: { scheduleDaily: () => () => {} },
    dependencies: {
      database: { check: async () => true },
      objectStorage: { check: async () => true },
    },
    authRepository,
    caseRepository,
    reportExportRepository,
    screenshotRepository: new MemoryScreenshotRepository(),
    storageBackend: new MemoryStorageBackend(),
  });

  try {
    await app.ready();
    assert.equal(cleanupCalls, 0);
    await app.listen({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cleanupCalls, 1);
  } finally {
    releaseCleanup();
    await app.close();
  }
});

test('sync and screenshot upload reject data earlier than the retention cutoff', async () => {
  const authRepository = new MemoryAuthRepository();
  const platformAccountRepository = new MemoryPlatformAccountRepository([accountRecord()]);
  const caseRepository = new MemoryCaseRepository();
  const screenshotRepository = new MemoryScreenshotRepository();
  const storageBackend = new MemoryStorageBackend();
  const app = buildApp({
    config: config(),
    clock: () => new Date(NOW),
    retention: { scheduleDaily: () => () => {} },
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
  await addWorker(authRepository);

  try {
    const token = await loginExtension(app);
    const expiredSync = await app.inject({
      method: 'POST',
      url: '/sync/cases',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        batchId: 'batch-expired',
        items: [caseItem({ queryTime: '2026-07-31T12:00:00.000Z', sourceUpdatedAt: '2026-07-31T12:00:00.000Z' })],
      },
    });
    assert.equal(expiredSync.statusCode, 400);
    assert.equal(expiredSync.json().error.details[0].code, 'retention_expired');
    assert.equal((await caseRepository.list()).length, 0);

    const accepted = await app.inject({
      method: 'POST',
      url: '/sync/cases',
      headers: { authorization: `Bearer ${token}` },
      payload: { batchId: 'batch-fresh', items: [caseItem()] },
    });
    assert.equal(accepted.statusCode, 200);
    const caseId = accepted.json().accepted[0].id;

    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const expiredUpload = multipart({
      eventId: 'event-expired-screenshot',
      type: 'success',
      capturedAt: '2026-07-31T12:00:00.000Z',
      sha256: createHash('sha256').update(buffer).digest('hex'),
    }, buffer);
    const upload = await app.inject({
      method: 'POST',
      url: `/cases/${caseId}/screenshots`,
      headers: { authorization: `Bearer ${token}`, ...expiredUpload.headers },
      payload: expiredUpload.payload,
    });
    assert.equal(upload.statusCode, 400);
    assert.equal(upload.json().error.details[0].code, 'retention_expired');
    assert.equal((await screenshotRepository.listByCaseId(caseId)).length, 0);
    assert.equal(await storageBackend.exists('unused'), false);
  } finally {
    await app.close();
  }
});
