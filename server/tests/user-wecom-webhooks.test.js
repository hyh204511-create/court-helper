import test from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';

import { buildApp, loadConfig } from '../src/app.ts';
import { MemoryAuthRepository } from '../src/auth/memory-repository.ts';
import { hashPassword } from '../src/auth/password.ts';
import { hashToken } from '../src/auth/token.ts';
import { decryptUserWebhook, encryptUserWebhook } from '../src/user-wecom-webhooks/crypto.ts';
import { MemoryUserWecomWebhookRepository } from '../src/user-wecom-webhooks/memory-repository.ts';
import { UserWecomWebhookService } from '../src/user-wecom-webhooks/service.ts';
import { PgUserWecomWebhookRepository } from '../src/user-wecom-webhooks/repository.ts';
import { rollbackLastMigration, runMigrations } from '../src/db/migrator.ts';

const MASTER_KEY = Buffer.alloc(32, 17);
const ADMIN_PASSWORD = 'Admin-pass-1';
const USER_ID = '00000000-0000-4000-8000-000000000701';
const WEBHOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-user-key';

function config() {
  return loadConfig({
    PORT: '3191',
    DATABASE_URL: 'postgres://test:test@localhost/test',
    CREDENTIAL_MASTER_KEY: MASTER_KEY.toString('base64'),
    CORS_EXTENSION_ORIGINS: 'chrome-extension://test',
    CORS_ADMIN_ORIGINS: 'https://admin.example.test',
    OBJECT_STORAGE_ENDPOINT: 'https://storage.example.test',
    OBJECT_STORAGE_BUCKET: 'test',
    ADMIN_INITIAL_PASSWORD: ADMIN_PASSWORD,
    WECOM_WEBHOOK_URL: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-fallback-key',
  });
}

async function login(app, username, password) {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin: 'https://admin.example.test' },
    payload: { username, password, clientType: 'admin_ui' },
  });
  assert.equal(response.statusCode, 200);
  const setCookie = Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'][0] : response.headers['set-cookie'];
  return { cookie: setCookie.split(';', 1)[0], csrfToken: response.json().csrfToken };
}

test('AES-GCM ciphertext is bound to the user id and never contains the webhook plaintext', () => {
  const encrypted = encryptUserWebhook(MASTER_KEY, USER_ID, WEBHOOK);
  assert.equal(encrypted.version, 1);
  assert.equal(encrypted.iv.length, 12);
  assert.equal(encrypted.tag.length, 16);
  assert.equal(encrypted.ciphertext.includes(Buffer.from(WEBHOOK)), false);
  assert.equal(decryptUserWebhook(MASTER_KEY, USER_ID, encrypted), WEBHOOK);
  assert.throws(
    () => decryptUserWebhook(MASTER_KEY, '00000000-0000-4000-8000-000000000702', encrypted),
    /decrypt/i,
  );
});

test('migration stores webhook encryption fields as one constrained group and rolls back', async () => {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  try {
    assert.equal((await runMigrations(pool)).at(-1), '015_user_wecom_webhooks');
    await pool.query(`INSERT INTO users (id, username, password_hash) VALUES ($1, 'worker', 'hash')`, [USER_ID]);
    await assert.rejects(pool.query(`UPDATE users SET wecom_webhook_ciphertext = $2 WHERE id = $1`, [USER_ID, Buffer.from('partial')]));
    const repository = new PgUserWecomWebhookRepository(pool);
    const encrypted = {
      ciphertext: Buffer.from('synthetic-ciphertext'),
      iv: Buffer.from('123456789012'),
      tag: Buffer.from('1234567890123456'),
      version: 1,
    };
    assert.equal(await repository.save(USER_ID, encrypted), true);
    assert.deepEqual(await repository.findByUserId(USER_ID), encrypted);
    assert.equal((await repository.configuredUserIds([USER_ID])).has(USER_ID), true);
    assert.equal(await rollbackLastMigration(pool), '015_user_wecom_webhooks');
    const columns = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name LIKE 'wecom_webhook_%'`);
    assert.equal(columns.rows.length, 0);
  } finally {
    await pool.end();
  }
});

test('service validates, encrypts, resolves and clears one user webhook without exposing it', async () => {
  const auth = new MemoryAuthRepository();
  await auth.createUser({ id: USER_ID, username: 'worker', passwordHash: 'hash', role: 'user' });
  const repository = new MemoryUserWecomWebhookRepository();
  const service = new UserWecomWebhookService(repository, auth, MASTER_KEY, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-fallback-key');

  assert.deepEqual(await service.status(USER_ID), { userId: USER_ID, wecomWebhookConfigured: false });
  assert.equal(await service.resolve(USER_ID), 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-fallback-key');
  assert.deepEqual(await service.set(USER_ID, WEBHOOK), { userId: USER_ID, wecomWebhookConfigured: true });
  assert.equal(await service.resolve(USER_ID), WEBHOOK);
  const stored = await repository.findByUserId(USER_ID);
  assert.ok(stored);
  assert.equal(JSON.stringify(stored).includes('synthetic-user-key'), false);

  for (const invalid of [
    '',
    'http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x',
    'https://example.test/cgi-bin/webhook/send?key=x',
    'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x&extra=y',
    'https://qyapi.weixin.qq.com:443/cgi-bin/webhook/send?key=x',
  ]) {
    await assert.rejects(service.set(USER_ID, invalid), (error) => error.code === 'VALIDATION_ERROR');
  }

  assert.deepEqual(await service.clear(USER_ID), { userId: USER_ID, wecomWebhookConfigured: false });
  assert.equal(await service.resolve(USER_ID), 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-fallback-key');
});

test('damaged configured ciphertext fails closed instead of using the fallback group', async () => {
  const auth = new MemoryAuthRepository();
  await auth.createUser({ id: USER_ID, username: 'worker', passwordHash: 'hash', role: 'user' });
  const repository = new MemoryUserWecomWebhookRepository();
  const service = new UserWecomWebhookService(repository, auth, MASTER_KEY, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-fallback-key');
  await service.set(USER_ID, WEBHOOK);
  const stored = await repository.findByUserId(USER_ID);
  stored.tag[0] ^= 0xff;
  await repository.save(USER_ID, stored);
  await assert.rejects(service.resolve(USER_ID), (error) => error.code === 'WECOM_WEBHOOK_DECRYPT_FAILED');
});

test('admin cookie and CSRF can configure a user while responses never return webhook secrets', async () => {
  const auth = new MemoryAuthRepository();
  await auth.createUser({ id: USER_ID, username: 'worker', passwordHash: await hashPassword('Worker-pass-1'), role: 'user' });
  const repository = new MemoryUserWecomWebhookRepository();
  const app = buildApp({
    config: config(),
    authRepository: auth,
    userWecomWebhookRepository: repository,
    dependencies: { database: { check: async () => true }, objectStorage: { check: async () => true } },
  });
  await app.ready();
  try {
    const admin = await login(app, 'admin', ADMIN_PASSWORD);
    const missingCsrf = await app.inject({ method: 'PUT', url: `/users/${USER_ID}/wecom-webhook`, headers: { cookie: admin.cookie, origin: 'https://admin.example.test' }, payload: { webhookUrl: WEBHOOK } });
    assert.equal(missingCsrf.statusCode, 403);

    const set = await app.inject({ method: 'PUT', url: `/users/${USER_ID}/wecom-webhook`, headers: { cookie: admin.cookie, origin: 'https://admin.example.test', 'x-csrf-token': admin.csrfToken }, payload: { webhookUrl: WEBHOOK } });
    assert.equal(set.statusCode, 200);
    assert.deepEqual(set.json(), { userId: USER_ID, wecomWebhookConfigured: true });
    assert.equal(set.body.includes('synthetic-user-key'), false);

    const users = await app.inject({ method: 'GET', url: '/users', headers: { cookie: admin.cookie } });
    assert.equal(users.statusCode, 200);
    const worker = users.json().users.find((user) => user.id === USER_ID);
    assert.equal(worker.wecomWebhookConfigured, true);
    assert.equal(users.body.includes('synthetic-user-key'), false);
    assert.equal(users.body.includes('ciphertext'), false);
    const usersPage = await app.inject({ method: 'GET', url: '/admin/users', headers: { cookie: admin.cookie } });
    const adminAsset = await app.inject({ method: 'GET', url: '/admin/assets/admin.js' });
    assert.match(usersPage.body, /企业微信群/);
    assert.match(adminAsset.body, /配置群机器人/);
    assert.match(adminAsset.body, /clear-user-wecom/);
    assert.equal(usersPage.body.includes('synthetic-user-key'), false);
    assert.equal(adminAsset.body.includes('synthetic-user-key'), false);

    const workerLogin = await login(app, 'worker', 'Worker-pass-1');
    const denied = await app.inject({ method: 'DELETE', url: `/users/${USER_ID}/wecom-webhook`, headers: { cookie: workerLogin.cookie, origin: 'https://admin.example.test', 'x-csrf-token': workerLogin.csrfToken } });
    assert.equal(denied.statusCode, 403);

    const anonymous = await app.inject({ method: 'PUT', url: `/users/${USER_ID}/wecom-webhook`, payload: { webhookUrl: WEBHOOK } });
    assert.equal(anonymous.statusCode, 401);
    const adminUser = await auth.findUserByUsername('admin');
    const device = await auth.createExtensionDevice({
      id: '00000000-0000-4000-8000-000000000711',
      deviceId: '00000000-0000-4000-8000-000000000712',
      pairedBy: adminUser.id,
    });
    const bearer = 'synthetic-admin-extension-token';
    await auth.createSession({
      id: '00000000-0000-4000-8000-000000000713',
      userId: adminUser.id,
      tokenHash: hashToken(bearer),
      clientType: 'extension',
      extensionDeviceId: device.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const extensionDenied = await app.inject({ method: 'PUT', url: `/users/${USER_ID}/wecom-webhook`, headers: { authorization: `Bearer ${bearer}` }, payload: { webhookUrl: WEBHOOK } });
    assert.equal(extensionDenied.statusCode, 403);

    const cleared = await app.inject({ method: 'DELETE', url: `/users/${USER_ID}/wecom-webhook`, headers: { cookie: admin.cookie, origin: 'https://admin.example.test', 'x-csrf-token': admin.csrfToken } });
    assert.deepEqual(cleared.json(), { userId: USER_ID, wecomWebhookConfigured: false });
  } finally {
    await app.close();
  }
});
