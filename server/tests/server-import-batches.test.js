import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { newDb } from 'pg-mem';
import ExcelJS from 'exceljs';

import { buildApp, loadConfig } from '../src/app.ts';
import { hashPassword } from '../src/auth/password.ts';
import { MemoryAuthRepository } from '../src/auth/memory-repository.ts';
import { runMigrations } from '../src/db/migrator.ts';
import { MemoryImportBatchRepository } from '../src/import-batches/memory-repository.ts';
import { PgImportBatchRepository } from '../src/import-batches/repository.ts';
import { MAX_IMPORT_BATCH_BYTES } from '../src/import-batches/service.ts';
import { IMPORT_BATCH_CONTENT_TYPE } from '../src/import-batches/types.ts';
import { MemoryStorageBackend } from '../src/storage/memory.ts';
import { bindPairedExtensionRepository, pairedExtensionTokenForApp } from './paired-extension.ts';

const TEST_KEY = Buffer.alloc(32, 41).toString('base64');
const ADMIN_PASSWORD = 'Admin-pass-1';
const USER_PASSWORD = 'Worker-pass-1';
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000002';
const NOW = new Date('2026-08-06T08:00:00.000Z');
const LI_HEADERS = [
  '原告', '被告', '账号', '密码', '立案状态', '立案成功时间', '案号',
  '成功图片', '驳回时间', '驳回原因', '驳回图片', '查询时间',
];
const QZ_HEADERS = [
  '原告', '被告', '账号', '密码', '强执状态', '强执成功时间', '强执案号',
  '成功图片', '驳回时间', '驳回原因', '驳回图片', '查询时间',
];
const COMBINED_HEADERS = [
  ...LI_HEADERS.slice(0, 11), '立案查询时间',
  '强执状态', '强执成功时间', '强执案号', '成功图片',
  '驳回时间', '驳回原因', '驳回图片', '强执查询时间',
];
const FIXTURE_ACCOUNT = 'fixture-account';
const FIXTURE_PASSWORD = 'fixture-password';

function config() {
  return loadConfig({
    PORT: '3116',
    DATABASE_URL: 'postgres://test:secret@localhost:5432/court_helper',
    CREDENTIAL_MASTER_KEY: TEST_KEY,
    CORS_EXTENSION_ORIGINS: 'chrome-extension://test-extension',
    CORS_ADMIN_ORIGINS: 'https://admin.example.test',
    OBJECT_STORAGE_ENDPOINT: 'https://cos.example.test',
    OBJECT_STORAGE_BUCKET: 'private-test-bucket',
    ADMIN_INITIAL_PASSWORD: ADMIN_PASSWORD,
  });
}

class CountingStorageBackend extends MemoryStorageBackend {
  putCount = 0;
  deleteCount = 0;
  events = [];

  async put(key, buffer, contentType) {
    this.putCount += 1;
    this.events.push(`put:${key}`);
    return super.put(key, buffer, contentType);
  }

  async delete(key) {
    this.deleteCount += 1;
    this.events.push(`delete:${key}`);
    return super.delete(key);
  }
}

class FailingImportBatchRepository extends MemoryImportBatchRepository {
  async create() {
    throw new Error('synthetic database failure');
  }
}

function addRows(sheet, options) {
  if (!options.skipLiRows) {
    sheet.getRow(2).values = [
      'fixture-li-plaintiff', 'fixture-li-defendant', FIXTURE_ACCOUNT, FIXTURE_PASSWORD,
    ];
    sheet.getRow(3).values = ['fixture-skipped-plaintiff'];
  }
  if (!options.noEnforcementHeader) {
    sheet.getRow(5).values = QZ_HEADERS;
    sheet.getRow(6).values = [
      'fixture-qz-plaintiff', 'fixture-qz-defendant', 'fixture-qz-account', FIXTURE_PASSWORD,
    ];
  }
}

async function workbookBuffer(options = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(options.sheetName ?? 'Sheet1');
  sheet.getRow(1).values = options.headers ?? LI_HEADERS;
  addRows(sheet, options);

  if (options.rowCount) sheet.getCell(options.rowCount, 1).value = 'x';
  if (options.columnCount) sheet.getCell(1, options.columnCount).value = 'extra';
  if (options.sheetCount === 2) workbook.addWorksheet('Sheet2');
  if (options.sheetCount === 3) {
    workbook.addWorksheet('Sheet2');
    workbook.addWorksheet('Sheet3');
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function combinedWorkbookBuffer(options = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.getRow(1).values = options.headers ?? COMBINED_HEADERS;
  if (options.withRows) {
    sheet.getRow(2).values = [
      'fixture-combined-plaintiff', 'fixture-combined-defendant', FIXTURE_ACCOUNT, FIXTURE_PASSWORD,
    ];
    sheet.getRow(3).values = ['fixture-combined-skipped'];
  } else {
    sheet.getCell(11, 20).style = { alignment: { horizontal: 'center' } };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function multipart(parts) {
  const boundary = '----court-helper-import-batch-boundary';
  const chunks = [];
  const add = (value) => chunks.push(Buffer.from(value, 'utf8'));

  for (const part of parts) {
    add(`--${boundary}\r\n`);
    if (part.type === 'file') {
      add(`Content-Disposition: form-data; name="${part.fieldName ?? 'file'}"; filename="${part.fileName ?? 'batch.xlsx'}"\r\n`);
      add(`Content-Type: ${part.contentType ?? IMPORT_BATCH_CONTENT_TYPE}\r\n\r\n`);
      chunks.push(part.buffer);
      add('\r\n');
      continue;
    }
    add(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`);
    add(`${part.value}\r\n`);
  }
  add(`--${boundary}--\r\n`);
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function uploadPayload(buffer, overrides = {}) {
  return multipart([{
    type: 'file',
    buffer,
    fileName: overrides.fileName ?? 'batch.xlsx',
    contentType: overrides.contentType ?? IMPORT_BATCH_CONTENT_TYPE,
    fieldName: overrides.fieldName,
  }]);
}

async function makeApp(options = {}) {
  const authRepository = new MemoryAuthRepository();
  const importBatchRepository = options.importBatchRepository ?? new MemoryImportBatchRepository();
  const storageBackend = options.storageBackend ?? new CountingStorageBackend();
  const app = buildApp({
    config: config(),
    clock: () => new Date(NOW),
    dependencies: {
      database: { check: async () => true },
      objectStorage: storageBackend,
    },
    authRepository,
    importBatchRepository,
    storageBackend,
  });
  await app.ready();
  bindPairedExtensionRepository(app, authRepository);
  await authRepository.createUser({
    id: USER_ID,
    username: 'worker',
    passwordHash: await hashPassword(USER_PASSWORD),
    role: 'user',
    enabled: true,
  });
  return { app, authRepository, importBatchRepository, storageBackend };
}

function cookieHeader(response) {
  const value = response.headers['set-cookie'];
  const first = Array.isArray(value) ? value[0] : value;
  assert.ok(first, 'expected admin UI session cookie');
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
  return {
    cookie: cookieHeader(response),
    csrfToken: response.json().csrfToken,
    userId: response.json().id,
  };
}

async function loginExtension(app) {
  return (await pairedExtensionTokenForApp(app)).token;
}

function cookieWriteHeaders(session) {
  return {
    cookie: session.cookie,
    origin: 'https://admin.example.test',
    'x-csrf-token': session.csrfToken,
  };
}

async function upload(app, session, payload) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/import-batches',
    headers: { ...cookieWriteHeaders(session), ...payload.headers },
    payload: payload.payload,
  });
}

function errorCode(response) {
  return response.json().error.code;
}

function errorDetailCode(response) {
  return response.json().error.details[0]?.code;
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('admin_ui Cookie upload creates a safe global import batch and any signed-in UI user can list and download it', async () => {
  const { app, importBatchRepository, storageBackend } = await makeApp();

  try {
    const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
    const content = await workbookBuffer();
    const response = await upload(app, admin, uploadPayload(content, {
      fileName: '../批次<fixture>（一）.xlsx',
    }));

    assert.equal(response.statusCode, 201);
    const created = response.json();
    assert.deepEqual(Object.keys(created).sort(), [
      'byteSize', 'canDelete', 'createdAt', 'expiresAt', 'fileName', 'id', 'liRows', 'qzRows', 'sha256', 'skippedRows', 'updatedAt',
    ]);
    assert.equal(created.canDelete, true);
    assert.equal(created.fileName, '批次fixture（一）.xlsx');
    assert.equal(created.byteSize, content.length);
    assert.equal(created.sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(created.liRows, 1);
    assert.equal(created.qzRows, 1);
    assert.equal(created.skippedRows, 1);
    assert.equal(created.createdAt, NOW.toISOString());
    assert.equal(created.updatedAt, NOW.toISOString());
    assert.equal(created.expiresAt, '2026-09-05T08:00:00.000Z');
    assert.equal(response.body.includes(FIXTURE_ACCOUNT), false);
    assert.equal(response.body.includes(FIXTURE_PASSWORD), false);
    assert.equal(response.body.includes('objectKey'), false);

    const record = await importBatchRepository.findById(created.id);
    assert.ok(record);
    assert.equal(record.createdBy, admin.userId);
    assert.match(record.objectKey, /^import-batches\/[0-9a-f-]{36}\.xlsx$/);
    assert.equal(await storageBackend.exists(record.objectKey), true);
    assert.deepEqual(await readStream(await storageBackend.get(record.objectKey)), content);

    const worker = await loginUi(app, 'worker', USER_PASSWORD);
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/import-batches',
      headers: { cookie: worker.cookie },
    });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(Object.keys(listed.json()).sort(), ['importBatches', 'nextCursor']);
    assert.deepEqual(listed.json().importBatches.map((item) => item.id), [created.id]);
    assert.equal(listed.json().importBatches[0].canDelete, false);
    assert.equal(listed.body.includes(FIXTURE_ACCOUNT), false);
    assert.equal(listed.body.includes(FIXTURE_PASSWORD), false);
    assert.equal(listed.body.includes('objectKey'), false);

    const downloaded = await app.inject({
      method: 'GET',
      url: `/api/v1/import-batches/${created.id}/content`,
      headers: { cookie: worker.cookie },
    });
    assert.equal(downloaded.statusCode, 200);
    assert.equal(downloaded.headers['cache-control'], 'private, no-store');
    assert.equal(downloaded.headers['x-content-sha256'], created.sha256);
    assert.match(downloaded.headers['content-disposition'], /^attachment; filename\*=UTF-8''/);
    assert.deepEqual(downloaded.rawPayload, content);

    const rootRoute = await app.inject({
      method: 'GET',
      url: '/import-batches',
      headers: { cookie: worker.cookie },
    });
    assert.equal(rootRoute.statusCode, 404);

    const workerUpload = await upload(app, worker, uploadPayload(content, { fileName: 'worker-batch.xlsx' }));
    assert.equal(workerUpload.statusCode, 201);
    assert.notEqual(workerUpload.json().id, created.id);
    const workerRecord = await importBatchRepository.findById(workerUpload.json().id);
    assert.ok(workerRecord);
    assert.equal(workerRecord.createdBy, worker.userId);
  } finally {
    await app.close();
  }
});

test('combined 20-column templates upload with independent layout validation and safe summaries', async () => {
  const { app } = await makeApp();
  try {
    const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
    const blank = await upload(app, admin, uploadPayload(await combinedWorkbookBuffer()));
    assert.equal(blank.statusCode, 201);
    assert.equal(blank.json().liRows, 0);
    assert.equal(blank.json().qzRows, 0);
    assert.equal(blank.json().skippedRows, 0);

    const populated = await upload(app, admin, uploadPayload(await combinedWorkbookBuffer({ withRows: true })));
    assert.equal(populated.statusCode, 201);
    assert.equal(populated.json().liRows, 1);
    assert.equal(populated.json().qzRows, 1);
    assert.equal(populated.json().skippedRows, 1);
    assert.equal(populated.body.includes(FIXTURE_ACCOUNT), false);
    assert.equal(populated.body.includes(FIXTURE_PASSWORD), false);

    const invalidHeader = [...COMBINED_HEADERS];
    invalidHeader[19] = '自定义扩展列';
    const invalid = await upload(app, admin, uploadPayload(await combinedWorkbookBuffer({ headers: invalidHeader })));
    assert.equal(invalid.statusCode, 400);
    assert.equal(errorDetailCode(invalid), 'template_mismatch');
  } finally {
    await app.close();
  }
});

test('import batch deletion enforces ownership and removes private content before metadata', async () => {
  const { app, importBatchRepository, storageBackend } = await makeApp();
  try {
    const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
    const worker = await loginUi(app, 'worker', USER_PASSWORD);
    const adminUpload = await upload(app, admin, uploadPayload(await combinedWorkbookBuffer(), { fileName: 'admin.xlsx' }));
    const workerUpload = await upload(app, worker, uploadPayload(await combinedWorkbookBuffer(), { fileName: 'worker.xlsx' }));
    const adminRecord = await importBatchRepository.findById(adminUpload.json().id);
    const workerRecord = await importBatchRepository.findById(workerUpload.json().id);
    assert.ok(adminRecord);
    assert.ok(workerRecord);

    const forbidden = await app.inject({
      method: 'DELETE',
      url: `/api/v1/import-batches/${adminRecord.id}`,
      headers: cookieWriteHeaders(worker),
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(await storageBackend.exists(adminRecord.objectKey), true);
    assert.ok(await importBatchRepository.findById(adminRecord.id));

    const ownDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/import-batches/${workerRecord.id}`,
      headers: cookieWriteHeaders(worker),
    });
    assert.equal(ownDelete.statusCode, 204);
    assert.equal(await storageBackend.exists(workerRecord.objectKey), false);
    assert.equal(await importBatchRepository.findById(workerRecord.id), null);

    const adminDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/import-batches/${adminRecord.id}`,
      headers: cookieWriteHeaders(admin),
    });
    assert.equal(adminDelete.statusCode, 204);
    assert.equal(await storageBackend.exists(adminRecord.objectKey), false);
    assert.equal(await importBatchRepository.findById(adminRecord.id), null);
  } finally {
    await app.close();
  }
});

test('import batch routes require admin_ui authentication and reject extension bearer access', async () => {
  const { app } = await makeApp();

  try {
    const content = await workbookBuffer();
    const payload = uploadPayload(content);
    const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
    const extensionToken = await loginExtension(app);

    const missingWriteHeaders = await app.inject({
      method: 'POST',
      url: '/api/v1/import-batches',
      headers: { cookie: admin.cookie, ...payload.headers },
      payload: payload.payload,
    });
    assert.equal(missingWriteHeaders.statusCode, 403);
    assert.equal(errorCode(missingWriteHeaders), 'FORBIDDEN');

    const bearer = await app.inject({
      method: 'POST',
      url: '/api/v1/import-batches',
      headers: { authorization: `Bearer ${extensionToken}`, ...payload.headers },
      payload: payload.payload,
    });
    assert.equal(bearer.statusCode, 403);
    assert.equal(errorCode(bearer), 'FORBIDDEN');

    const fakeCookie = await app.inject({
      method: 'GET',
      url: '/api/v1/import-batches',
      headers: { cookie: 'court_helper_session=not-a-real-session' },
    });
    assert.equal(fakeCookie.statusCode, 401);
    assert.equal(errorCode(fakeCookie), 'AUTH_REQUIRED');

    const bearerList = await app.inject({
      method: 'GET',
      url: '/api/v1/import-batches',
      headers: { authorization: `Bearer ${extensionToken}` },
    });
    assert.equal(bearerList.statusCode, 403);
    assert.equal(errorCode(bearerList), 'FORBIDDEN');
  } finally {
    await app.close();
  }
});

test('import batch upload rejects multipart, MIME, magic, template, and dimensional violations without leaking parsed data', async () => {
  const { app } = await makeApp();

  try {
    const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
    const valid = await workbookBuffer();
    const headers = cookieWriteHeaders(admin);

    const nonMultipart = await app.inject({
      method: 'POST',
      url: '/api/v1/import-batches',
      headers,
      payload: { file: 'not-a-file' },
    });
    assert.equal(nonMultipart.statusCode, 400);
    assert.equal(errorDetailCode(nonMultipart), 'multipart_required');

    const extraFieldPayload = multipart([
      { type: 'field', name: 'sha256', value: 'not-allowed' },
      { type: 'file', buffer: valid },
    ]);
    const extraField = await app.inject({
      method: 'POST',
      url: '/api/v1/import-batches',
      headers: { ...headers, ...extraFieldPayload.headers },
      payload: extraFieldPayload.payload,
    });
    assert.equal(extraField.statusCode, 400);
    assert.equal(errorDetailCode(extraField), 'unexpected_field');

    const wrongPartPayload = multipart([{ type: 'file', fieldName: 'other', buffer: valid }]);
    const wrongPart = await app.inject({
      method: 'POST',
      url: '/api/v1/import-batches',
      headers: { ...headers, ...wrongPartPayload.headers },
      payload: wrongPartPayload.payload,
    });
    assert.equal(wrongPart.statusCode, 400);
    assert.equal(errorDetailCode(wrongPart), 'unexpected_file');

    const multipleFilesPayload = multipart([
      { type: 'file', buffer: valid, fileName: 'first.xlsx' },
      { type: 'file', buffer: valid, fileName: 'second.xlsx' },
    ]);
    const multipleFiles = await app.inject({
      method: 'POST',
      url: '/api/v1/import-batches',
      headers: { ...headers, ...multipleFilesPayload.headers },
      payload: multipleFilesPayload.payload,
    });
    assert.equal(multipleFiles.statusCode, 400);
    assert.equal(errorDetailCode(multipleFiles), 'unexpected_file');

    const wrongMime = await upload(app, admin, uploadPayload(valid, { contentType: 'application/octet-stream' }));
    assert.equal(wrongMime.statusCode, 400);
    assert.equal(errorDetailCode(wrongMime), 'mime_mismatch');

    const badMagic = await upload(app, admin, uploadPayload(Buffer.from('not-a-zip')));
    assert.equal(badMagic.statusCode, 400);
    assert.equal(errorDetailCode(badMagic), 'magic_not_allowed');

    const missingSheet = await upload(app, admin, uploadPayload(await workbookBuffer({ sheetName: 'NotSheet1' })));
    assert.equal(missingSheet.statusCode, 400);
    assert.equal(errorDetailCode(missingSheet), 'sheet_required');

    const badHeader = await upload(app, admin, uploadPayload(await workbookBuffer({
      headers: ['错误表头', ...LI_HEADERS.slice(1)],
    })));
    assert.equal(badHeader.statusCode, 400);
    assert.equal(errorDetailCode(badHeader), 'template_mismatch');

    const missingQzHeader = await upload(app, admin, uploadPayload(await workbookBuffer({ noEnforcementHeader: true })));
    assert.equal(missingQzHeader.statusCode, 400);
    assert.equal(errorDetailCode(missingQzHeader), 'enforcement_header_required');

    const tooManySheets = await upload(app, admin, uploadPayload(await workbookBuffer({ sheetCount: 3 })));
    assert.equal(tooManySheets.statusCode, 400);
    assert.equal(errorDetailCode(tooManySheets), 'template_limit_exceeded');

    const tooManyRows = await upload(app, admin, uploadPayload(await workbookBuffer({ rowCount: 5001 })));
    assert.equal(tooManyRows.statusCode, 400);
    assert.equal(errorDetailCode(tooManyRows), 'template_limit_exceeded');

    const tooManyColumns = await upload(app, admin, uploadPayload(await workbookBuffer({ columnCount: 21 })));
    assert.equal(tooManyColumns.statusCode, 400);
    assert.equal(errorDetailCode(tooManyColumns), 'template_limit_exceeded');

    const oversized = await upload(app, admin, uploadPayload(Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(MAX_IMPORT_BATCH_BYTES + 1),
    ])));
    assert.equal(oversized.statusCode, 413);
    assert.equal(errorCode(oversized), 'PAYLOAD_TOO_LARGE');
  } finally {
    await app.close();
  }
});

test('import batches paginate by descending creation cursor, normalize missing content to 404, and compensate an object write when metadata persistence fails', async () => {
  const records = [
    importBatchRecord('00000000-0000-0000-0000-000000000101', '2026-08-06T08:03:00.000Z'),
    importBatchRecord('00000000-0000-0000-0000-000000000102', '2026-08-06T08:02:00.000Z'),
    importBatchRecord('00000000-0000-0000-0000-000000000103', '2026-08-06T08:01:00.000Z'),
  ];
  const { app, importBatchRepository, storageBackend } = await makeApp({
    importBatchRepository: new MemoryImportBatchRepository(records),
  });

  try {
    const admin = await loginUi(app, 'admin', ADMIN_PASSWORD);
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/import-batches?limit=2',
      headers: { cookie: admin.cookie },
    });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json().importBatches.map((item) => item.id), records.slice(0, 2).map((item) => item.id));
    assert.equal(typeof first.json().nextCursor, 'string');

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/import-batches?limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: { cookie: admin.cookie },
    });
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json().importBatches.map((item) => item.id), [records[2].id]);
    assert.equal(second.json().nextCursor, null);

    const invalidCursor = await app.inject({
      method: 'GET',
      url: '/api/v1/import-batches?cursor=not-a-cursor',
      headers: { cookie: admin.cookie },
    });
    assert.equal(invalidCursor.statusCode, 400);
    assert.equal(errorDetailCode(invalidCursor), 'invalid');

    const invalidId = await app.inject({
      method: 'GET',
      url: '/api/v1/import-batches/not-a-uuid/content',
      headers: { cookie: admin.cookie },
    });
    assert.equal(invalidId.statusCode, 404);
    assert.equal(errorCode(invalidId), 'NOT_FOUND');

    const missingContent = await app.inject({
      method: 'GET',
      url: `/api/v1/import-batches/${records[0].id}/content`,
      headers: { cookie: admin.cookie },
    });
    assert.equal(missingContent.statusCode, 404);
    assert.equal(errorCode(missingContent), 'NOT_FOUND');
    assert.equal(missingContent.body.includes(records[0].objectKey), false);
    assert.ok(await importBatchRepository.findById(records[0].id));
    assert.equal(storageBackend.deleteCount, 0);
  } finally {
    await app.close();
  }

  const failingStorage = new CountingStorageBackend();
  const failed = await makeApp({
    storageBackend: failingStorage,
    importBatchRepository: new FailingImportBatchRepository(),
  });
  try {
    const admin = await loginUi(failed.app, 'admin', ADMIN_PASSWORD);
    const response = await upload(failed.app, admin, uploadPayload(await workbookBuffer()));
    assert.equal(response.statusCode, 500);
    assert.equal(errorCode(response), 'INTERNAL_ERROR');
    assert.equal(failingStorage.putCount, 1);
    assert.equal(failingStorage.deleteCount, 1);
    assert.equal(response.body.includes('import-batches/'), false);
  } finally {
    await failed.app.close();
  }
});

test('PostgreSQL import batch repository stores expiry and uses a creator-independent descending cursor', async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();
  try {
    await runMigrations(pool);
    await pool.query(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES ($1, 'admin', 'fixture-hash', 'admin'), ($2, 'worker', 'fixture-hash', 'user')
    `, [ADMIN_ID, USER_ID]);
    const repository = new PgImportBatchRepository(pool);
    const oldest = importBatchRecord('00000000-0000-0000-0000-000000000201', '2026-08-06T08:01:00.000Z', USER_ID);
    const newest = importBatchRecord('00000000-0000-0000-0000-000000000202', '2026-08-06T08:02:00.000Z', ADMIN_ID);
    await repository.create(oldest);
    await repository.create(newest);

    const first = await repository.list({ limit: 1 });
    assert.deepEqual(first.items.map((item) => item.id), [newest.id]);
    assert.ok(first.nextCursor);
    const second = await repository.list({ limit: 1, cursor: first.nextCursor });
    assert.deepEqual(second.items.map((item) => item.id), [oldest.id]);
    assert.equal(second.items[0].createdBy, USER_ID);
    assert.equal(second.items[0].expiresAt.toISOString(), '2026-09-05T08:01:00.000Z');
  } finally {
    await pool.end();
  }
});

function importBatchRecord(id, createdAt, createdBy = ADMIN_ID) {
  const timestamp = new Date(createdAt);
  return {
    id,
    fileName: `${id}.xlsx`,
    objectKey: `import-batches/${id}.xlsx`,
    contentType: IMPORT_BATCH_CONTENT_TYPE,
    byteSize: 7,
    sha256: createHash('sha256').update(id).digest('hex'),
    liRows: 1,
    qzRows: 1,
    skippedRows: 0,
    createdBy,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: new Date(timestamp.getTime() + 30 * 24 * 60 * 60 * 1000),
  };
}
