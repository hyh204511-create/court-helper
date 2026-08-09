import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function text(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('production nginx is domain-bound, TLS-only and accepts the 20 MiB contract', async () => {
  const nginx = await text('server/deploy/nginx.production.conf');
  assert.match(nginx, /server_name court\.hyhbrand\.xyz;/);
  assert.match(nginx, /return 301 https:\/\/\$host\$request_uri;/);
  assert.match(nginx, /client_max_body_size 25m;/);
  assert.match(nginx, /access_log off;/);
  assert.match(nginx, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
});

test('compose keeps database and application ports private and uses deterministic volumes', async () => {
  const compose = await text('server/docker-compose.yml');
  assert.match(compose, /COMPOSE_PROJECT_NAME:-court-helper/);
  assert.doesNotMatch(compose, /5432:5432/);
  assert.doesNotMatch(compose, /3000:3000/);
  assert.match(compose, /nginx\.production\.conf/);
});

test('production environment template is secret-free and cloud-storage stays disabled', async () => {
  const env = await text('server/.env.production.example');
  assert.match(env, /CORS_ADMIN_ORIGINS=https:\/\/court\.hyhbrand\.xyz/);
  assert.match(env, /CORS_EXTENSION_ORIGINS=chrome-extension:\/\/REPLACE_WITH_FIXED_EXTENSION_ID/);
  assert.match(env, /LOCAL_STORAGE_DIR=\/var\/lib\/court-helper\/storage/);
  assert.doesNotMatch(env, /OBJECT_STORAGE_ENDPOINT=\S+/);
  assert.doesNotMatch(env, /CREDENTIAL_MASTER_KEY=[A-Za-z0-9+/]{40}/);
});

test('Windows OCR installer is isolated, pinned and runs OCR-only on loopback', async () => {
  const install = await text('client/ocr-helper/install.ps1');
  const start = await text('client/ocr-helper/start.ps1');
  const uninstall = await text('client/ocr-helper/uninstall.ps1');
  const requirements = await text('client/ocr-helper/requirements.txt');
  assert.equal(requirements.trim(), 'ddddocr==1.6.1');
  assert.match(install, /LOCALAPPDATA/);
  assert.match(install, /CourtHelper-OcrHelper/);
  assert.match(start, /--ocr-only/);
  assert.match(start, /127\.0\.0\.1:8765/);
  assert.match(uninstall, /CourtHelper-OcrHelper/);
  assert.match(install, /Get-NetTCPConnection/);
  assert.match(install, /pypi\.org\/simple\/ddddocr/);
  assert.doesNotMatch(install + start + uninstall, /accounts\.txt/);
});

test('operations include deploy, upgrade, rollback, encrypted backup and explicit restore confirmation', async () => {
  const deploy = await text('server/deploy/scripts/deploy.sh');
  const upgrade = await text('server/deploy/scripts/upgrade.sh');
  const rollback = await text('server/deploy/scripts/rollback.sh');
  const backup = await text('server/deploy/scripts/backup.sh');
  const restore = await text('server/deploy/scripts/restore.sh');
  const rehearsal = await text('server/deploy/scripts/restore-rehearsal.sh');
  assert.match(deploy, /docker compose --profile tls up -d --build/);
  assert.match(upgrade, /\/opt\/court-helper\/current/);
  assert.match(rollback, /\/opt\/court-helper\/releases/);
  assert.match(backup, /age -r/);
  assert.match(backup, /coscli cp/);
  assert.match(restore, /--confirm-production-restore/);
  assert.match(rehearsal, /court-helper-rehearsal-/);
  assert.match(rehearsal, /docker compose --profile tls down -v/);
});
