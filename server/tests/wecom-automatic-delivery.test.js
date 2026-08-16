import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { newDb } from 'pg-mem';

import { runMigrations, rollbackLastMigration } from '../src/db/migrator.ts';
import { MemoryCaseRepository } from '../src/cases/memory-repository.ts';
import { MemoryPlatformAccountRepository } from '../src/platform-accounts/memory-repository.ts';
import { MemoryScreenshotRepository } from '../src/screenshots/memory-repository.ts';
import { MemoryStorageBackend } from '../src/storage/memory.ts';
import { MemoryWecomNotificationRepository } from '../src/wecom-notifications/memory-repository.ts';
import { PgWecomNotificationRepository } from '../src/wecom-notifications/repository.ts';
import { WecomNotificationService } from '../src/wecom-notifications/service.ts';
import { buildApp, loadConfig } from '../src/app.ts';
import { MemoryAuthRepository } from '../src/auth/memory-repository.ts';

const ACCOUNT_ID = '00000000-0000-0000-0000-000000000010';
const USER_ID = '00000000-0000-0000-0000-000000000020';
const WEBHOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-test-key';
const IMAGE = Buffer.from('synthetic-automatic-image');

function account(overrides = {}) {
  const now = new Date('2026-08-12T00:00:00.000Z');
  return {
    id: ACCOUNT_ID,
    label: 'synthetic-account',
    secretCiphertext: Buffer.from('ciphertext'),
    secretIv: Buffer.alloc(12, 1),
    secretTag: Buffer.alloc(16, 2),
    secretVersion: 1,
    enabled: true,
    deletedAt: null,
    createdBy: USER_ID,
    createdAt: now,
    updatedAt: now,
    salespersonMobile: '13800138000',
    assistantMobile: '13900139000',
    ...overrides,
  };
}

async function fixture({ status = '已驳回', kind = 'li', contacts = true, transport } = {}) {
  const cases = new MemoryCaseRepository();
  const accounts = new MemoryPlatformAccountRepository([account(contacts ? {} : {
    salespersonMobile: null,
    assistantMobile: null,
  })]);
  const screenshots = new MemoryScreenshotRepository();
  const storage = new MemoryStorageBackend();
  const notifications = new MemoryWecomNotificationRepository();
  const caseValue = await cases.create({
    createdBy: USER_ID,
    clientUid: `client-${status}`,
    platformAccountId: ACCOUNT_ID,
    kind,
    plaintiff: '脱敏原告',
    defendant: '脱敏被告',
    status,
    filedTime: null,
    caseNumber: 'SYNTHETIC-001',
    rejectTime: status === '已驳回' ? '2026-08-12' : null,
    rejectReason: status === '已驳回' ? '脱敏相关内容' : null,
    queryTime: new Date('2026-08-12T01:00:00.000Z'),
    needsHuman: false,
    errorCode: null,
    sourceEventId: `event-${status}`,
    sourceUpdatedAt: new Date('2026-08-12T01:00:00.000Z'),
  });
  const screenshotType = status === '已驳回' ? 'reject' : kind === 'qz' ? 'enforcement_success' : 'success';
  const screenshot = await screenshots.create({
    caseId: caseValue.id,
    type: screenshotType,
    objectKey: `screenshots/synthetic/${screenshotType}.png`,
    contentType: 'image/png',
    byteSize: IMAGE.length,
    sha256: createHash('sha256').update(IMAGE).digest('hex'),
    capturedAt: new Date('2026-08-12T01:00:00.000Z'),
  });
  await storage.put(screenshot.objectKey, IMAGE, 'image/png');
  const calls = [];
  const service = new WecomNotificationService(
    WEBHOOK,
    cases,
    accounts,
    screenshots,
    notifications,
    storage,
    transport ?? (async (url, payload) => { calls.push({ url, payload }); return { errcode: 0 }; }),
  );
  return { service, calls, notifications, caseValue, screenshot, cases, accounts };
}

test('migration adds platform contacts and a reversible unique automatic-notification ledger', async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool();
  const applied = await runMigrations(pool);
  assert.equal(applied.at(-1), '011_wecom_automatic_notifications');
  const columns = await pool.query(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE (table_name = 'platform_accounts' AND column_name IN ('salesperson_mobile', 'assistant_mobile'))
       OR table_name = 'wecom_notifications'
  `);
  assert.ok(columns.rows.some((row) => row.table_name === 'platform_accounts' && row.column_name === 'salesperson_mobile'));
  assert.ok(columns.rows.some((row) => row.table_name === 'wecom_notifications' && row.column_name === 'result_status'));
  assert.equal(await rollbackLastMigration(pool), '011_wecom_automatic_notifications');
  const rolledBack = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_name = 'wecom_notifications'`);
  assert.equal(rolledBack.rows.length, 0);
  await pool.end();
});

test('postgres notification repository explicitly creates a pending ledger record', async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool();
  await runMigrations(pool);
  const caseId = '00000000-0000-0000-0000-000000000030';
  const screenshotId = '00000000-0000-0000-0000-000000000040';
  await pool.query(`INSERT INTO users (id,username,password_hash) VALUES ($1,'synthetic-user','synthetic-hash')`, [USER_ID]);
  await pool.query(`INSERT INTO platform_accounts (id,label,secret_ciphertext,secret_iv,secret_tag,created_by) VALUES ($1,'synthetic-account',$2,$3,$4,$5)`, [ACCOUNT_ID, Buffer.from('ciphertext'), Buffer.alloc(12, 1), Buffer.alloc(16, 2), USER_ID]);
  await pool.query(`INSERT INTO cases (id,client_uid,platform_account_id,kind,status) VALUES ($1,'synthetic-client',$2,'li','立案成功')`, [caseId, ACCOUNT_ID]);
  await pool.query(`INSERT INTO screenshots (id,case_id,type,object_key,content_type,byte_size,sha256,captured_at) VALUES ($1,$2,'success','screenshots/synthetic/pending.png','image/png',1,$3,NOW())`, [screenshotId, caseId, '0'.repeat(64)]);

  const repository = new PgWecomNotificationRepository(pool);
  const created = await repository.createPending({
    caseId,
    platformAccountId: ACCOUNT_ID,
    resultStatus: '立案成功',
    screenshotId,
  });

  assert.equal(created.created, true);
  assert.equal(created.record.status, 'pending');
  assert.equal(created.record.attemptCount, 0);
  await pool.end();
});

test('all three terminal results automatically send once and mention platform-bound contacts', async () => {
  for (const sample of [
    { status: '立案成功', kind: 'li' },
    { status: '强执成功', kind: 'qz' },
    { status: '已驳回', kind: 'li' },
  ]) {
    const state = await fixture(sample);
    const [first, duplicate] = await Promise.all([
      state.service.enqueueAutomatic(state.caseValue.id, state.screenshot.id),
      state.service.enqueueAutomatic(state.caseValue.id, state.screenshot.id),
    ]);
    await state.service.waitForIdle();
    assert.equal([first.created, duplicate.created].filter(Boolean).length, 1);
    assert.equal(state.calls.length, 2);
    assert.deepEqual(state.calls[1].payload.text.mentioned_mobile_list, ['13800138000', '13900139000']);
    const records = await state.notifications.listByCaseId(state.caseValue.id);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'sent');
    assert.equal(records[0].attemptCount, 1);
  }
});

test('non-terminal results do not create notifications and missing contacts fail without network access', async () => {
  const pending = await fixture({ status: '审核中' });
  assert.deepEqual(await pending.service.enqueueAutomatic(pending.caseValue.id, pending.screenshot.id), { created: false, notification: null });
  assert.equal((await pending.notifications.listByCaseId(pending.caseValue.id)).length, 0);
  assert.equal(pending.calls.length, 0);

  const missing = await fixture({ contacts: false });
  const result = await missing.service.enqueueAutomatic(missing.caseValue.id, missing.screenshot.id);
  await missing.service.waitForIdle();
  assert.equal(result.created, true);
  const [record] = await missing.notifications.listByCaseId(missing.caseValue.id);
  assert.equal(record.status, 'failed');
  assert.equal(record.errorCode, 'CONTACTS_NOT_CONFIGURED');
  assert.equal(record.attemptCount, 0);
  assert.equal(missing.calls.length, 0);
});

test('failed delivery stays failed until one explicit retry and never loops automatically', async () => {
  let reject = true;
  const state = await fixture({ transport: async (_url, payload) => {
    state.calls.push({ payload });
    return reject ? { errcode: 93000 } : { errcode: 0 };
  } });
  const created = await state.service.enqueueAutomatic(state.caseValue.id, state.screenshot.id);
  await state.service.waitForIdle();
  let record = await state.notifications.findById(created.notification.id);
  assert.equal(record.status, 'failed');
  assert.equal(record.attemptCount, 1);
  assert.equal(state.calls.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 20));
  record = await state.notifications.findById(record.id);
  assert.equal(record.attemptCount, 1);
  assert.equal(state.calls.length, 1);

  reject = false;
  await state.service.retry(record.id, { userId: USER_ID, role: 'user' });
  record = await state.notifications.findById(record.id);
  assert.equal(record.status, 'sent');
  assert.equal(record.attemptCount, 2);
  assert.equal(state.calls.length, 3);
});

test('a failed manual retry reaches a stable retry limit and cannot send a third time', async () => {
  const state = await fixture({ transport: async (_url, payload) => {
    state.calls.push({ payload });
    return { errcode: 93000 };
  } });
  const created = await state.service.enqueueAutomatic(state.caseValue.id, state.screenshot.id);
  await state.service.waitForIdle();
  await assert.rejects(
    state.service.retry(created.notification.id, { userId: USER_ID, role: 'user' }),
    (error) => error.code === 'WECOM_DELIVERY_FAILED',
  );
  assert.equal((await state.notifications.findById(created.notification.id)).attemptCount, 2);
  const callsAfterRetry = state.calls.length;
  await assert.rejects(
    state.service.retry(created.notification.id, { userId: USER_ID, role: 'user' }),
    (error) => error.code === 'WECOM_RETRY_LIMIT',
  );
  assert.equal(state.calls.length, callsAfterRetry);
});

test('notification delivery rejects a changed case status instead of mixing old evidence with new text', async () => {
  const state = await fixture({ status: '立案成功', kind: 'li' });
  const pending = await state.notifications.createPending({
    caseId: state.caseValue.id,
    platformAccountId: ACCOUNT_ID,
    resultStatus: '立案成功',
    screenshotId: state.screenshot.id,
  });
  await state.notifications.markFailed(pending.record.id, 'WECOM_DELIVERY_FAILED');
  await state.cases.update(state.caseValue.id, { ...state.caseValue, status: '已驳回' });
  await assert.rejects(
    state.service.retry(pending.record.id, { userId: USER_ID, role: 'user' }),
    (error) => error.code === 'WECOM_SOURCE_CHANGED',
  );
  assert.equal(state.calls.length, 0);
});

test('a precondition failure permits only one manual delivery attempt', async () => {
  const state = await fixture({ contacts: false, transport: async (_url, payload) => {
    state.calls.push({ payload });
    return { errcode: 93000 };
  } });
  const created = await state.service.enqueueAutomatic(state.caseValue.id, state.screenshot.id);
  await state.accounts.update(ACCOUNT_ID, { salespersonMobile: '13800138000', assistantMobile: '13900139000' });
  await assert.rejects(
    state.service.retry(created.notification.id, { userId: USER_ID, role: 'user' }),
    (error) => error.code === 'WECOM_DELIVERY_FAILED',
  );
  await assert.rejects(
    state.service.retry(created.notification.id, { userId: USER_ID, role: 'user' }),
    (error) => error.code === 'WECOM_RETRY_LIMIT',
  );
});

test('screenshot upload triggers automatic delivery and repeated upload stays idempotent', async () => {
  const authRepository = new MemoryAuthRepository();
  const cases = new MemoryCaseRepository();
  const accounts = new MemoryPlatformAccountRepository([account()]);
  const screenshots = new MemoryScreenshotRepository();
  const storage = new MemoryStorageBackend();
  const notifications = new MemoryWecomNotificationRepository();
  const createPending = notifications.createPending.bind(notifications);
  let notificationLedgerAttempted = false;
  notifications.createPending = async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    notificationLedgerAttempted = true;
    return createPending(input);
  };
  const calls = [];
  const config = loadConfig({ PORT: '3121', DATABASE_URL: 'postgres://test:test@localhost/test', CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 5).toString('base64'), CORS_EXTENSION_ORIGINS: 'chrome-extension://test', CORS_ADMIN_ORIGINS: 'https://admin.example.test', OBJECT_STORAGE_ENDPOINT: 'https://storage.example.test', OBJECT_STORAGE_BUCKET: 'test', ADMIN_INITIAL_PASSWORD: 'Admin-pass-1', WECOM_WEBHOOK_URL: WEBHOOK });
  const app = buildApp({ config, authRepository, platformAccountRepository: accounts, caseRepository: cases, screenshotRepository: screenshots, wecomNotificationRepository: notifications, storageBackend: storage, dependencies: { database: { check: async () => true }, objectStorage: storage }, wecomTransport: async (_url, payload) => { calls.push(payload); return { errcode: 0 }; } });
  await app.ready();
  try {
    const admin = await authRepository.findUserByUsername('admin');
    const caseValue = await cases.create({ createdBy: admin.id, clientUid: 'upload-auto', platformAccountId: ACCOUNT_ID, kind: 'li', plaintiff: '脱敏原告', defendant: '脱敏被告', status: '已驳回', filedTime: null, caseNumber: null, rejectTime: '2026-08-12', rejectReason: '脱敏内容', queryTime: new Date('2026-08-12T01:00:00Z'), needsHuman: false, errorCode: null, sourceEventId: 'upload-event', sourceUpdatedAt: new Date('2026-08-12T01:00:00Z') });
    const login = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin: 'https://admin.example.test' }, payload: { username: 'admin', password: 'Admin-pass-1', clientType: 'admin_ui' } });
    const cookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'][0] : login.headers['set-cookie']).split(';', 1)[0];
    const boundary = '----wecom-auto';
    const hash = createHash('sha256').update(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')).digest('hex');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="eventId"\r\n\r\nevent-auto\r\n--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\nreject\r\n--${boundary}\r\nContent-Disposition: form-data; name="capturedAt"\r\n\r\n2026-08-12T01:00:00.000Z\r\n--${boundary}\r\nContent-Disposition: form-data; name="sha256"\r\n\r\n${hash}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="evidence.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({ method: 'POST', url: `/cases/${caseValue.id}/screenshots`, headers: { origin: 'https://admin.example.test', cookie, 'x-csrf-token': login.json().csrfToken, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
      assert.ok([200, 201].includes(response.statusCode));
      assert.equal(notificationLedgerAttempted, true);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 2);
    assert.equal((await notifications.listByCaseId(caseValue.id)).length, 1);
  } finally { await app.close(); }
});
