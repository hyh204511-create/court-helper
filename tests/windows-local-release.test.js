import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  LOCAL_PORTS,
  localInstallerName,
  makeLocalManifest,
  makeLocalEnvironment,
  validateLocalReleaseTree,
} from '../scripts/windows-local-config.mjs';

test('local Windows delivery uses loopback-only fixed ports', () => {
  assert.deepEqual(LOCAL_PORTS, { server: 3000, postgres: 55432, ocr: 8765 });
});

test('local installer name is versioned and architecture-specific', () => {
  assert.equal(localInstallerName('0.3.0'), 'court-helper-0.3.0-windows-x64-setup.exe');
  assert.throws(() => localInstallerName('0.3'), /version/i);
});

test('local environment ignores inherited database URL and pins private database', () => {
  const env = makeLocalEnvironment({ adminPassword: 'test-password', masterKey: 'a'.repeat(44) });
  assert.equal(env.PORT, '3000');
  assert.equal(env.DATABASE_URL, 'postgres://courthelper:REPLACE_AT_INSTALL@127.0.0.1:55432/courthelper');
  assert.equal(env.CORS_ADMIN_ORIGINS, 'http://127.0.0.1:3000');
  assert.equal(env.CORS_EXTENSION_ORIGINS, 'chrome-extension://LOCAL_EXTENSION_ID');
  assert.equal(env.LOCAL_LOGIN_HELPER_AUTOSTART, 'true');
  assert.equal(env.LOCAL_WINDOWS_DELIVERY, 'true');
  assert.equal(Object.hasOwn(env, 'INHERITED_DATABASE_URL'), false);
});

test('local release tree rejects secrets and business data', () => {
  assert.deepEqual(validateLocalReleaseTree([
    'server/dist/main.js',
    'config/service.env',
    'accounts.txt',
    'screenshots/case.png',
    '.release-secrets/extension-key.pem',
    'extension/manifest.json',
  ]), ['config/service.env', 'accounts.txt', 'screenshots/case.png', '.release-secrets/extension-key.pem']);
});

test('local manifest never retains cloud or wildcard permissions', () => {
  const manifest = makeLocalManifest({ host_permissions: ['*'], version: '0.1.0' }, { version: '0.3.0', publicKey: 'public-key' });
  assert.deepEqual(manifest.host_permissions, [
    'https://zxfw.court.gov.cn/*',
    'http://127.0.0.1:8765/*',
    'http://127.0.0.1:3000/*',
  ]);
});

test('installer keeps secrets off command lines and uses managed service lifecycle', () => {
  const iss = readFileSync(new URL('../installer/windows-local/court-helper.iss', import.meta.url), 'utf8');
  const bootstrap = readFileSync(new URL('../installer/windows-local/bootstrap.ps1', import.meta.url), 'utf8');
  const prepareUpgrade = readFileSync(new URL('../installer/windows-local/prepare-upgrade.ps1', import.meta.url), 'utf8');
  const restoreUpgrade = readFileSync(new URL('../installer/windows-local/restore-upgrade-services.ps1', import.meta.url), 'utf8');
  const backend = readFileSync(new URL('../installer/windows-local/start-backend.ps1', import.meta.url), 'utf8');
  assert.match(iss, /AdminPasswordFile/);
  assert.doesNotMatch(iss, /-AdminPassword\s/);
  assert.match(bootstrap, /CourtHelperBackend\.exe/);
  assert.match(bootstrap, /RandomNumberGenerator\]::Create\(\)/);
  assert.match(bootstrap, /\.GetBytes\(\$b\)/);
  assert.match(bootstrap, /\.Dispose\(\)/);
  assert.doesNotMatch(bootstrap, /RandomNumberGenerator\]::Fill\(/);
  assert.match(bootstrap, /\$pwFile\s*=\s*Join-Path\s+\$configRoot\s+'postgres-password\.tmp'/);
  assert.match(bootstrap, /"--pwfile=\$pwFile"/);
  assert.match(bootstrap, /if \(\$initDbExitCode -ne 0\) \{ throw 'PostgreSQL 数据目录初始化失败。' \}/);
  assert.doesNotMatch(bootstrap, /--pwfile=\(Join-Path/);
  assert.match(bootstrap, /DirectorySecurity/);
  assert.match(bootstrap, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(bootstrap, /SecurityIdentifier/);
  assert.match(bootstrap, /Set-Acl -LiteralPath \$dataRoot -AclObject \$dataAcl/);
  assert.doesNotMatch(bootstrap, /icacls\.exe/);
  assert.match(bootstrap, /WindowsIdentity\]::GetCurrent\(\)\.User/);
  assert.match(bootstrap, /FileSystemRights\]::Read/);
  assert.match(bootstrap, /Set-Acl -LiteralPath \$pwFile -AclObject \$pwAcl/);
  assert.match(bootstrap, /\$dataAcl\.RemoveAccessRuleSpecific\(\$currentUserDataRule\)/);
  assert.match(bootstrap, /postgres\\bin\\createdb\.exe/);
  assert.match(bootstrap, /SELECT 1 FROM pg_database WHERE datname = 'courthelper'/);
  assert.match(bootstrap, /Remove-Item Env:PGPASSWORD/);
  assert.match(bootstrap, /Set-Service CourtHelperPostgres -StartupType Automatic/);
  assert.match(bootstrap, /Set-Service CourtHelperBackend -StartupType Automatic/);
  assert.match(prepareUpgrade, /Set-Service CourtHelperBackend -StartupType Disabled/);
  assert.match(prepareUpgrade, /WaitForStatus\('Stopped'/);
  assert.match(prepareUpgrade, /Get-NetTCPConnection -LocalPort 55432/);
  assert.match(prepareUpgrade, /FileShare\]::None/);
  assert.match(prepareUpgrade, /function Start-AndWait/);
  assert.match(prepareUpgrade, /Start-AndWait 'CourtHelperPostgres'/);
  assert.match(prepareUpgrade, /function Wait-PostgresReady/);
  assert.match(prepareUpgrade, /pg_isready\.exe/);
  assert.match(prepareUpgrade, /PostgreSQL 未能在限定时间内就绪/);
  const postgresStartCall = prepareUpgrade.lastIndexOf("Start-AndWait 'CourtHelperPostgres'");
  const postgresReadyCall = prepareUpgrade.lastIndexOf('  Wait-PostgresReady');
  const postgresDumpCall = prepareUpgrade.indexOf('  & $pgDump');
  assert.ok(postgresStartCall < postgresReadyCall && postgresReadyCall < postgresDumpCall);
  assert.match(prepareUpgrade, /function Wait-PostgresQuiescent/);
  assert.match(prepareUpgrade, /AddSeconds\(30\)/);
  assert.match(prepareUpgrade, /Start-Sleep -Milliseconds 500/);
  assert.match(prepareUpgrade, /PostgreSQL 运行时未能在限定时间内完全停止/);
  assert.match(prepareUpgrade, /if \(-not \(Test-Path -LiteralPath \$lockProbe\)\) \{ throw/);
  assert.doesNotMatch(prepareUpgrade, /Stop-Service CourtHelperPostgres -Force -ErrorAction SilentlyContinue/);
  assert.match(iss, /restore-upgrade-services\.ps1/);
  assert.match(iss, /DeinitializeSetup/);
  assert.match(iss, /court-helper-bootstrap-complete\.txt/);
  assert.match(bootstrap, /CompletionMarker/);
  assert.match(bootstrap, /Set-Content -LiteralPath \$CompletionMarker/);
  assert.match(restoreUpgrade, /Set-Service CourtHelperPostgres -StartupType Automatic/);
  assert.match(restoreUpgrade, /Set-Service CourtHelperBackend -StartupType Automatic/);
  assert.match(backend, /Remove-Item Env:DATABASE_URL/);
  assert.match(iss, /prepare-upgrade\.ps1/);
  assert.match(iss, /Parameters:\s+"""\{app\}\\installer\\windows-local\\open-console\.mjs"""/);
});

test('runtime spreadsheet dependency survives production-only installation', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies.exceljs, '^4.4.0');
  assert.equal(Object.hasOwn(pkg.devDependencies, 'exceljs'), false);
});
