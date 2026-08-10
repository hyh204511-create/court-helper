import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extensionIdFromPublicKey, npmExecutionOptions } from './release-config.mjs';
import { localInstallerName, makeLocalManifest, validateLocalReleaseTree } from './windows-local-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const releaseRoot = join(root, 'release');
const staging = join(releaseRoot, `court-helper-${version}-windows-local`);
const secrets = join(root, '.release-secrets', 'extension-key.pem');
const stagingOnly = process.argv.includes('--staging-only');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [relative(staging, path).replaceAll('\\', '/')];
  }).sort();
}
function copy(source, destination = source) {
  const from = join(root, source); const to = join(staging, destination);
  if (!existsSync(from)) throw new Error(`Missing release input: ${source}`);
  copyTree(from, to);
}
function copyTree(from, to) {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) copyTree(join(from, entry), join(to, entry));
    return;
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
function extensionIdentity() {
  mkdirSync(dirname(secrets), { recursive: true });
  if (!existsSync(secrets)) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    writeFileSync(secrets, privateKey, { flag: 'wx' });
  }
  const publicKey = createPublicKey(createPrivateKey(readFileSync(secrets))).export({ type: 'spki', format: 'der' }).toString('base64');
  return { publicKey, extensionId: extensionIdFromPublicKey(publicKey) };
}
function copyOptionalArtifact(envName, destination) {
  const source = process.env[envName];
  if (!source) return false;
  if (!existsSync(source)) throw new Error(`${envName} does not exist: ${source}`);
  copyTree(source, join(staging, destination));
  return true;
}
function copyPostgresRuntime() {
  const source = process.env.COURT_HELPER_POSTGRES_DIR;
  if (!source) return false;
  if (!existsSync(source)) throw new Error(`COURT_HELPER_POSTGRES_DIR does not exist: ${source}`);
  for (const directory of ['bin', 'lib', 'share']) {
    const from = join(source, directory);
    if (!existsSync(from)) throw new Error(`PostgreSQL runtime is missing ${directory}`);
    copyTree(from, join(staging, 'runtime/postgres', directory));
  }
  pruneDependencyTests(join(staging, 'runtime/postgres'));
  return true;
}
function pruneDependencyTests(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && /^(?:test|tests|__tests__)$/.test(entry.name)) {
      rmSync(path, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      pruneDependencyTests(path);
    } else if (/\.(?:test|spec)\.[cm]?[jt]s$/i.test(entry.name)) {
      rmSync(path, { force: true });
    }
  }
}

rmSync(staging, { recursive: true, force: true }); mkdirSync(staging, { recursive: true });
const npm = npmExecutionOptions();
function npmRun(script) { execFileSync(npm.command, [...npm.prefixArgs, 'run', script], { cwd: root, stdio: 'inherit' }); }
npmRun('server:build');
npmRun('build');
copy('server/dist', 'server/dist'); copy('server/migrations', 'server/migrations'); copy('extension', 'extension');
copy('package.json', 'server/package.json'); copy('package-lock.json', 'server/package-lock.json');
execFileSync(npm.command, [...npm.prefixArgs, 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: join(staging, 'server'), stdio: 'inherit' });
pruneDependencyTests(join(staging, 'server/node_modules'));
copy('THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md');
const identity = extensionIdentity();
const manifest = JSON.parse(readFileSync(join(staging, 'extension/manifest.json'), 'utf8'));
writeFileSync(join(staging, 'extension/manifest.json'), `${JSON.stringify(makeLocalManifest(manifest, { version, publicKey: identity.publicKey }), null, 2)}\n`);
writeFileSync(join(staging, 'extension/config/release-target.js'), "export const RELEASE_SERVER_URL = 'http://127.0.0.1:3000';\n");
copy('installer/windows-local', 'installer/windows-local');
const localGuide = readdirSync(join(root, 'docs/delivery')).find((name) => name.startsWith('06-') && name.endsWith('.md'));
if (!localGuide) throw new Error('Missing Windows local delivery guide');
copy(join('docs/delivery', localGuide), join('docs', localGuide));
copyOptionalArtifact('COURT_HELPER_NODE_EXE', 'runtime/node.exe');
const hasWinSw = copyOptionalArtifact('COURT_HELPER_WINSW_EXE', 'runtime/CourtHelperBackend.exe');
const hasPostgres = copyPostgresRuntime();
const hasOcr = copyOptionalArtifact('COURT_HELPER_OCR_DIR', 'runtime/ocr');
rmSync(join(staging, 'runtime/ocr/_internal/ddddocr/logo.png'), { force: true });
if (!stagingOnly && (!process.env.COURT_HELPER_NODE_EXE || !hasWinSw || !hasPostgres || !hasOcr)) {
  throw new Error('Windows local release requires COURT_HELPER_NODE_EXE, COURT_HELPER_WINSW_EXE, COURT_HELPER_POSTGRES_DIR and COURT_HELPER_OCR_DIR; use --staging-only for contract-only builds');
}

const paths = walk(staging);
const forbidden = validateLocalReleaseTree(paths);
if (forbidden.length) throw new Error(`Forbidden local release files: ${forbidden.join(', ')}`);
const versionManifest = { product: 'court-helper', target: 'windows-local', version, extensionId: identity.extensionId, ports: { server: 3000, postgres: 55432, ocr: 8765 }, files: paths };
writeFileSync(join(staging, 'VERSION.json'), `${JSON.stringify(versionManifest, null, 2)}\n`);
const checksums = walk(staging).map((path) => `${createHash('sha256').update(readFileSync(join(staging, path))).digest('hex')}  ${path}`).join('\n');
writeFileSync(join(staging, 'checksums.sha256'), `${checksums}\n`);

if (!stagingOnly) {
  const iscc = process.env.ISCC_EXE || 'ISCC.exe';
  execFileSync(iscc, [`/DAppVersion=${version}`, `/DStagingDir=${staging}`, `/DOutputDir=${releaseRoot}`, join(staging, 'installer/windows-local/court-helper.iss')], { cwd: root, stdio: 'inherit' });
  const installerPath = join(releaseRoot, localInstallerName(version));
  if (!existsSync(installerPath)) throw new Error('Inno Setup did not create the expected installer');
  writeFileSync(`${installerPath}.sha256`, `${createHash('sha256').update(readFileSync(installerPath)).digest('hex')}  ${localInstallerName(version)}\n`);
}
console.log(JSON.stringify({ staging, installer: join(releaseRoot, localInstallerName(version)), extensionId: identity.extensionId }, null, 2));
