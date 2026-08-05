import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { newDb } from 'pg-mem';

import { buildApp, loadConfig } from '../src/app.ts';
import { hashPassword } from '../src/auth/password.ts';
import { MemoryAuthRepository } from '../src/auth/memory-repository.ts';
import { MemoryCaseRepository } from '../src/cases/memory-repository.ts';
import { MemoryPlatformAccountRepository } from '../src/platform-accounts/memory-repository.ts';
import { runMigrations } from '../src/db/migrator.ts';
import { MemoryScreenshotRepository } from '../src/screenshots/memory-repository.ts';
import { PgScreenshotRepository } from '../src/screenshots/repository.ts';
import { MemoryStorageBackend } from '../src/storage/memory.ts';

const TEST_KEY = Buffer.alloc(32, 29).toString('base64');
const ADMIN_PASSWORD = 'Admin-pass-1';
const WORKER_PASSWORD = 'Worker-pass-1';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000010';
const JPEG_FIXTURE = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/AP/EABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEAAQUCcf/EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQMBAT8BP//EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQIBAT8BP//EABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEAAT8hH//Z', 'base64');
const PNG_FIXTURE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function config() {
  return loadConfig({
    PORT: '3104',
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

  async put(key, buffer, contentType) {
    this.putCount += 1;
    return super.put(key, buffer, contentType);
  }

  async delete(key) {
    this.deleteCount += 1;
    return super.delete(key);
  }
}

function multipart(fields, file) {
  const boundary = '----court-helper-test-boundary';
  const chunks = [];
  const add = (value) => chunks.push(Buffer.from(value, 'utf8'));

  for (const [name, value] of Object.entries(fields)) {
    add(`--${boundary}\r\n`);
    add(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
    add(`${value}\r\n`);
  }
  add(`--${boundary}\r\n`);
  add(`Content-Disposition: form-data; name="file"; filename="evidence.jpg"\r\n`);
  add(`Content-Type: ${file.contentType}\r\n\r\n`);
  chunks.push(file.buffer);
  add(`\r\n--${boundary}--\r\n`);

  return {
    payload: Buffer.concat(chunks),
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
  };
}

function uploadPayload(buffer, contentType = 'image/jpeg', overrides = {}) {
  return multipart({
    eventId: 'event-screenshot-1',
    type: 'success',
    capturedAt: '2026-08-04T01:02:03.000Z',
    sha256: createHash('sha256').update(buffer).digest('hex'),
    ...overrides,
  }, { buffer, contentType });
}

function cookieHeader(response) {
  const setCookie = response.headers['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(first);
  return first.split(';', 1)[0];
}

async function addUser(repository) {
  return repository.createUser({
    username: 'worker',
    passwordHash: await hashPassword(WORKER_PASSWORD),
    role: 'user',
    enabled: true,
  });
}

async function makeApp() {
  const authRepository = new MemoryAuthRepository();
  const platformAccountRepository = new MemoryPlatformAccountRepository([{
    id: ACCOUNT_ID,
    label: 'synthetic-account',
    secretCiphertext: Buffer.from('ciphertext'),
    secretIv: Buffer.alloc(12, 1),
    secretTag: Buffer.alloc(16, 2),
    secretVersion: 1,
    enabled: true,
    deletedAt: null,
    createdBy: '00000000-0000-0000-0000-000000000001',
    createdAt: new Date('2026-08-04T00:00:00.000Z'),
    updatedAt: new Date('2026-08-04T00:00:00.000Z'),
  }]);
  const caseRepository = new MemoryCaseRepository();
  const screenshotRepository = new MemoryScreenshotRepository();
  const storageBackend = new CountingStorageBackend();
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
  await addUser(authRepository);
  return { app, authRepository, caseRepository, screenshotRepository, storageBackend };
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

async function createCase(app, token) {
  const response = await app.inject({
    method: 'POST',
    url: '/sync/cases',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      batchId: 'batch-screenshot-test',
      items: [{
        eventId: 'event-case-1',
        clientUid: 'client-screenshot-1',
        platformAccountId: ACCOUNT_ID,
        kind: 'li',
        plaintiff: 'synthetic plaintiff',
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
      }],
    },
  });
  assert.equal(response.statusCode, 200);
  return response.json().accepted[0].id;
}

async function upload(app, token, caseId, buffer, overrides = {}, contentType = 'image/jpeg') {
  const body = uploadPayload(buffer, contentType, overrides);
  return app.inject({
    method: 'POST',
    url: `/cases/${caseId}/screenshots`,
    headers: { authorization: `Bearer ${token}`, ...body.headers },
    payload: body.payload,
  });
}

test('memory storage stores private objects, streams reads, and deletes objects', async () => {
  const storage = new MemoryStorageBackend();
  const content = Buffer.from('synthetic screenshot bytes');

  assert.equal(await storage.check(), true);
  await storage.put('screenshots/private-object', content, 'image/jpeg');
  assert.equal(await storage.exists('screenshots/private-object'), true);

  const stream = await storage.get('screenshots/private-object');
  assert.ok(stream);
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), content);

  await storage.delete('screenshots/private-object');
  assert.equal(await storage.exists('screenshots/private-object'), false);
  assert.equal(await storage.get('screenshots/private-object'), null);
});

test('screenshot API authenticates, validates case binding, lists metadata, and streams content', async () => {
  const { app } = await makeApp();

  try {
    const anonymous = await app.inject({ method: 'GET', url: '/cases/missing-case/screenshots' });
    assert.equal(anonymous.statusCode, 401);

    const token = await loginExtension(app);
    const caseId = await createCase(app, token);
    const content = JPEG_FIXTURE;

    const admin = await loginAdmin(app);
    const cookieUpload = uploadPayload(content);
    const csrfMissing = await app.inject({
      method: 'POST',
      url: `/cases/${caseId}/screenshots`,
      headers: {
        cookie: admin.cookie,
        origin: 'https://admin.example.test',
        ...cookieUpload.headers,
      },
      payload: cookieUpload.payload,
    });
    assert.equal(csrfMissing.statusCode, 403);

    const created = await upload(app, token, caseId, content);
    assert.equal(created.statusCode, 201);
    const screenshot = created.json();
    assert.equal(screenshot.type, 'success');
    assert.equal(screenshot.contentType, 'image/jpeg');
    assert.equal(screenshot.byteSize, content.length);
    assert.equal(screenshot.contentUrl, `/screenshots/${screenshot.id}/content`);
    assert.equal(Object.hasOwn(screenshot, 'objectKey'), false);
    assert.equal(Object.hasOwn(screenshot, 'bucket'), false);

    const list = await app.inject({
      method: 'GET',
      url: `/cases/${caseId}/screenshots`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().screenshots, [screenshot]);
    assert.deepEqual(Object.keys(list.json().screenshots[0]).sort(), [
      'byteSize', 'capturedAt', 'contentType', 'contentUrl', 'id', 'type',
    ]);

    const contentResponse = await app.inject({
      method: 'GET',
      url: `/screenshots/${screenshot.id}/content?download=0`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(contentResponse.statusCode, 200);
    assert.equal(contentResponse.headers['cache-control'], 'private, no-store');
    assert.match(contentResponse.headers['content-type'], /^image\/jpeg/);
    assert.match(contentResponse.headers['content-disposition'], /^inline;/);
    assert.deepEqual(contentResponse.rawPayload, content);
    assert.equal(contentResponse.body.includes('screenshots/'), false);

    const download = await app.inject({
      method: 'GET',
      url: `/screenshots/${screenshot.id}/content?download=1`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(download.statusCode, 200);
    assert.match(download.headers['content-disposition'], /^attachment;/);

    const missingCase = await app.inject({
      method: 'GET',
      url: '/cases/missing-case/screenshots',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(missingCase.statusCode, 404);
    assert.equal(missingCase.json().error.code, 'NOT_FOUND');

    const missingContent = await app.inject({
      method: 'GET',
      url: '/screenshots/missing-screenshot/content',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(missingContent.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('screenshot upload rejects invalid MIME/hash/size and preserves idempotency on same hash', async () => {
  const { app, screenshotRepository, storageBackend } = await makeApp();

  try {
    const token = await loginExtension(app);
    const caseId = await createCase(app, token);
    const content = PNG_FIXTURE;

    const invalidHash = await upload(app, token, caseId, content, {
      sha256: '0'.repeat(64),
    });
    assert.equal(invalidHash.statusCode, 400);
    assert.equal(invalidHash.json().error.code, 'VALIDATION_ERROR');
    assert.equal(storageBackend.putCount, 0);

    const invalidMime = await upload(app, token, caseId, content, {}, 'image/gif');
    assert.equal(invalidMime.statusCode, 400);
    assert.equal(invalidMime.json().error.code, 'VALIDATION_ERROR');
    assert.equal(storageBackend.putCount, 0);

    const missingCase = await upload(app, token, 'missing-case', content, {}, 'image/png');
    assert.equal(missingCase.statusCode, 404);
    assert.equal(storageBackend.putCount, 0);

    const created = await upload(app, token, caseId, content, {}, 'image/png');
    assert.equal(created.statusCode, 201);
    assert.equal(storageBackend.putCount, 1);
    const first = await screenshotRepository.findById(created.json().id);
    assert.ok(first);

    const repeated = await upload(app, token, caseId, content, {
      eventId: 'event-screenshot-retry',
    }, 'image/png');
    assert.equal(repeated.statusCode, 200);
    assert.equal(repeated.json().id, created.json().id);
    assert.equal(storageBackend.putCount, 1);
    assert.equal(storageBackend.deleteCount, 0);

    const replacementContent = Buffer.concat([PNG_FIXTURE, Buffer.from('replacement')]);
    const replacement = await upload(app, token, caseId, replacementContent, {}, 'image/png');
    assert.equal(replacement.statusCode, 200);
    assert.equal(replacement.json().id, created.json().id);
    assert.equal(storageBackend.putCount, 2);
    assert.equal(storageBackend.deleteCount, 1);
    assert.equal(await storageBackend.exists(first.objectKey), false);

    const tooLarge = await upload(app, token, caseId, Buffer.alloc(10 * 1024 * 1024 + 1));
    assert.equal(tooLarge.statusCode, 413);
    assert.equal(tooLarge.json().error.code, 'PAYLOAD_TOO_LARGE');
  } finally {
    await app.close();
  }
});

test('screenshot upload requires file magic to match the declared image MIME', async () => {
  const { app, screenshotRepository, storageBackend } = await makeApp();

  try {
    const token = await loginExtension(app);
    const caseId = await createCase(app, token);
    const html = Buffer.from('<!doctype html><title>not an image</title>');

    const disguisedHtml = await upload(app, token, caseId, html, {}, 'image/jpeg');
    assert.equal(disguisedHtml.statusCode, 400);
    assert.equal(disguisedHtml.json().error.code, 'VALIDATION_ERROR');
    assert.equal(storageBackend.putCount, 0);

    const jpeg = await upload(app, token, caseId, JPEG_FIXTURE, { type: 'reject' }, 'image/jpeg');
    assert.equal(jpeg.statusCode, 201);
    assert.equal(jpeg.json().contentType, 'image/jpeg');
    assert.equal((await screenshotRepository.findById(jpeg.json().id)).contentType, 'image/jpeg');

    const png = await upload(app, token, caseId, PNG_FIXTURE, { type: 'enforcement_success' }, 'image/png');
    assert.equal(png.statusCode, 201);
    assert.equal(png.json().contentType, 'image/png');
    const pngRecord = await screenshotRepository.findById(png.json().id);
    assert.equal(pngRecord.contentType, 'image/png');
    assert.match(pngRecord.objectKey, /\.png$/);
    const replay = await app.inject({
      method: 'GET',
      url: `/screenshots/${png.json().id}/content`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(replay.statusCode, 200);
    assert.match(replay.headers['content-type'], /^image\/png/);

    const mismatched = await upload(
      app,
      token,
      caseId,
      PNG_FIXTURE,
      { type: 'success' },
      'image/jpeg',
    );
    assert.equal(mismatched.statusCode, 400);
    assert.equal(mismatched.json().error.code, 'VALIDATION_ERROR');
    assert.equal(storageBackend.putCount, 2);
  } finally {
    await app.close();
  }
});

test('postgres screenshot repository persists metadata without exposing storage internals through public mapping', async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();

  try {
    await runMigrations(pool);
    const caseId = '00000000-0000-0000-0000-000000000101';
    await pool.query(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES ('00000000-0000-0000-0000-000000000001', 'admin', 'hash', 'admin')
    `);
    await pool.query(`
      INSERT INTO platform_accounts (
        id, label, secret_ciphertext, secret_iv, secret_tag, created_by
      ) VALUES (
        '00000000-0000-0000-0000-000000000010', 'synthetic-account', '\\x01', '\\x02', '\\x03',
        '00000000-0000-0000-0000-000000000001'
      )
    `);
    await pool.query(`
      INSERT INTO cases (
        id, client_uid, platform_account_id, kind, plaintiff, defendant, status,
        source_event_id, source_updated_at, revision
      ) VALUES ($1, 'client-screenshot-pg', '00000000-0000-0000-0000-000000000010',
        'li', 'plaintiff', 'defendant', '立案成功', 'event-pg', NOW(), nextval('cases_revision_seq'))
    `, [caseId]);

    const repository = new PgScreenshotRepository(pool);
    const created = await repository.create({
      caseId,
      type: 'success',
      objectKey: 'screenshots/private-pg-object',
      contentType: 'image/jpeg',
      byteSize: 7,
      sha256: 'a'.repeat(64),
      capturedAt: new Date('2026-08-04T01:02:03.000Z'),
    });
    assert.equal((await repository.listByCaseId(caseId)).length, 1);
    assert.equal((await repository.findByCaseIdAndType(caseId, 'success')).id, created.id);

    const updated = await repository.update(created.id, {
      objectKey: 'screenshots/private-pg-object-2',
      contentType: 'image/png',
      byteSize: 9,
      sha256: 'b'.repeat(64),
      capturedAt: new Date('2026-08-04T02:02:03.000Z'),
    });
    assert.equal(updated.contentType, 'image/png');
    assert.equal(updated.objectKey, 'screenshots/private-pg-object-2');
    assert.equal((await repository.findById(created.id)).sha256, 'b'.repeat(64));
  } finally {
    await pool.end();
  }
});
