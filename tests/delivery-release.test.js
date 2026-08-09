import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PRODUCTION_SERVER_URL,
  extensionIdFromPublicKey,
  makeProductionManifest,
  npmExecutionOptions,
  validateReleaseTree,
} from '../scripts/release-config.mjs';
import { normalizeServerUrl } from '../extension/config/deployment.js';
import { copyReleaseInput } from '../scripts/release-files.mjs';

test('production server URL accepts only the exact HTTPS root origin', () => {
  assert.equal(PRODUCTION_SERVER_URL, 'https://court.hyhbrand.xyz');
  assert.equal(normalizeServerUrl('https://court.hyhbrand.xyz/', PRODUCTION_SERVER_URL), PRODUCTION_SERVER_URL);
  for (const value of [
    'http://court.hyhbrand.xyz',
    'https://user:pass@court.hyhbrand.xyz',
    'https://court.hyhbrand.xyz:444',
    'https://court.hyhbrand.xyz/admin',
    'https://court.hyhbrand.xyz?next=x',
    'https://court.hyhbrand.xyz#fragment',
    'https://evil.hyhbrand.xyz',
  ]) {
    assert.equal(normalizeServerUrl(value, PRODUCTION_SERVER_URL), null, value);
  }
});

test('production manifest has a stable public key and minimum host permissions', () => {
  const source = {
    manifest_version: 3,
    version: '0.1.0',
    host_permissions: ['https://zxfw.court.gov.cn/*', 'http://127.0.0.1:8765/*', 'http://127.0.0.1:3000/*'],
  };
  const publicKey = Buffer.from('stable-public-key').toString('base64');
  const manifest = makeProductionManifest(source, { version: '0.2.0', publicKey });

  assert.equal(manifest.version, '0.2.0');
  assert.equal(manifest.key, publicKey);
  assert.equal(manifest.court_helper, undefined);
  assert.deepEqual(manifest.host_permissions, [
    'https://zxfw.court.gov.cn/*',
    'http://127.0.0.1:8765/*',
    'https://court.hyhbrand.xyz/*',
  ]);
  assert.match(extensionIdFromPublicKey(publicKey), /^[a-p]{32}$/);
});

test('release tree rejects secrets, business files, tests and dependency trees', () => {
  assert.deepEqual(validateReleaseTree([
    'server/docker-compose.yml',
    'extension/manifest.json',
    'docs/user-guide.pdf',
  ]), []);
  const errors = validateReleaseTree([
    'server/.env',
    'deploy/certs/privkey.pem',
    '.release-secrets/extension-key.pem',
    'tests/example.test.js',
    'node_modules/pkg/index.js',
    'customer.xlsx',
    'capture.png',
  ]);
  assert.equal(errors.length, 7);
});

test('package scripts expose a single verified release command', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.version, '0.2.0');
  assert.equal(packageJson.scripts.release, 'node ./scripts/release-package.mjs');
});

test('release invokes npm through the Windows command interpreter without shell mode', () => {
  const windows = npmExecutionOptions('win32');
  assert.match(windows.command, /(?:cmd\.exe)$/i);
  assert.deepEqual(windows.prefixArgs, ['/d', '/s', '/c', 'npm.cmd']);
  assert.deepEqual(npmExecutionOptions('linux'), { command: 'npm', prefixArgs: [] });
});

test('release copies nested directories without relying on recursive cpSync', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'court-helper-release-'));
  const source = join(temporary, '源目录');
  const destination = join(temporary, '交付目录');
  try {
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'nested.txt'), 'release-safe');
    copyReleaseInput(source, destination);
    assert.equal(await readFile(join(destination, 'nested.txt'), 'utf8'), 'release-safe');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
