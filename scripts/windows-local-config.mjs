import { createHash } from 'node:crypto';

export const LOCAL_PORTS = Object.freeze({ server: 3000, postgres: 55432, ocr: 8765 });
export const LOCAL_DATABASE_NAME = 'courthelper';
export const LOCAL_ADMIN_ORIGIN = 'http://127.0.0.1:3000';
export const LOCAL_HOST_PERMISSIONS = Object.freeze([
  'https://zxfw.court.gov.cn/*',
  'http://127.0.0.1:8765/*',
  `${LOCAL_ADMIN_ORIGIN}/*`,
]);

export function makeLocalManifest(source, { version, publicKey }) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version ?? ''))) throw new Error('Invalid version');
  if (typeof publicKey !== 'string' || publicKey.trim() === '') throw new Error('Missing extension public key');
  return { ...source, version, key: publicKey.trim(), host_permissions: [...LOCAL_HOST_PERMISSIONS] };
}

export function localInstallerName(version) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version ?? ''))) throw new Error('Invalid version');
  return `court-helper-${version}-windows-x64-setup.exe`;
}

export function makeLocalEnvironment({ adminPassword, masterKey, extensionId = 'LOCAL_EXTENSION_ID', databasePassword = 'REPLACE_AT_INSTALL' }) {
  if (!adminPassword || !masterKey) throw new Error('adminPassword and masterKey are required');
  return {
    PORT: String(LOCAL_PORTS.server),
    DATABASE_URL: `postgres://courthelper:${databasePassword}@127.0.0.1:${LOCAL_PORTS.postgres}/${LOCAL_DATABASE_NAME}`,
    CREDENTIAL_MASTER_KEY: String(masterKey),
    ADMIN_INITIAL_PASSWORD: String(adminPassword),
    CORS_ADMIN_ORIGINS: LOCAL_ADMIN_ORIGIN,
    CORS_EXTENSION_ORIGINS: `chrome-extension://${extensionId}`,
    LOCAL_STORAGE_DIR: '%PROGRAMDATA%\\CourtHelper\\storage',
    OBJECT_STORAGE_ENDPOINT: 'local://private',
    OBJECT_STORAGE_BUCKET: 'local',
    LOCAL_LOGIN_HELPER_AUTOSTART: 'true',
    LOCAL_LOGIN_HELPER_COMMAND: '%PROGRAMFILES%\\CourtHelper\\runtime\\ocr\\court-helper-ocr.exe',
    LOCAL_WINDOWS_DELIVERY: 'true',
    LOCAL_EXTENSION_DIR: '%PROGRAMFILES%\\CourtHelper\\extension',
  };
}

const FORBIDDEN = [
  /(^|[\\/])(?:\.env(?:\.|$)|service\.env$)/i,
  /(^|[\\/])(?:accounts\.txt|.*(?:privkey|extension-key).*\.pem)$/i,
  /(^|[\\/])\.release-secrets([\\/]|$)/i,
  /(^|[\\/])(?:tests?|logs?)([\\/]|$)/i,
  /\.(?:xlsx|xlsm|png|jpe?g|gif)$/i,
];

export function validateLocalReleaseTree(paths) {
  return paths.filter((path) => FORBIDDEN.some((pattern) => pattern.test(String(path).replaceAll('\\', '/'))));
}

export function checksumForManifest(content) {
  return createHash('sha256').update(content).digest('hex');
}
