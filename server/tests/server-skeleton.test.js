import test from 'node:test';
import assert from 'node:assert/strict';

import { AppError, buildApp, loadConfig } from '../src/app.ts';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

function env(overrides = {}) {
  return {
    PORT: '3100',
    DATABASE_URL: 'postgres://test:secret@localhost:5432/court_helper',
    CREDENTIAL_MASTER_KEY: TEST_KEY,
    CORS_EXTENSION_ORIGINS: 'chrome-extension://test-extension',
    CORS_ADMIN_ORIGINS: 'https://admin.example.test',
    OBJECT_STORAGE_ENDPOINT: 'https://cos.example.test',
    OBJECT_STORAGE_BUCKET: 'private-test-bucket',
    ADMIN_INITIAL_PASSWORD: 'not-used-by-skeleton',
    ...overrides,
  };
}

async function close(app) {
  await app.close();
}

test('loadConfig fails fast when DATABASE_URL is missing', () => {
  assert.throws(
    () => loadConfig(env({ DATABASE_URL: '' })),
    /DATABASE_URL/,
  );
});

test('loadConfig validates the 32-byte base64 credential master key', () => {
  assert.throws(
    () => loadConfig(env({ CREDENTIAL_MASTER_KEY: 'too-short' })),
    /CREDENTIAL_MASTER_KEY/,
  );
});

test('GET /health returns only ok:true when PostgreSQL and object storage are healthy', async () => {
  const app = buildApp({
    config: loadConfig(env()),
    dependencies: {
      database: { check: async () => true },
      objectStorage: { check: async () => true },
    },
  });

  try {
    const response = await app.inject({ method: 'GET', url: '/health' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
    assert.match(response.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    assert.equal(response.body.includes('postgres://'), false);
    assert.equal(response.body.includes('private-test-bucket'), false);
  } finally {
    await close(app);
  }
});

test('GET /health returns 503 without dependency details when a dependency is unavailable', async () => {
  const app = buildApp({
    config: loadConfig(env()),
    dependencies: {
      database: { check: async () => true },
      objectStorage: { check: async () => false },
    },
  });

  try {
    const response = await app.inject({ method: 'GET', url: '/health' });

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { ok: false });
    assert.equal(response.body.includes('private-test-bucket'), false);
  } finally {
    await close(app);
  }
});

test('all route errors use the error envelope and propagate requestId', async () => {
  const app = buildApp({
    config: loadConfig(env()),
    dependencies: {
      database: { check: async () => true },
      objectStorage: { check: async () => true },
    },
    register: async (instance) => {
      instance.get('/test-error', async () => {
        throw new AppError('safe failure', 'SAFE_FAILURE', 418, false, ['field']);
      });
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/test-error',
      headers: { 'x-request-id': 'request-from-test' },
    });

    assert.equal(response.statusCode, 418);
    assert.deepEqual(response.json(), {
      error: {
        code: 'SAFE_FAILURE',
        message: 'safe failure',
        requestId: 'request-from-test',
        retryable: false,
        details: ['field'],
      },
    });
    assert.equal(response.headers['x-request-id'], 'request-from-test');
  } finally {
    await close(app);
  }
});

test('unknown routes also use the error envelope', async () => {
  const app = buildApp({
    config: loadConfig(env()),
    dependencies: {
      database: { check: async () => true },
      objectStorage: { check: async () => true },
    },
  });

  try {
    const response = await app.inject({ method: 'GET', url: '/not-found' });
    const body = response.json();

    assert.equal(response.statusCode, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.retryable, false);
    assert.equal(body.error.requestId, response.headers['x-request-id']);
    assert.deepEqual(body.error.details, []);
  } finally {
    await close(app);
  }
});
