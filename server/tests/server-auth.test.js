import test from 'node:test';
import assert from 'node:assert/strict';

import { buildApp, loadConfig } from '../src/app.ts';
import { DUMMY_PASSWORD_HASH, hashPassword } from '../src/auth/password.ts';
import { MemoryAuthRepository } from '../src/auth/memory-repository.ts';
import { AuthService } from '../src/auth/service.ts';
import { hashToken } from '../src/auth/token.ts';

const TEST_KEY = Buffer.alloc(32, 9).toString('base64');
const ADMIN_PASSWORD = 'Admin-pass-1';

function configEnv(adminPassword = ADMIN_PASSWORD) {
  return {
    PORT: '3101',
    DATABASE_URL: 'postgres://test:secret@localhost:5432/court_helper',
    CREDENTIAL_MASTER_KEY: TEST_KEY,
    CORS_EXTENSION_ORIGINS: 'chrome-extension://test-extension',
    CORS_ADMIN_ORIGINS: 'https://admin.example.test',
    OBJECT_STORAGE_ENDPOINT: 'https://cos.example.test',
    OBJECT_STORAGE_BUCKET: 'private-test-bucket',
    ADMIN_INITIAL_PASSWORD: adminPassword,
  };
}

async function addUser(repository, {
  username = 'worker',
  password = 'Worker-pass-1',
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

async function makeApp(repository = new MemoryAuthRepository(), adminPassword = ADMIN_PASSWORD, localLoginHelper) {
  const app = buildApp({
    config: loadConfig(configEnv(adminPassword)),
    dependencies: {
      database: { check: async () => true },
      objectStorage: { check: async () => true },
    },
    authRepository: repository,
    ...(localLoginHelper ? { localLoginHelper } : {}),
  });
  await app.ready();
  return { app, repository };
}

test('successful admin UI login starts the local OCR helper without blocking authentication', async () => {
  let starts = 0;
  const { app } = await makeApp(new MemoryAuthRepository(), ADMIN_PASSWORD, {
    ensureRunning: async () => { starts += 1; },
    stop: async () => {},
  });

  try {
    const admin = await loginAdmin(app);
    assert.equal(admin.response.statusCode, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts, 1);

    const extension = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: 'chrome-extension://test-extension' },
      payload: { username: 'admin', password: ADMIN_PASSWORD, clientType: 'extension' },
    });
    assert.equal(extension.statusCode, 400);
    assert.equal(starts, 1);
  } finally {
    await app.close();
  }
});

function cookieHeader(response) {
  const setCookie = response.headers['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(first, 'expected a session cookie');
  return first.split(';', 1)[0];
}

function sessionToken(cookie) {
  return cookie.split('=', 2)[1];
}

async function loginAdmin(app) {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { origin: 'https://admin.example.test' },
    payload: { username: 'ADMIN', password: ADMIN_PASSWORD, clientType: 'admin_ui' },
  });
  assert.equal(response.statusCode, 200);
  return {
    response,
    cookie: cookieHeader(response),
    csrfToken: response.json().csrfToken,
  };
}

async function loginWorker(app, password = 'Worker-pass-1', remoteAddress) {
  const request = {
    method: 'POST',
    url: '/auth/login',
    headers: { origin: 'https://admin.example.test' },
    payload: { username: 'worker', password, clientType: 'admin_ui' },
    ...(remoteAddress ? { remoteAddress } : {}),
  };
  return app.inject(request);
}

test('startup seeds one Argon2id admin and never overwrites it', async () => {
  const repository = new MemoryAuthRepository();
  const first = await makeApp(repository, ADMIN_PASSWORD);
  await first.app.close();

  const seeded = await repository.findUserByUsername('admin');
  assert.ok(seeded);
  assert.equal(seeded.role, 'admin');
  assert.equal(seeded.enabled, true);
  assert.match(seeded.passwordHash, /^\$argon2id\$/);

  const second = await makeApp(repository, 'A-different-password-2');
  try {
    const users = await repository.listUsers();
    assert.equal(users.filter((user) => user.username === 'admin').length, 1);
    const oldPassword = await second.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: 'https://admin.example.test' },
      payload: { username: 'admin', password: ADMIN_PASSWORD, clientType: 'admin_ui' },
    });
    assert.equal(oldPassword.statusCode, 200);
  } finally {
    await second.app.close();
  }
});

test('admin login uses a secure HttpOnly cookie and stores only a token digest', async () => {
  const { app, repository } = await makeApp();

  try {
    const login = await loginAdmin(app);
    const setCookie = Array.isArray(login.response.headers['set-cookie'])
      ? login.response.headers['set-cookie'].join(';')
      : login.response.headers['set-cookie'];
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.equal(typeof login.csrfToken, 'string');

    const sessions = await repository.listSessions();
    assert.equal(sessions.length, 1);
    assert.notEqual(sessionToken(login.cookie), sessions[0].tokenHash);
    assert.match(sessions[0].tokenHash, /^[a-f0-9]{64}$/);
  } finally {
    await app.close();
  }
});

test('extension password login is rejected before a session is created', async () => {
  const repository = new MemoryAuthRepository();
  await addUser(repository);
  const { app } = await makeApp(repository);

  try {
    const response = await loginWorker(app);
    assert.equal(response.statusCode, 200);
    assert.ok(response.headers['set-cookie']);
    const passwordExtension = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: 'chrome-extension://test-extension' },
      payload: { username: 'worker', password: 'Worker-pass-1', clientType: 'extension' },
    });
    assert.equal(passwordExtension.statusCode, 400);
    assert.equal((await repository.listSessions()).every((session) => session.clientType === 'admin_ui'), true);
  } finally {
    await app.close();
  }
});

test('password login never mints an extension session', async () => {
  const repository = new MemoryAuthRepository();
  await addUser(repository);
  const { app } = await makeApp(repository);

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: 'chrome-extension://test-extension' },
      payload: { username: 'worker', password: 'Worker-pass-1', clientType: 'extension' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal((await repository.listSessions()).length, 0);
  } finally {
    await app.close();
  }
});

test('wrong credentials are 401 and disabled accounts are rejected without secret details', async () => {
  const repository = new MemoryAuthRepository();
  await addUser(repository);
  await addUser(repository, { username: 'disabled', enabled: false });
  const { app } = await makeApp(repository);

  try {
    const wrong = await loginWorker(app, 'wrong-password');
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json().error.code, 'AUTH_REQUIRED');
    assert.equal(wrong.body.includes('wrong-password'), false);

    const disabled = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: 'https://admin.example.test' },
      payload: { username: 'disabled', password: 'Worker-pass-1', clientType: 'admin_ui' },
    });
    assert.equal(disabled.statusCode, 409);
    assert.equal(disabled.json().error.code, 'ACCOUNT_DISABLED');
  } finally {
    await app.close();
  }
});

test('login throttles a username and rejects the correct password during the window', async () => {
  const repository = new MemoryAuthRepository();
  await addUser(repository);
  const { app } = await makeApp(repository);

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await loginWorker(app, 'wrong-password');
      assert.equal(failed.statusCode, 401);
    }

    const blocked = await loginWorker(app);
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().error.code, 'RATE_LIMITED');
    assert.match(blocked.headers['retry-after'], /^\d+$/);
  } finally {
    await app.close();
  }
});

test('login throttles an IP across usernames but allows a different IP', async () => {
  const repository = new MemoryAuthRepository();
  const passwordHash = await hashPassword('Worker-pass-1');
  for (let index = 0; index < 6; index += 1) {
    await repository.createUser({
      username: `worker-${index}`,
      passwordHash,
      role: 'user',
      enabled: true,
    });
  }
  const { app } = await makeApp(repository);

  try {
    for (let index = 0; index < 5; index += 1) {
      const failed = await app.inject({
        method: 'POST',
        url: '/auth/login',
        remoteAddress: '198.51.100.10',
        headers: { origin: 'https://admin.example.test' },
        payload: {
          username: `worker-${index}`,
          password: 'wrong-password',
          clientType: 'admin_ui',
        },
      });
      assert.equal(failed.statusCode, 401);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: '198.51.100.10',
      headers: { origin: 'https://admin.example.test' },
      payload: { username: 'worker-5', password: 'Worker-pass-1', clientType: 'admin_ui' },
    });
    assert.equal(blocked.statusCode, 429);

    const allowed = await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: '198.51.100.11',
      headers: { origin: 'https://admin.example.test' },
      payload: { username: 'worker-5', password: 'Worker-pass-1', clientType: 'admin_ui' },
    });
    assert.equal(allowed.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('unknown login performs the dummy password verification path', async () => {
  const repository = new MemoryAuthRepository();
  const known = await addUser(repository);
  const calls = [];
  const service = new AuthService(repository, loadConfig(configEnv()), {
    verifyPassword: async (passwordHash, password) => {
      calls.push({ passwordHash, password });
      return false;
    },
  });

  await assert.rejects(
    service.login('missing', 'attempted-password', 'admin_ui', '198.51.100.20'),
    (error) => error.code === 'AUTH_REQUIRED',
  );
  assert.deepEqual(calls, [{ passwordHash: DUMMY_PASSWORD_HASH, password: 'attempted-password' }]);

  calls.length = 0;
  await assert.rejects(
    service.login('worker', 'attempted-password', 'admin_ui', '198.51.100.21'),
    (error) => error.code === 'AUTH_REQUIRED',
  );
  assert.deepEqual(calls, [{ passwordHash: known.passwordHash, password: 'attempted-password' }]);
});

test('auth/me authenticates both channels and never falls back from invalid bearer to cookie', async () => {
  const { app } = await makeApp();

  try {
    const admin = await loginAdmin(app);
    const cookieMe = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: admin.cookie },
    });
    assert.equal(cookieMe.statusCode, 200);
    assert.equal(cookieMe.json().username, 'admin');
    assert.equal(typeof cookieMe.json().csrfToken, 'string');

    const invalidBearer = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: admin.cookie, authorization: 'Bearer invalid-token' },
    });
    assert.equal(invalidBearer.statusCode, 401);

    const apiMe = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: admin.cookie },
    });
    assert.equal(apiMe.statusCode, 200);
    assert.equal(apiMe.json().role, 'admin');
  } finally {
    await app.close();
  }
});

test('cookie logout requires the configured Origin and in-memory CSRF token', async () => {
  const { app, repository } = await makeApp();

  try {
    const admin = await loginAdmin(app);
    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: admin.cookie, origin: 'https://admin.example.test' },
    });
    assert.equal(missingCsrf.statusCode, 403);

    const wrongOrigin = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        cookie: admin.cookie,
        origin: 'https://evil.example.test',
        'x-csrf-token': admin.csrfToken,
      },
    });
    assert.equal(wrongOrigin.statusCode, 403);

    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        cookie: admin.cookie,
        origin: 'https://admin.example.test',
        'x-csrf-token': admin.csrfToken,
      },
    });
    assert.equal(logout.statusCode, 200);
    assert.deepEqual(logout.json(), { ok: true });
    assert.equal((await repository.listSessions())[0].revokedAt !== null, true);

    const after = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: admin.cookie } });
    assert.equal(after.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('logout revokes only the session and allows the same user to log in again', async () => {
  const { app, repository } = await makeApp();
  try {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await loginAdmin(app);
      const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: current.cookie, origin: 'https://admin.example.test', 'x-csrf-token': current.csrfToken } });
      assert.equal(logout.statusCode, 200);
      const user = await repository.findUserByUsername('admin');
      assert.ok(user);
      assert.equal(user.enabled, true);
      assert.equal(user.deletedAt, null);
    }
    const finalLogin = await loginAdmin(app);
    assert.equal(finalLogin.response.statusCode, 200);
    assert.equal((await repository.listSessions()).filter((session) => session.revokedAt === null).length, 1);
  } finally { await app.close(); }
});

test('user and administrator extension bearers cannot access user management', async () => {
  const repository = new MemoryAuthRepository();
  await addUser(repository);
  const { app } = await makeApp(repository);

  try {
    const workerUser = await repository.findUserByUsername('worker');
    const workerDevice = await repository.createExtensionDevice({
      id: '00000000-0000-4000-8000-000000000101',
      deviceId: '00000000-0000-4000-8000-000000000102',
      pairedBy: workerUser.id,
    });
    const workerToken = 'paired-worker-token';
    await repository.createSession({
      id: '00000000-0000-4000-8000-000000000103',
      userId: workerUser.id,
      tokenHash: hashToken(workerToken),
      clientType: 'extension',
      extensionDeviceId: workerDevice.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const denied = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { authorization: `Bearer ${workerToken}` },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error.code, 'FORBIDDEN');

    const adminUser = await repository.findUserByUsername('admin');
    const adminDevice = await repository.createExtensionDevice({
      id: '00000000-0000-4000-8000-000000000104',
      deviceId: '00000000-0000-4000-8000-000000000105',
      pairedBy: adminUser.id,
    });
    const adminToken = 'paired-admin-token';
    await repository.createSession({
      id: '00000000-0000-4000-8000-000000000106',
      userId: adminUser.id,
      tokenHash: hashToken(adminToken),
      clientType: 'extension',
      extensionDeviceId: adminDevice.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const users = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(users.statusCode, 403);
    assert.equal(users.json().error.code, 'FORBIDDEN');
  } finally {
    await app.close();
  }
});

test('admin creates users and password reset revokes every prior session', async () => {
  const repository = new MemoryAuthRepository();
  const { app } = await makeApp(repository);

  try {
    const admin = await loginAdmin(app);
    const created = await app.inject({
      method: 'POST',
      url: '/users',
      headers: {
        cookie: admin.cookie,
        origin: 'https://admin.example.test',
        'x-csrf-token': admin.csrfToken,
      },
      payload: { username: 'worker', password: 'Worker-pass-1', role: 'user' },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().username, 'worker');
    assert.equal(JSON.stringify(created.json()).includes('Worker-pass-1'), false);

    const workerLogin = await loginWorker(app);
    const workerToken = sessionToken(cookieHeader(workerLogin));
    const reset = await app.inject({
      method: 'POST',
      url: `/users/${created.json().id}/reset-password`,
      headers: {
        cookie: admin.cookie,
        origin: 'https://admin.example.test',
        'x-csrf-token': admin.csrfToken,
      },
      payload: { password: 'Worker-pass-2' },
    });
    assert.equal(reset.statusCode, 200);

    const revoked = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `court_helper_session=${workerToken}` },
    });
    assert.equal(revoked.statusCode, 401);
    assert.equal((await loginWorker(app, 'Worker-pass-1')).statusCode, 401);
    assert.equal((await loginWorker(app, 'Worker-pass-2')).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('the last enabled admin cannot be disabled, demoted, or soft-deleted', async () => {
  const { app, repository } = await makeApp();

  try {
    const admin = await loginAdmin(app);
    const id = (await repository.findUserByUsername('admin')).id;
    const demote = await app.inject({
      method: 'PATCH',
      url: `/users/${id}`,
      headers: {
        cookie: admin.cookie,
        origin: 'https://admin.example.test',
        'x-csrf-token': admin.csrfToken,
      },
      payload: { role: 'user' },
    });
    assert.equal(demote.statusCode, 409);
    assert.equal(demote.json().error.code, 'LAST_ADMIN');

    const disable = await app.inject({
      method: 'PATCH',
      url: `/users/${id}`,
      headers: {
        cookie: admin.cookie,
        origin: 'https://admin.example.test',
        'x-csrf-token': admin.csrfToken,
      },
      payload: { enabled: false },
    });
    assert.equal(disable.statusCode, 409);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/users/${id}`,
      headers: {
        cookie: admin.cookie,
        origin: 'https://admin.example.test',
        'x-csrf-token': admin.csrfToken,
      },
    });
    assert.equal(remove.statusCode, 409);
    assert.equal((await repository.findUserByUsername('admin')).deletedAt, null);
  } finally {
    await app.close();
  }
});
