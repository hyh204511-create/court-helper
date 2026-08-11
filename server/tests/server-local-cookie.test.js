import test from 'node:test';
import assert from 'node:assert/strict';

import { buildApp, loadConfig } from '../src/app.ts';
import { MemoryAuthRepository } from '../src/auth/memory-repository.ts';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

function localConfig() {
  return loadConfig({
    PORT: '3109',
    DATABASE_URL: 'postgres://test:secret@localhost:5432/court_helper',
    CREDENTIAL_MASTER_KEY: TEST_KEY,
    CORS_EXTENSION_ORIGINS: 'chrome-extension://test-extension',
    CORS_ADMIN_ORIGINS: 'http://127.0.0.1:3000,https://admin.example.test',
    OBJECT_STORAGE_ENDPOINT: 'https://storage.example.test',
    OBJECT_STORAGE_BUCKET: 'private-test-bucket',
    ADMIN_INITIAL_PASSWORD: 'Admin-pass-1',
  });
}

test('本机 HTTP 后台登录省略 Secure Cookie 以保持会话可用', async () => {
  const app = buildApp({
    config: localConfig(),
    dependencies: {
      database: { check: async () => true },
      objectStorage: { check: async () => true },
    },
    authRepository: new MemoryAuthRepository(),
  });
  await app.ready();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { username: 'admin', password: 'Admin-pass-1', clientType: 'admin_ui' },
    });
    assert.equal(response.statusCode, 200);
    const setCookie = Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie'].join(';')
      : response.headers['set-cookie'];
    assert.match(setCookie, /HttpOnly/i);
    assert.doesNotMatch(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
  } finally {
    await app.close();
  }
});

