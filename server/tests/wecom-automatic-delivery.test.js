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
import { WecomNotificationService } from '../src/wecom-notifications/service.ts';

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
  return { service, calls, notifications, caseValue, screenshot };
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
