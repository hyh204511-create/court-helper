import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/app.ts';

const TEST_KEY = Buffer.alloc(32, 41).toString('base64');

function config(webhookUrl) {
  return loadConfig({
    PORT: '3120',
    DATABASE_URL: 'postgres://test:secret@localhost:5432/court_helper',
    CREDENTIAL_MASTER_KEY: TEST_KEY,
    CORS_EXTENSION_ORIGINS: 'chrome-extension://test-extension',
    CORS_ADMIN_ORIGINS: 'https://admin.example.test',
    OBJECT_STORAGE_ENDPOINT: 'https://cos.example.test',
    OBJECT_STORAGE_BUCKET: 'private-test-bucket',
    ADMIN_INITIAL_PASSWORD: 'Admin-pass-1',
    WECOM_WEBHOOK_URL: webhookUrl,
  });
}

test('validates the configured webhook allowlist', () => {
  assert.throws(() => config('https://example.test/cgi-bin/webhook/send?key=x'), /WECOM_WEBHOOK_URL/);
  assert.throws(() => config('http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x'), /WECOM_WEBHOOK_URL/);
  assert.throws(() => config('https://qyapi.weixin.qq.com/cgi-bin/webhook/send'), /WECOM_WEBHOOK_URL/);
});
