import { createRemoteClient } from '../data/remote-client.js';

export const EXTENSION_PAIRING_ALARM_NAME = 'extension-device-pairing';
export const EXTENSION_PAIRING_ALARM_PERIOD_MINUTES = 1;
export const EXTENSION_PAIRING_STATUS_REQUEST = 'EXTENSION_PAIRING_STATUS_REQUEST';
export const EXTENSION_PAIRING_REQUEST = 'EXTENSION_PAIRING_REQUEST';

const PAIRING_KEYS = Object.freeze([
  'serverUrl',
  'token',
  'expiresAt',
  'remoteLoginEnabled',
  'extensionDeviceId',
  'extensionPairingId',
  'extensionPairingSecret',
  'extensionPairingVerificationCode',
  'extensionPairingExpiresAt',
  'extensionPairingBlockedCode',
]);
const PENDING_PAIRING_KEYS = Object.freeze([
  'extensionPairingId',
  'extensionPairingSecret',
  'extensionPairingVerificationCode',
  'extensionPairingExpiresAt',
]);
const PAIRING_STATE_KEYS = Object.freeze([
  'extensionPairingId',
  'extensionPairingSecret',
  'extensionPairingVerificationCode',
  'extensionPairingExpiresAt',
]);
const AUTHORIZATION_STATE_KEYS = Object.freeze([
  'token',
  'expiresAt',
  'browserCommandDeviceId',
]);
const POLL_INTERVAL_MS = 3000;

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeStatus(status, code = null, verificationCode = null, expiresAt = null) {
  return { status, code, verificationCode, expiresAt };
}

function newSecret() {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('CRYPTO_UNAVAILABLE');
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  if (typeof globalThis.btoa === 'function') {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globalThis.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  }
  const BufferImpl = globalThis.Buffer;
  if (typeof BufferImpl?.from === 'function') return BufferImpl.from(bytes).toString('base64url');
  throw new Error('CRYPTO_UNAVAILABLE');
}

function pairingErrorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'PAIRING_UNAVAILABLE';
}

export function createExtensionPairer({
  chromeApi = globalThis.chrome,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  scheduler = globalThis,
  now = Date.now,
  intervalMs = POLL_INTERVAL_MS,
  randomUuid = () => globalThis.crypto?.randomUUID?.(),
  randomSecret = newSecret,
  label = 'Edge extension',
  onAuthorized = null,
} = {}) {
  let intervalId = null;
  let inFlight = false;
  let lastStatus = safeStatus('not_configured');

  async function config() {
    if (!chromeApi?.storage?.local?.get) return null;
    const stored = await chromeApi.storage.local.get(PAIRING_KEYS);
    const serverUrl = trim(stored?.serverUrl);
    if (!serverUrl) return null;
    return {
      serverUrl,
      token: trim(stored?.token),
      expiresAt: Number(stored?.expiresAt) || 0,
      deviceId: trim(stored?.extensionDeviceId),
      pairingId: trim(stored?.extensionPairingId),
      exchangeSecret: trim(stored?.extensionPairingSecret),
      verificationCode: trim(stored?.extensionPairingVerificationCode),
      pairingExpiresAt: typeof stored?.extensionPairingExpiresAt === 'string' ? stored.extensionPairingExpiresAt : null,
      blockedCode: trim(stored?.extensionPairingBlockedCode),
    };
  }

  async function clearPairing() {
    await chromeApi?.storage?.local?.remove?.(PAIRING_STATE_KEYS);
  }

  async function clearPendingPairing() {
    await chromeApi?.storage?.local?.remove?.(PENDING_PAIRING_KEYS);
  }

  async function blockRevokedDevice() {
    await clearPendingPairing();
    await chromeApi?.storage?.local?.set?.({ extensionPairingBlockedCode: 'DEVICE_REVOKED' });
    stop();
    lastStatus = safeStatus('rejected', 'DEVICE_REVOKED');
    return { ...lastStatus };
  }

  async function disable() {
    stop();
    await chromeApi?.storage?.local?.set?.({
      remoteLoginEnabled: false,
      legacyRemoteLoginEnabled: false,
    });
    await chromeApi?.storage?.local?.remove?.([...AUTHORIZATION_STATE_KEYS, ...PAIRING_STATE_KEYS]);
    lastStatus = safeStatus('stopped');
    return { ok: true };
  }

  function ensureAlarm() {
    chromeApi?.alarms?.create?.(EXTENSION_PAIRING_ALARM_NAME, {
      periodInMinutes: EXTENSION_PAIRING_ALARM_PERIOD_MINUTES,
    });
  }

  function stop() {
    if (intervalId !== null) scheduler.clearInterval?.(intervalId);
    intervalId = null;
    chromeApi?.alarms?.clear?.(EXTENSION_PAIRING_ALARM_NAME);
  }

  async function createPairing(runtime) {
    const deviceId = runtime.deviceId || randomUuid?.();
    const exchangeSecret = runtime.exchangeSecret || randomSecret();
    if (!/^[0-9a-f-]{36}$/i.test(deviceId || '') || !/^[A-Za-z0-9_-]{43,128}$/.test(exchangeSecret || '')) {
      lastStatus = safeStatus('rejected', 'PAIRING_CRYPTO_UNAVAILABLE');
      return { ...lastStatus };
    }
    const client = createRemoteClient({ baseUrl: runtime.serverUrl, fetchImpl });
    if (!client) {
      lastStatus = safeStatus('not_configured');
      return { ...lastStatus };
    }
    try {
      const response = await client.request('/auth/extension-pairings', {
        method: 'POST',
        body: { deviceId, label, exchangeSecret },
      });
      const pairingId = trim(response?.pairing?.id);
      const verificationCode = trim(response?.pairing?.verificationCode);
      const expiresAt = typeof response?.pairing?.expiresAt === 'string' ? response.pairing.expiresAt : null;
      if (!/^[0-9a-f-]{36}$/i.test(pairingId) || !/^\d{6}$/.test(verificationCode)) {
        lastStatus = safeStatus('rejected', 'PAIRING_RESPONSE_INVALID');
        return { ...lastStatus };
      }
      await chromeApi.storage.local.set({
        extensionDeviceId: deviceId,
        extensionPairingId: pairingId,
        extensionPairingSecret: exchangeSecret,
        extensionPairingVerificationCode: verificationCode,
        extensionPairingExpiresAt: expiresAt,
      });
      lastStatus = safeStatus('awaiting_approval', null, verificationCode, expiresAt);
      return { ...lastStatus };
    } catch (error) {
      const code = pairingErrorCode(error);
      if (code === 'DEVICE_REVOKED') return blockRevokedDevice();
      lastStatus = safeStatus('unavailable', code);
      return { ...lastStatus };
    }
  }

  async function pollOnce() {
    if (inFlight) return { status: lastStatus.status, skipped: 'IN_FLIGHT' };
    inFlight = true;
    try {
      const runtime = await config();
      if (!runtime) {
        lastStatus = safeStatus('not_configured');
        return { ...lastStatus };
      }
      if (runtime.blockedCode === 'DEVICE_REVOKED') {
        lastStatus = safeStatus('rejected', 'DEVICE_REVOKED');
        return { ...lastStatus };
      }
      if (runtime.token && runtime.expiresAt > now()) {
        lastStatus = safeStatus('authorized', null, null, new Date(runtime.expiresAt).toISOString());
        return { ...lastStatus };
      }
      if (!runtime.pairingId || !runtime.exchangeSecret) return createPairing(runtime);
      const client = createRemoteClient({ baseUrl: runtime.serverUrl, fetchImpl });
      if (!client) {
        lastStatus = safeStatus('not_configured');
        return { ...lastStatus };
      }
      try {
        const response = await client.request(`/auth/extension-pairings/${encodeURIComponent(runtime.pairingId)}/exchange`, {
          method: 'POST',
          body: { exchangeSecret: runtime.exchangeSecret },
        });
        const token = trim(response?.token);
        const expiresAt = Date.parse(response?.expiresAt);
        if (!token || !Number.isFinite(expiresAt) || expiresAt <= now()) {
          lastStatus = safeStatus('rejected', 'PAIRING_RESPONSE_INVALID');
          return { ...lastStatus };
        }
        await chromeApi.storage.local.set({
          token,
          expiresAt,
          remoteLoginEnabled: true,
          legacyRemoteLoginEnabled: false,
          browserCommandDeviceId: runtime.deviceId,
        });
        await clearPairing();
        lastStatus = safeStatus('authorized', null, null, new Date(expiresAt).toISOString());
        try { await onAuthorized?.(); } catch { /* polling wake-up is best effort */ }
        return { ...lastStatus };
      } catch (error) {
        const code = pairingErrorCode(error);
        if (code === 'PAIRING_PENDING') {
          lastStatus = safeStatus('awaiting_approval', null, runtime.verificationCode || null, runtime.pairingExpiresAt);
          return { ...lastStatus };
        }
        if (code === 'DEVICE_REVOKED') return blockRevokedDevice();
        if (code === 'PAIRING_EXPIRED' || code === 'PAIRING_CONSUMED') {
          await clearPendingPairing();
          lastStatus = safeStatus('rejected', code);
          return { ...lastStatus };
        }
        lastStatus = safeStatus('unavailable', code);
        return { ...lastStatus };
      }
    } finally {
      inFlight = false;
    }
  }

  async function start({ immediate = true } = {}) {
    const runtime = await config();
    if (!runtime) {
      lastStatus = safeStatus('not_configured');
      return { ...lastStatus };
    }
    if (intervalId === null) intervalId = scheduler.setInterval?.(() => { pollOnce().catch(() => {}); }, intervalMs);
    ensureAlarm();
    if (immediate) return pollOnce();
    if (!runtime.pairingId || !runtime.exchangeSecret) return createPairing(runtime);
    lastStatus = safeStatus('awaiting_approval', null, runtime.verificationCode || null, runtime.pairingExpiresAt);
    return { ...lastStatus };
  }

  async function requestPairing() {
    const runtime = await config();
    await clearPendingPairing();
    if (runtime?.blockedCode === 'DEVICE_REVOKED') {
      await chromeApi?.storage?.local?.remove?.(['extensionDeviceId', 'extensionPairingBlockedCode']);
    }
    return start({ immediate: true });
  }

  return {
    start,
    stop,
    pollOnce,
    requestPairing,
    disable,
    ensureAlarm,
    getStatus: () => ({ ...lastStatus }),
    isRunning: () => intervalId !== null,
  };
}
