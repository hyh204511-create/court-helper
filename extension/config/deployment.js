import { RELEASE_SERVER_URL } from './release-target.js';

export const DEVELOPMENT_SERVER_URL = 'http://127.0.0.1:3000';
export const DEPLOYMENT_SERVER_URL = RELEASE_SERVER_URL;

export function normalizeServerUrl(value, allowedServerUrl = DEPLOYMENT_SERVER_URL) {
  if (typeof value !== 'string' || typeof allowedServerUrl !== 'string') return null;
  try {
    const allowed = new URL(allowedServerUrl);
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(allowed.protocol)) return null;
    if (parsed.origin !== allowed.origin) return null;
    if (parsed.username || parsed.password) return null;
    if ((parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.hash) return null;
    return allowed.origin;
  } catch {
    return null;
  }
}
