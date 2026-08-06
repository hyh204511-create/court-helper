import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { newDb } from 'pg-mem';

import { buildApp, loadConfig } from '../src/app.ts';
import { hashPassword } from '../src/auth/password.ts';
import { MemoryAuthRepository } from '../src/auth/memory-repository.ts';
import { runMigrations } from '../src/db/migrator.ts';
import { MemoryReportExportRepository } from '../src/report-exports/memory-repository.ts';
import { PgReportExportRepository } from '../src/report-exports/repository.ts';
import {
  MAX_REPORT_EXPORT_BYTES,
  sanitizeReportExportFileName,
} from '../src/report-exports/service.ts';
import { MemoryStorageBackend } from '../src/storage/memory.ts';
import { bindPairedExtensionRepository, pairedExtensionTokenForApp } from './paired-extension.ts';

const TEST_KEY = Buffer.alloc(32, 37).toString('base64');
const ADMIN_PASSWORD = 'Admin-pass-1';
const USER_A_PASSWORD = 'User-a-pass-1';
const USER_B_PASSWORD = 'User-b-pass-1';
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const USER_A_ID = '00000000-0000-0000-0000-000000000002';
const USER_B_ID = '00000000-0000-0000-0000-000000000003';
const XLSX_FIXTURE = Buffer.from([
  0x50, 0x4b, 0x03, 0x04,
  0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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
    this.events.push(`storage-delete:${key}`);
    return super.delete(key);
  }
}

class MissingDeleteStorageBackend extends CountingStorageBackend {
  missingKeys = new Set();

  async delete(key) {
    if (this.missingKeys.has(key)) {
      this.deleteCount += 1;
      this.events.push(`storage-delete:${key}`);
      const error = new Error('object missing');
      error.code = 'ENOENT';
      throw error;
    }
    return super.delete(key);
  }
}

function multipart(fields = {}, file = undefined) {
  const boundary = '----court-helper-report-export-boundary';
  const chunks = [];
  const add = (value) => chunks.push(Buffer.from(value, 'utf8'));

  for (const [name, value] of Object.entries(fields)) {
    add(`--${boundary}\r\n`);
    add(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
    add(`${value}\r\n`);
  }
  if (file !== undefined) {
    add(`--${boundary}\r\n`);
    add(`Content-Disposition: form-data; name="file"; filename="${file.fileName ?? 'report.xlsx'}"\r\n`);
    add(`Content-Type: ${file.contentType ?? XLSX_CONTENT_TYPE}\r\n\r\n`);
    chunks.push(file.buffer);
    add('\r\n');
  }
  add(`--${boundary}--\r\n`);

  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function uploadPayload(buffer = XLSX_FIXTURE, overrides = {}) {
  const fields = {
    sha256: createHash('sha256').update(buffer).digest('hex'),
    ...overrides,
  };
  return multipart(fields, {
    buffer,
    contentType: XLSX_CONTENT_TYPE,
    fileName: 'report.xlsx',
  });
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function makeApp(storageBackend = new CountingStorageBackend()) {
  const authRepository = new MemoryAuthRepository();
  const reportExportRepository = new MemoryReportExportRepository();
  const app = buildApp({
    config: config(),
    dependencies: {
      database: { check: async () => true },
      objectStorage: storageBackend,
    },
    authRepository,
    reportExportRepository,
    storageBackend,
  });
  await app.ready();
  bindPairedExtensionRepository(app, authRepository);
  await authRepository.createUser({
    id: USER_A_ID,
    username: 'user-a',
    passwordHash: await hashPassword(USER_A_PASSWORD),
    role: 'user',
    enabled: true,
  });
  await authRepository.createUser({
    id: USER_B_ID,
    username: 'user-b',
    passwordHash: await hashPassword(USER_B_PASSWORD),
    role: 'user',
    enabled: true,
  });
  return { app, authRepository, reportExportRepository, storageBackend };
}

async function login(app, username, password, origin = 'chrome-extension://test-extension') {
  if (origin === 'chrome-extension://test-extension') {
    void password;
    return (await pairedExtensionTokenForApp(app, username)).token;
  }
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin },
    payload: { username, password, clientType: 'admin_ui' },
  });
  assert.equal(response.statusCode, 200);
  return cookieHeader(response).split('=', 2)[1];
}

async function upload(app, token, payload = uploadPayload()) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/report-exports',
    headers: { authorization: `Bearer ${token}`, ...payload.headers },
    payload: payload.payload,
  });
}

test('report export upload stores metadata and is idempotent per user', async () => {
  const { app, reportExportRepository, storageBackend } = await makeApp();

  try {
    const token = await login(app, 'user-a', USER_A_PASSWORD);
    const content = XLSX_FIXTURE;
    const hash = createHash('sha256').update(content).digest('hex');
    const firstPayload = multipart({ sha256: hash }, {
      buffer: content,
      contentType: XLSX_CONTENT_TYPE,
      fileName: '../报表<2026>（一）.xlsx',
    });

    const created = await upload(app, token, firstPayload);
    assert.equal(created.statusCode, 201);
    assert.deepEqual(Object.keys(created.json()).sort(), [
      'byteSize', 'created', 'createdAt', 'fileName', 'id', 'sha256',
    ]);
    assert.equal(created.json().created, true);
    assert.equal(created.json().byteSize, content.length);
    assert.equal(created.json().sha256, hash);
    assert.match(created.json().fileName, /^报表2026（一）\.xlsx$/);

    const record = await reportExportRepository.findById(created.json().id);
    assert.ok(record);
    assert.match(record.objectKey, /^report-exports\/[0-9a-f-]+\.xlsx$/);
    assert.equal(record.createdBy, USER_A_ID);
    assert.equal(await storageBackend.exists(record.objectKey), true);
    assert.deepEqual(await readStream(await storageBackend.get(record.objectKey)), content);
    assert.equal(storageBackend.putCount, 1);

    const repeated = await upload(app, token, multipart({ sha256: hash }, {
      buffer: content,
      contentType: XLSX_CONTENT_TYPE,
      fileName: 'different-name.xlsx',
    }));
    assert.equal(repeated.statusCode, 200);
    assert.equal(repeated.json().id, created.json().id);
    assert.equal(repeated.json().created, false);
    assert.equal(storageBackend.putCount, 1);
  } finally {
    await app.close();
  }
});

test('report export validation rejects malformed multipart files and oversized payloads', async () => {
  const { app, storageBackend } = await makeApp();

  try {
    const token = await login(app, 'user-a', USER_A_PASSWORD);
    const missingHash = await upload(app, token, multipart({}, {
      buffer: XLSX_FIXTURE,
      contentType: XLSX_CONTENT_TYPE,
    }));
    assert.equal(missingHash.statusCode, 400);
    assert.equal(missingHash.json().error.details[0].code, 'sha256_required');

    const invalidHash = await upload(app, token, multipart({ sha256: 'not-a-sha256' }, {
      buffer: XLSX_FIXTURE,
      contentType: XLSX_CONTENT_TYPE,
    }));
    assert.equal(invalidHash.statusCode, 400);
    assert.equal(invalidHash.json().error.details[0].code, 'sha256_invalid');

    const missingFile = await upload(app, token, multipart({ sha256: 'a'.repeat(64) }));
    assert.equal(missingFile.statusCode, 400);
    assert.equal(missingFile.json().error.details[0].code, 'file_required');

    const notZip = Buffer.from('not an xlsx file');
    const invalidMagic = await upload(app, token, uploadPayload(notZip));
    assert.equal(invalidMagic.statusCode, 400);
    assert.equal(invalidMagic.json().error.details[0].code, 'magic_not_allowed');

    const mismatchedMime = await upload(app, token, multipart({
      sha256: createHash('sha256').update(XLSX_FIXTURE).digest('hex'),
    }, {
      buffer: XLSX_FIXTURE,
      contentType: 'application/zip',
    }));
    assert.equal(mismatchedMime.statusCode, 400);
    assert.equal(mismatchedMime.json().error.details[0].code, 'mime_mismatch');

    const oversized = Buffer.alloc(MAX_REPORT_EXPORT_BYTES + 1, 0x61);
    XLSX_FIXTURE.copy(oversized, 0);
    const tooLarge = await upload(app, token, uploadPayload(oversized));
    assert.equal(tooLarge.statusCode, 413);
    assert.equal(tooLarge.json().error.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(storageBackend.putCount, 0);
  } finally {
    await app.close();
  }
});

test('report export routes enforce authentication, ownership, pagination, and admin access', async () => {
  const { app } = await makeApp();

  try {
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/report-exports' });
    assert.equal(anonymous.statusCode, 401);

    const userAToken = await login(app, 'user-a', USER_A_PASSWORD);
    const userBToken = await login(app, 'user-b', USER_B_PASSWORD);
    const userAUpload = await upload(app, userAToken);
    const userBUpload = await upload(app, userBToken, uploadPayload(Buffer.concat([XLSX_FIXTURE, Buffer.from('b')])));
    assert.equal(userAUpload.statusCode, 201);
    assert.equal(userBUpload.statusCode, 201);

    const userList = await app.inject({
      method: 'GET',
      url: '/api/v1/report-exports?limit=200',
      headers: { authorization: `Bearer ${userAToken}` },
    });
    assert.equal(userList.statusCode, 200);
    assert.equal(userList.json().reportExports.length, 1);
    assert.equal(userList.json().reportExports[0].createdBy, USER_A_ID);
    assert.equal(Object.hasOwn(userList.json().reportExports[0], 'objectKey'), false);

    const tooMany = await app.inject({
      method: 'GET',
      url: '/api/v1/report-exports?limit=201',
      headers: { authorization: `Bearer ${userAToken}` },
    });
    assert.equal(tooMany.statusCode, 400);

    const otherId = userBUpload.json().id;
    const hiddenDetails = await app.inject({
      method: 'GET',
      url: `/api/v1/report-exports/${otherId}`,
      headers: { authorization: `Bearer ${userAToken}` },
    });
    assert.equal(hiddenDetails.statusCode, 404);

    const hiddenDownload = await app.inject({
      method: 'GET',
      url: `/api/v1/report-exports/${otherId}/download`,
      headers: { authorization: `Bearer ${userAToken}` },
    });
    assert.equal(hiddenDownload.statusCode, 403);

    const hiddenDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/report-exports/${otherId}`,
      headers: { authorization: `Bearer ${userAToken}` },
    });
    assert.equal(hiddenDelete.statusCode, 403);

    const adminToken = await login(app, 'admin', ADMIN_PASSWORD);
    const adminList = await app.inject({
      method: 'GET',
      url: '/report-exports?limit=200',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(adminList.statusCode, 200);
    assert.equal(adminList.json().reportExports.length, 2);
  } finally {
    await app.close();
  }
});

test('report export routes reject malformed UUID ids and cursor ids at the boundary', async () => {
  const { app } = await makeApp();

  try {
    const token = await login(app, 'user-a', USER_A_PASSWORD);
    const malformedId = 'not-a-uuid';
    const invalidIdRequests = [
      { method: 'GET', url: `/api/v1/report-exports/${malformedId}` },
      { method: 'GET', url: `/api/v1/report-exports/${malformedId}/download` },
      { method: 'DELETE', url: `/api/v1/report-exports/${malformedId}` },
    ];

    for (const request of invalidIdRequests) {
      const response = await app.inject({
        ...request,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error.code, 'NOT_FOUND');
    }

    const invalidCursor = Buffer.from(JSON.stringify({
      createdAt: '2026-08-31T00:00:00.000Z',
      id: malformedId,
    }), 'utf8').toString('base64url');
    const cursorResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/report-exports?cursor=${invalidCursor}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(cursorResponse.statusCode, 400);
    assert.equal(cursorResponse.json().error.code, 'VALIDATION_ERROR');
  } finally {
    await app.close();
  }
});

test('report export download streams content with sanitized filename and digest headers', async () => {
  const { app, reportExportRepository, storageBackend } = await makeApp();

  try {
    const sanitizedControlName = sanitizeReportExportFileName(
      'bad\u0000\r\n<>.xlsx',
      new Date('2026-08-06T00:00:00.000Z'),
    );
    assert.equal(sanitizedControlName, 'bad.xlsx');
    const sanitizedLongName = sanitizeReportExportFileName(`${'a'.repeat(250)}.xlsx`);
    assert.equal(sanitizedLongName.length, 200);
    assert.equal(sanitizedLongName.endsWith('.xlsx'), true);

    const token = await login(app, 'user-a', USER_A_PASSWORD);
    const content = Buffer.concat([XLSX_FIXTURE, Buffer.from('download')]);
    const created = await upload(app, token, multipart({
      sha256: createHash('sha256').update(content).digest('hex'),
    }, {
      buffer: content,
      contentType: XLSX_CONTENT_TYPE,
      fileName: 'C:\\fake\\路径\\报告<>.xlsx',
    }));
    assert.equal(created.statusCode, 201);

    const record = await reportExportRepository.findById(created.json().id);
    assert.ok(record);
    const download = await app.inject({
      method: 'GET',
      url: `/api/v1/report-exports/${record.id}/download`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(download.statusCode, 200);
    assert.deepEqual(download.rawPayload, content);
    assert.match(download.headers['content-type'], new RegExp(`^${XLSX_CONTENT_TYPE}`));
    assert.equal(download.headers['cache-control'], 'private, no-store');
    assert.equal(download.headers['content-length'], String(content.length));
    assert.equal(download.headers['x-content-sha256'], record.sha256);
    assert.match(download.headers['content-disposition'], /^attachment; filename\*=UTF-8''/);
    assert.equal(download.headers['content-disposition'].includes('\r'), false);
    assert.equal(download.headers['content-disposition'].includes('\n'), false);
    assert.equal(decodeURIComponent(download.headers['content-disposition'].split("UTF-8''", 2)[1]), record.fileName);
    assert.equal(await storageBackend.exists(record.objectKey), true);
  } finally {
    await app.close();
  }
});

test('report export deletion removes the object before metadata and repeated deletion is 404', async () => {
  const { app, reportExportRepository, storageBackend } = await makeApp();
  const originalDelete = reportExportRepository.delete.bind(reportExportRepository);
  reportExportRepository.delete = async (id) => {
    storageBackend.events.push(`record-delete:${id}`);
    return originalDelete(id);
  };

  try {
    const token = await login(app, 'user-a', USER_A_PASSWORD);
    const created = await upload(app, token);
    assert.equal(created.statusCode, 201);
    const record = await reportExportRepository.findById(created.json().id);
    assert.ok(record);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/report-exports/${record.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(deleted.statusCode, 204);
    assert.deepEqual(storageBackend.events.slice(-2), [
      `storage-delete:${record.objectKey}`,
      `record-delete:${record.id}`,
    ]);
    assert.equal(await storageBackend.exists(record.objectKey), false);
    assert.equal(await reportExportRepository.findById(record.id), null);

    const repeated = await app.inject({
      method: 'DELETE',
      url: `/api/v1/report-exports/${record.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(repeated.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('report export deletion treats a missing storage object as success and removes metadata', async () => {
  const storageBackend = new MissingDeleteStorageBackend();
  const { app, reportExportRepository } = await makeApp(storageBackend);

  try {
    const token = await login(app, 'user-a', USER_A_PASSWORD);
    const created = await upload(app, token);
    assert.equal(created.statusCode, 201);
    const record = await reportExportRepository.findById(created.json().id);
    assert.ok(record);

    await storageBackend.delete(record.objectKey);
    storageBackend.missingKeys.add(record.objectKey);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/report-exports/${record.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(deleted.statusCode, 204);
    assert.equal(await reportExportRepository.findById(record.id), null);

    const repeated = await app.inject({
      method: 'DELETE',
      url: `/api/v1/report-exports/${record.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(repeated.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('postgres report export repository persists ownership, pagination, and idempotency fields', async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();

  try {
    await runMigrations(pool);
    await pool.query(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES ($1, 'worker', 'hash', 'user')
    `, [USER_A_ID]);

    const repository = new PgReportExportRepository(pool);
    const created = await repository.create({
      id: '00000000-0000-0000-0000-000000000101',
      fileName: 'report.xlsx',
      objectKey: 'report-exports/00000000-0000-0000-0000-000000000101.xlsx',
      contentType: XLSX_CONTENT_TYPE,
      byteSize: XLSX_FIXTURE.length,
      sha256: createHash('sha256').update(XLSX_FIXTURE).digest('hex'),
      createdBy: USER_A_ID,
    });
    assert.equal(created.fileName, 'report.xlsx');
    assert.equal((await repository.findBySha256AndCreatedBy(created.sha256, USER_A_ID)).id, created.id);
    assert.equal((await repository.list({ createdBy: USER_A_ID, limit: 200 })).items.length, 1);
    assert.equal((await repository.findById(created.id, USER_A_ID)).objectKey, created.objectKey);
    assert.equal(await repository.findById(created.id, USER_B_ID), null);
  } finally {
    await pool.end();
  }
});
