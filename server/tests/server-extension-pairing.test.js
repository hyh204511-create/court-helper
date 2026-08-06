import assert from 'node:assert/strict';
import test from 'node:test';
import { newDb } from 'pg-mem';

import { buildApp, loadConfig } from '../src/app.ts';
import { MemoryAuthRepository } from '../src/auth/memory-repository.ts';
import { PgAuthRepository } from '../src/auth/repository.ts';
import { runMigrations } from '../src/db/migrator.ts';

const ADMIN_PASSWORD = 'Admin-pass-1';
const TEST_KEY = Buffer.alloc(32, 9).toString('base64');
const ADMIN_ORIGIN = 'https://admin.example.test';
const EXTENSION_ORIGIN = 'chrome-extension://test-extension';
const DEVICE_ID = '6b520a09-87bc-4adb-bacd-4b4f7c5ab4d1';
const EXCHANGE_SECRET = 'F5u7-dSlxHTwnl_JMiCNomrTHnrqWy3dyzyIVI7-WaM';

function configEnv() {
  return {
    PORT: '3101',
    DATABASE_URL: 'postgres://test:secret@localhost:5432/court_helper',
    CREDENTIAL_MASTER_KEY: TEST_KEY,
    CORS_EXTENSION_ORIGINS: EXTENSION_ORIGIN,
    CORS_ADMIN_ORIGINS: ADMIN_ORIGIN,
    OBJECT_STORAGE_ENDPOINT: 'https://cos.example.test',
    OBJECT_STORAGE_BUCKET: 'private-test-bucket',
    ADMIN_INITIAL_PASSWORD: ADMIN_PASSWORD,
  };
}

function cookieHeader(response) {
  const setCookie = response.headers['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(first, 'expected a session cookie');
  return first.split(';', 1)[0];
}

async function makeApp() {
  const app = buildApp({
    config: loadConfig(configEnv()),
    dependencies: {
      database: { check: async () => true },
      objectStorage: { check: async () => true },
    },
    authRepository: new MemoryAuthRepository(),
  });
  await app.ready();
  return app;
}

async function loginAdmin(app) {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin: ADMIN_ORIGIN },
    payload: { username: 'admin', password: ADMIN_PASSWORD, clientType: 'admin_ui' },
  });
  assert.equal(response.statusCode, 200);
  return { cookie: cookieHeader(response), csrfToken: response.json().csrfToken };
}

async function createPairing(app) {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/extension-pairings',
    headers: { origin: EXTENSION_ORIGIN },
    payload: { deviceId: DEVICE_ID, label: 'Edge test device', exchangeSecret: EXCHANGE_SECRET },
  });
  assert.equal(response.statusCode, 201);
  assert.match(response.json().pairing.id, /^[0-9a-f-]{36}$/);
  assert.match(response.json().pairing.verificationCode, /^\d{6}$/);
  assert.equal(response.body.includes(EXCHANGE_SECRET), false);
  return response.json().pairing;
}

test('administrator explicitly pairs an extension device, user-management stays denied, and revocation is immediate', async () => {
  const app = await makeApp();
  try {
    const pairing = await createPairing(app);
    const admin = await loginAdmin(app);

    const controlPage = await app.inject({
      method: 'GET',
      url: '/admin/browser-control',
      headers: { cookie: admin.cookie },
    });
    assert.equal(controlPage.statusCode, 200);
    assert.match(controlPage.body, /extension-pairing-list/);
    assert.match(controlPage.body, /extension-device-list/);

    const pending = await app.inject({
      method: 'GET',
      url: '/auth/extension-pairings',
      headers: { cookie: admin.cookie },
    });
    assert.equal(pending.statusCode, 200);
    assert.deepEqual(pending.json().pairings.map((item) => item.id), [pairing.id]);
    assert.equal(pending.body.includes(EXCHANGE_SECRET), false);

    const missingCsrf = await app.inject({
      method: 'POST',
      url: `/auth/extension-pairings/${pairing.id}/approve`,
      headers: { cookie: admin.cookie, origin: ADMIN_ORIGIN },
      payload: { verificationCode: pairing.verificationCode },
    });
    assert.equal(missingCsrf.statusCode, 403);

    const approved = await app.inject({
      method: 'POST',
      url: `/auth/extension-pairings/${pairing.id}/approve`,
      headers: {
        cookie: admin.cookie,
        origin: ADMIN_ORIGIN,
        'x-csrf-token': admin.csrfToken,
      },
      payload: { verificationCode: pairing.verificationCode },
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().pairing.status, 'approved');

    const exchanged = await app.inject({
      method: 'POST',
      url: `/auth/extension-pairings/${pairing.id}/exchange`,
      headers: { origin: EXTENSION_ORIGIN },
      payload: { exchangeSecret: EXCHANGE_SECRET },
    });
    assert.equal(exchanged.statusCode, 200);
    assert.match(exchanged.json().token, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(exchanged.body.includes(EXCHANGE_SECRET), false);
    const token = exchanged.json().token;

    const userManagementRequests = [
      { method: 'GET', url: '/users' },
      { method: 'GET', url: '/users/00000000-0000-4000-8000-000000000011' },
      { method: 'POST', url: '/users', payload: {} },
      { method: 'PATCH', url: '/users/00000000-0000-4000-8000-000000000011', payload: {} },
      { method: 'DELETE', url: '/users/00000000-0000-4000-8000-000000000011' },
      { method: 'POST', url: '/users/00000000-0000-4000-8000-000000000011/reset-password', payload: {} },
    ];
    for (const request of userManagementRequests) {
      const denied = await app.inject({
        ...request,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(denied.statusCode, 403, `${request.method} ${request.url}`);
    }

    const extensionMe = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(extensionMe.statusCode, 200);
    assert.equal(extensionMe.json().role, 'admin');

    for (const url of ['/admin/cases', '/admin/users', '/admin/browser-control']) {
      const denied = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(denied.statusCode, 403, url);
    }

    const replay = await app.inject({
      method: 'POST',
      url: `/auth/extension-pairings/${pairing.id}/exchange`,
      headers: { origin: EXTENSION_ORIGIN },
      payload: { exchangeSecret: EXCHANGE_SECRET },
    });
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().error.code, 'PAIRING_CONSUMED');

    const devices = await app.inject({
      method: 'GET',
      url: '/auth/extension-devices',
      headers: { cookie: admin.cookie },
    });
    assert.equal(devices.statusCode, 200);
    const device = devices.json().devices[0];
    assert.equal(device.deviceId, DEVICE_ID);

    const revoked = await app.inject({
      method: 'POST',
      url: `/auth/extension-devices/${device.id}/revoke`,
      headers: {
        cookie: admin.cookie,
        origin: ADMIN_ORIGIN,
        'x-csrf-token': admin.csrfToken,
      },
      payload: {},
    });
    assert.equal(revoked.statusCode, 200);

    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(afterRevoke.statusCode, 401);

    const revokedDevicePairing = await app.inject({
      method: 'POST',
      url: '/auth/extension-pairings',
      headers: { origin: EXTENSION_ORIGIN },
      payload: { deviceId: DEVICE_ID, exchangeSecret: EXCHANGE_SECRET },
    });
    assert.equal(revokedDevicePairing.statusCode, 409);
    assert.equal(revokedDevicePairing.json().error.code, 'DEVICE_REVOKED');
  } finally {
    await app.close();
  }
});

test('pairing creation keeps one active code per device and rate-limits unauthenticated creation', async () => {
  const app = await makeApp();
  try {
    const first = await createPairing(app);
    const replacement = await app.inject({
      method: 'POST',
      url: '/auth/extension-pairings',
      headers: { origin: EXTENSION_ORIGIN },
      payload: {
        deviceId: DEVICE_ID,
        label: 'replacement request',
        exchangeSecret: 'A'.repeat(43),
      },
    });
    assert.equal(replacement.statusCode, 201);

    const admin = await loginAdmin(app);
    const pending = await app.inject({
      method: 'GET',
      url: '/auth/extension-pairings',
      headers: { cookie: admin.cookie },
    });
    assert.equal(pending.statusCode, 200);
    assert.equal(pending.json().pairings.length, 1);
    assert.notEqual(pending.json().pairings[0].id, first.id);

    const uniqueDeviceId = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    for (let index = 1; index <= 3; index += 1) {
      const accepted = await app.inject({
        method: 'POST',
        url: '/auth/extension-pairings',
        headers: { origin: EXTENSION_ORIGIN },
        payload: { deviceId: uniqueDeviceId(index), exchangeSecret: 'B'.repeat(43) },
      });
      assert.equal(accepted.statusCode, 201);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/auth/extension-pairings',
      headers: { origin: EXTENSION_ORIGIN },
      payload: { deviceId: uniqueDeviceId(4), exchangeSecret: 'C'.repeat(43) },
    });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'RATE_LIMITED');
  } finally {
    await app.close();
  }
});

test('pairing exchange rejects unauthorized origins, incorrect codes and unapproved secrets', async () => {
  const app = await makeApp();
  try {
    const badOrigin = await app.inject({
      method: 'POST',
      url: '/auth/extension-pairings',
      headers: { origin: 'chrome-extension://other-extension' },
      payload: { deviceId: DEVICE_ID, exchangeSecret: EXCHANGE_SECRET },
    });
    assert.equal(badOrigin.statusCode, 403);

    const pairing = await createPairing(app);
    const beforeApproval = await app.inject({
      method: 'POST',
      url: `/auth/extension-pairings/${pairing.id}/exchange`,
      headers: { origin: EXTENSION_ORIGIN },
      payload: { exchangeSecret: EXCHANGE_SECRET },
    });
    assert.equal(beforeApproval.statusCode, 409);
    assert.equal(beforeApproval.json().error.code, 'PAIRING_PENDING');

    const admin = await loginAdmin(app);
    const badCode = await app.inject({
      method: 'POST',
      url: `/auth/extension-pairings/${pairing.id}/approve`,
      headers: { cookie: admin.cookie, origin: ADMIN_ORIGIN, 'x-csrf-token': admin.csrfToken },
      payload: { verificationCode: '000000' },
    });
    assert.equal(badCode.statusCode, 403);

    const wrongSecret = await app.inject({
      method: 'POST',
      url: `/auth/extension-pairings/${pairing.id}/exchange`,
      headers: { origin: EXTENSION_ORIGIN },
      payload: { exchangeSecret: 'wrong-secret-that-is-still-long-enough-000000000' },
    });
    assert.equal(wrongSecret.statusCode, 403);
  } finally {
    await app.close();
  }
});

test('PostgreSQL repository persists hashed pairing state, device binding, and device revocation', async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  const pg = database.adapters.createPg();
  const pool = new pg.Pool();
  const adminId = '00000000-0000-4000-8000-000000000001';
  const pairingId = '00000000-0000-4000-8000-000000000002';
  const deviceRecordId = '00000000-0000-4000-8000-000000000003';
  const sessionId = '00000000-0000-4000-8000-000000000004';
  try {
    await runMigrations(pool);
    await pool.query(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES ($1, 'admin', 'hash', 'admin')
    `, [adminId]);
    const repository = new PgAuthRepository(pool);
    const now = new Date('2026-08-06T00:00:00.000Z');
    const pairing = await repository.createExtensionPairing({
      id: pairingId,
      deviceId: DEVICE_ID,
      label: 'test device',
      exchangeSecretHash: 'a'.repeat(64),
      verificationCodeHash: 'b'.repeat(64),
      expiresAt: new Date('2026-08-06T00:05:00.000Z'),
    });
    assert.equal(pairing.status, 'pending');

    const concurrentCreateInputs = [
      {
        id: '00000000-0000-4000-8000-000000000011',
        exchangeSecretHash: '1'.repeat(64),
        verificationCodeHash: '2'.repeat(64),
      },
      {
        id: '00000000-0000-4000-8000-000000000012',
        exchangeSecretHash: '3'.repeat(64),
        verificationCodeHash: '4'.repeat(64),
      },
    ].map((value) => ({
      ...value,
      deviceId: '00000000-0000-4000-8000-000000000010',
      label: 'same device concurrent request',
      expiresAt: new Date('2026-08-06T00:05:00.000Z'),
    }));
    const createdConcurrently = await Promise.all(concurrentCreateInputs.map((input) => repository.createExtensionPairing(input)));
    assert.equal(createdConcurrently.length, 2);
    const activePairings = await repository.listExtensionPairings('pending');
    assert.equal(activePairings.filter((entry) => entry.deviceId === '00000000-0000-4000-8000-000000000010').length, 1);

    assert.equal((await repository.approveExtensionPairing(pairingId, 'b'.repeat(64), adminId, now))?.status, 'approved');
    assert.equal((await repository.consumeExtensionPairing(pairingId, 'a'.repeat(64), now))?.status, 'consumed');
    const device = await repository.createExtensionDevice({
      id: deviceRecordId,
      deviceId: DEVICE_ID,
      label: 'test device',
      pairedBy: adminId,
    });
    await repository.createSession({
      id: sessionId,
      userId: adminId,
      tokenHash: 'c'.repeat(64),
      clientType: 'extension',
      extensionDeviceId: device.id,
      expiresAt: new Date('2026-09-06T00:00:00.000Z'),
    });
    await repository.revokeExtensionDevice(device.id);
    assert.equal((await repository.findSessionByTokenHash('c'.repeat(64)))?.revokedAt !== null, true);

    const concurrentPairingId = '00000000-0000-4000-8000-000000000005';
    await repository.createExtensionPairing({
      id: concurrentPairingId,
      deviceId: '00000000-0000-4000-8000-000000000006',
      label: 'concurrent device',
      exchangeSecretHash: 'd'.repeat(64),
      verificationCodeHash: 'e'.repeat(64),
      expiresAt: new Date('2026-08-06T00:05:00.000Z'),
    });
    await repository.approveExtensionPairing(concurrentPairingId, 'e'.repeat(64), adminId, now);
    const exchange = (sessionIdValue) => repository.exchangeExtensionPairing({
      pairingId: concurrentPairingId,
      exchangeSecretHash: 'd'.repeat(64),
      now,
      device: {
        id: '00000000-0000-4000-8000-000000000007',
        deviceId: '00000000-0000-4000-8000-000000000006',
        label: 'concurrent device',
        pairedBy: adminId,
      },
      session: {
        id: sessionIdValue,
        userId: adminId,
        tokenHash: 'f'.repeat(64),
        clientType: 'extension',
        expiresAt: new Date('2026-09-06T00:00:00.000Z'),
      },
    });
    const exchanges = await Promise.all([
      exchange('00000000-0000-4000-8000-000000000008'),
      exchange('00000000-0000-4000-8000-000000000009'),
    ]);
    assert.equal(exchanges.filter(Boolean).length, 1);
    const finalPairing = await repository.getExtensionPairing(concurrentPairingId);
    assert.equal(finalPairing?.status, 'consumed');
    const sessions = await pool.query(`
      SELECT COUNT(*) AS count FROM sessions
      WHERE extension_device_id = '00000000-0000-4000-8000-000000000007'
    `);
    assert.equal(Number(sessions.rows[0].count), 1);
  } finally {
    await pool.end();
  }
});
