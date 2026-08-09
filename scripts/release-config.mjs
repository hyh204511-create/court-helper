import { createHash } from 'node:crypto';

export const PRODUCTION_SERVER_URL = 'https://court.hyhbrand.xyz';

export function npmExecutionOptions(platform = process.platform) {
  return platform === 'win32'
    ? { command: process.env.ComSpec || 'cmd.exe', prefixArgs: ['/d', '/s', '/c', 'npm.cmd'] }
    : { command: 'npm', prefixArgs: [] };
}
export const PRODUCTION_HOST_PERMISSIONS = Object.freeze([
  'https://zxfw.court.gov.cn/*',
  'http://127.0.0.1:8765/*',
  `${PRODUCTION_SERVER_URL}/*`,
]);

export function makeProductionManifest(source, { version, publicKey }) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Invalid release version');
  if (typeof publicKey !== 'string' || publicKey.trim() === '') throw new Error('Missing extension public key');
  return {
    ...source,
    version,
    key: publicKey.trim(),
    host_permissions: [...PRODUCTION_HOST_PERMISSIONS],
  };
}

export function extensionIdFromPublicKey(publicKey) {
  const digest = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest().subarray(0, 16);
  return [...digest].map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`).join('');
}

const FORBIDDEN_RELEASE_PATHS = [
  /(^|\/)\.env$/i,
  /(^|\/)(?:privkey|extension-key)[^/]*\.pem$/i,
  /(^|\/)\.release-secrets\//i,
  /(^|\/)tests?\//i,
  /(^|\/)node_modules\//i,
  /\.xlsx$/i,
  /\.(?:png|jpe?g)$/i,
];

export function validateReleaseTree(paths) {
  return paths.filter((value) => FORBIDDEN_RELEASE_PATHS.some((pattern) => pattern.test(String(value).replaceAll('\\', '/'))));
}
