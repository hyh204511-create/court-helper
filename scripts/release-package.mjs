import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PRODUCTION_SERVER_URL,
  extensionIdFromPublicKey,
  makeProductionManifest,
  npmExecutionOptions,
  validateReleaseTree,
} from './release-config.mjs';
import { copyReleaseInput } from './release-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const releaseRoot = join(root, 'release');
const folderName = `court-helper-${version}-delivery`;
const outputDir = join(releaseRoot, folderName);
const zipPath = join(releaseRoot, `${folderName}.zip`);
const secretsDir = join(root, '.release-secrets');
const privateKeyPath = join(secretsDir, 'extension-key.pem');

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}

function safeRemove(target) {
  const resolved = resolve(target);
  const expectedParent = resolve(releaseRoot);
  if (dirname(resolved) !== expectedParent || !basename(resolved).startsWith('court-helper-')) {
    throw new Error(`Refusing to remove unexpected path: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

function extensionKey() {
  mkdirSync(secretsDir, { recursive: true });
  if (!existsSync(privateKeyPath)) {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    writeFileSync(privateKeyPath, privateKey, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  const privateKey = createPrivateKey(readFileSync(privateKeyPath));
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
  return { publicKey, extensionId: extensionIdFromPublicKey(publicKey) };
}

function copy(source, destination) {
  const from = join(root, source);
  const to = join(outputDir, destination ?? source);
  if (!existsSync(from)) throw new Error(`Missing release input: ${source}`);
  mkdirSync(dirname(to), { recursive: true });
  copyReleaseInput(from, to);
}

function walk(directory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...walk(absolute));
    else paths.push(relative(outputDir, absolute).replaceAll('\\', '/'));
  }
  return paths.sort();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function requireDeliveryDocuments() {
  const sources = readdirSync(join(root, 'docs', 'delivery')).filter((name) => /^0\d-.+\.md$/.test(name));
  for (const source of sources) {
    const stem = source.slice(0, -3);
    for (const path of [join('output', 'docs', `${stem}.docx`), join('output', 'pdf', `${stem}.pdf`)]) {
      if (!existsSync(join(root, path))) throw new Error(`Missing generated document: ${path}`);
    }
  }
}

function build() {
  const npm = npmExecutionOptions();
  run(npm.command, [...npm.prefixArgs, 'test']);
  run(npm.command, [...npm.prefixArgs, 'run', 'server:build']);
  run(npm.command, [...npm.prefixArgs, 'run', 'build']);
  requireDeliveryDocuments();

  mkdirSync(releaseRoot, { recursive: true });
  safeRemove(outputDir);
  safeRemove(zipPath);
  mkdirSync(outputDir, { recursive: true });

  const { publicKey, extensionId } = extensionKey();

  for (const source of ['package.json', 'package-lock.json', 'THIRD_PARTY_NOTICES.md']) copy(source);
  for (const source of ['server/Dockerfile', 'server/docker-compose.yml', 'server/tsconfig.json', 'server/.env.production.example']) copy(source);
  for (const source of ['server/src', 'server/migrations', 'server/deploy']) copy(source);

  copy('extension', 'extension');
  const sourceManifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
  const manifest = makeProductionManifest(sourceManifest, { version, publicKey });
  writeFileSync(join(outputDir, 'extension', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(outputDir, 'extension', 'config', 'release-target.js'),
    `export const RELEASE_SERVER_URL = '${PRODUCTION_SERVER_URL}';\n`,
  );

  for (const source of ['client/ocr-helper/install.ps1', 'client/ocr-helper/start.ps1', 'client/ocr-helper/health.ps1', 'client/ocr-helper/uninstall.ps1', 'client/ocr-helper/requirements.txt']) {
    copy(source, source.replace('client/', ''));
  }
  copy('scripts/login-helper-server.py', 'ocr-helper/login-helper-server.py');

  copy('docs/delivery', 'docs/markdown');
  copy('output/docs', 'docs/word');
  copy('output/pdf', 'docs/pdf');

  for (const script of readdirSync(join(outputDir, 'server', 'deploy', 'scripts'))) {
    if (script.endsWith('.sh')) chmodSync(join(outputDir, 'server', 'deploy', 'scripts', script), 0o755);
  }

  const preManifestPaths = walk(outputDir);
  const forbidden = validateReleaseTree(preManifestPaths);
  if (forbidden.length) throw new Error(`Forbidden release files: ${forbidden.join(', ')}`);

  const versionManifest = {
    product: 'court-helper',
    version,
    productionServerUrl: PRODUCTION_SERVER_URL,
    extensionId,
    builtAt: new Date().toISOString(),
    files: preManifestPaths,
  };
  writeFileSync(join(outputDir, 'VERSION.json'), `${JSON.stringify(versionManifest, null, 2)}\n`);

  const checksumPaths = walk(outputDir);
  const checksums = checksumPaths.map((path) => `${sha256(join(outputDir, path))}  ${path}`).join('\n');
  writeFileSync(join(outputDir, 'checksums.sha256'), `${checksums}\n`);

  const finalForbidden = validateReleaseTree(walk(outputDir));
  if (finalForbidden.length) throw new Error(`Forbidden release files after packaging: ${finalForbidden.join(', ')}`);

  if (process.platform !== 'win32') throw new Error('ZIP packaging currently requires Windows tar.exe');
  run('tar.exe', ['-a', '-c', '-f', zipPath, folderName], { cwd: releaseRoot });
  if (!existsSync(zipPath) || statSync(zipPath).size === 0) throw new Error('Release ZIP was not created');
  console.log(JSON.stringify({ outputDir, zipPath, extensionId }, null, 2));
}

build();
