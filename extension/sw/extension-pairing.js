import { createRemoteClient } from '../data/remote-client.js';

export const EXTENSION_PAIRING_ALARM_NAME = 'extension-device-pairing';
export const EXTENSION_PAIRING_ALARM_PERIOD_MINUTES = 1;
export const EXTENSION_PAIRING_STATUS_REQUEST = 'EXTENSION_PAIRING_STATUS_REQUEST';
export const EXTENSION_PAIRING_REQUEST = 'EXTENSION_PAIRING_REQUEST';
export const DEFAULT_EXTENSION_SERVER_URL = 'http://127.0.0.1:3000';

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

export function normalizeExtensionServerUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== 'http:'
      || parsed.hostname !== '127.0.0.1'
      || parsed.port !== '3000'
      || parsed.username
      || parsed.password
      || (parsed.pathname !== '/' && parsed.pathname !== '')
      || parsed.search
      || parsed.hash
    ) return null;
    return DEFAULT_EXTENSION_SERVER_URL;
  } catch {
    return null;
  }
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
  let inFlightPromise = null;
  let lastStatus = safeStatus('not_configured');
  let configurationGeneration = 0;
  let storageMutation = Promise.resolve();
  let activeRequestController = null;

  function isCurrentGeneration(generation) {
    return generation === configurationGeneration;
  }

  function staleResult() {
    return { status: lastStatus.status, code: 'CONFIG_CHANGED' };
  }

  function invalidateConfiguration() {
    configurationGeneration += 1;
    activeRequestController?.abort('configuration changed');
    activeRequestController = null;
    stop();
    return configurationGeneration;
  }

  function queueStorageMutation(mutation) {
    const queued = storageMutation.then(mutation, mutation);
    storageMutation = queued.catch(() => {});
    return queued;
  }

  function setStorage(values, generation = null) {
    return queueStorageMutation(async () => {
      if (generation !== null && !isCurrentGeneration(generation)) return false;
      await chromeApi?.storage?.local?.set?.(values);
      return true;
    });
  }

  function removeStorage(keys, generation = null) {
    return queueStorageMutation(async () => {
      if (generation !== null && !isCurrentGeneration(generation)) return false;
      await chromeApi?.storage?.local?.remove?.(keys);
      return true;
    });
  }

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

  async function clearPairing(generation = null) {
    return removeStorage(PAIRING_STATE_KEYS, generation);
  }

  async function clearPendingPairing(generation = null) {
    return removeStorage(PENDING_PAIRING_KEYS, generation);
  }

  async function configureServerUrl(serverUrl) {
    const normalized = normalizeExtensionServerUrl(serverUrl);
    if (!normalized) {
      lastStatus = safeStatus('rejected', 'INVALID_SERVER_URL');
      return null;
    }
    const runtime = await config();
    const current = normalizeExtensionServerUrl(runtime?.serverUrl) ?? trim(runtime?.serverUrl);
    if (current === normalized) return runtime;

    const generation = invalidateConfiguration();
    lastStatus = safeStatus('stopped');
    await setStorage({
      serverUrl: normalized,
      token: null,
      expiresAt: null,
      remoteLoginEnabled: false,
      legacyRemoteLoginEnabled: false,
      browserCommandDeviceId: null,
      extensionDeviceId: null,
      extensionPairingId: null,
      extensionPairingSecret: null,
      extensionPairingVerificationCode: null,
      extensionPairingExpiresAt: null,
      extensionPairingBlockedCode: null,
    }, generation);
    await removeStorage([
      ...AUTHORIZATION_STATE_KEYS,
      ...PAIRING_STATE_KEYS,
      'extensionDeviceId',
      'extensionPairingBlockedCode',
    ], generation);
    return config();
  }

  async function blockRevokedDevice(generation = configurationGeneration) {
    if (!await clearPendingPairing(generation)) return staleResult();
    if (!await setStorage({ extensionPairingBlockedCode: 'DEVICE_REVOKED' }, generation)) return staleResult();
    stop();
    lastStatus = safeStatus('rejected', 'DEVICE_REVOKED');
    return { ...lastStatus };
  }

  async function disable() {
    const generation = invalidateConfiguration();
    await setStorage({
      token: null,
      expiresAt: null,
      remoteLoginEnabled: false,
      legacyRemoteLoginEnabled: false,
      browserCommandDeviceId: null,
      extensionPairingId: null,
      extensionPairingSecret: null,
      extensionPairingVerificationCode: null,
      extensionPairingExpiresAt: null,
    }, generation);
    await removeStorage([...AUTHORIZATION_STATE_KEYS, ...PAIRING_STATE_KEYS], generation);
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

  async function createPairing(runtime, generation = configurationGeneration) {
    if (!isCurrentGeneration(generation)) return staleResult();
    const deviceId = runtime.deviceId || randomUuid?.();
    const exchangeSecret = runtime.exchangeSecret || randomSecret();
    if (!/^[0-9a-f-]{36}$/i.test(deviceId || '') || !/^[A-Za-z0-9_-]{43,128}$/.test(exchangeSecret || '')) {
      if (!isCurrentGeneration(generation)) return staleResult();
      lastStatus = safeStatus('rejected', 'PAIRING_CRYPTO_UNAVAILABLE');
      return { ...lastStatus };
    }
    const client = createRemoteClient({ baseUrl: runtime.serverUrl, fetchImpl });
    if (!client) {
      if (!isCurrentGeneration(generation)) return staleResult();
      lastStatus = safeStatus('not_configured');
      return { ...lastStatus };
    }
    const controller = new AbortController();
    activeRequestController = controller;
    try {
      const response = await client.request('/auth/extension-pairings', {
        method: 'POST',
        body: { deviceId, label, exchangeSecret },
        signal: controller.signal,
      });
      if (!isCurrentGeneration(generation)) return staleResult();
      const pairingId = trim(response?.pairing?.id);
      const verificationCode = trim(response?.pairing?.verificationCode);
      const expiresAt = typeof response?.pairing?.expiresAt === 'string' ? response.pairing.expiresAt : null;
      if (!/^[0-9a-f-]{36}$/i.test(pairingId) || !/^\d{6}$/.test(verificationCode)) {
        if (!isCurrentGeneration(generation)) return staleResult();
        lastStatus = safeStatus('rejected', 'PAIRING_RESPONSE_INVALID');
        return { ...lastStatus };
      }
      if (!await setStorage({
        extensionDeviceId: deviceId,
        extensionPairingId: pairingId,
        extensionPairingSecret: exchangeSecret,
        extensionPairingVerificationCode: verificationCode,
        extensionPairingExpiresAt: expiresAt,
      }, generation)) return staleResult();
      lastStatus = safeStatus('awaiting_approval', null, verificationCode, expiresAt);
      return { ...lastStatus };
    } catch (error) {
      if (!isCurrentGeneration(generation)) return staleResult();
      const code = pairingErrorCode(error);
      if (code === 'DEVICE_REVOKED') return blockRevokedDevice(generation);
      lastStatus = safeStatus('unavailable', code);
      return { ...lastStatus };
    } finally {
      if (activeRequestController === controller) activeRequestController = null;
    }
  }

  async function pollOnce() {
    if (inFlightPromise) return inFlightPromise;
    const generation = configurationGeneration;
    const poll = (async () => {
      const runtime = await config();
      if (!isCurrentGeneration(generation)) return staleResult();
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
      if (!runtime.pairingId || !runtime.exchangeSecret) return createPairing(runtime, generation);
      const client = createRemoteClient({ baseUrl: runtime.serverUrl, fetchImpl });
      if (!client) {
        lastStatus = safeStatus('not_configured');
        return { ...lastStatus };
      }
      const controller = new AbortController();
      activeRequestController = controller;
      try {
        const response = await client.request(`/auth/extension-pairings/${encodeURIComponent(runtime.pairingId)}/exchange`, {
          method: 'POST',
          body: { exchangeSecret: runtime.exchangeSecret },
          signal: controller.signal,
        });
        if (!isCurrentGeneration(generation)) return staleResult();
        const token = trim(response?.token);
        const expiresAt = Date.parse(response?.expiresAt);
        if (!token || !Number.isFinite(expiresAt) || expiresAt <= now()) {
          if (!isCurrentGeneration(generation)) return staleResult();
          lastStatus = safeStatus('rejected', 'PAIRING_RESPONSE_INVALID');
          return { ...lastStatus };
        }
        if (!await setStorage({
          token,
          expiresAt,
          remoteLoginEnabled: true,
          legacyRemoteLoginEnabled: false,
          browserCommandDeviceId: runtime.deviceId,
        }, generation)) return staleResult();
        if (!await clearPairing(generation)) return staleResult();
        if (!isCurrentGeneration(generation)) return staleResult();
        lastStatus = safeStatus('authorized', null, null, new Date(expiresAt).toISOString());
        try { await onAuthorized?.(); } catch { /* polling wake-up is best effort */ }
        return { ...lastStatus };
      } catch (error) {
        if (!isCurrentGeneration(generation)) return staleResult();
        const code = pairingErrorCode(error);
        if (code === 'PAIRING_PENDING') {
          lastStatus = safeStatus('awaiting_approval', null, runtime.verificationCode || null, runtime.pairingExpiresAt);
          return { ...lastStatus };
        }
        if (code === 'DEVICE_REVOKED') return blockRevokedDevice(generation);
        if (code === 'PAIRING_EXPIRED' || code === 'PAIRING_CONSUMED') {
          if (!await clearPendingPairing(generation)) return staleResult();
          lastStatus = safeStatus('rejected', code);
          return { ...lastStatus };
        }
        lastStatus = safeStatus('unavailable', code);
        return { ...lastStatus };
      } finally {
        if (activeRequestController === controller) activeRequestController = null;
      }
    })();
    inFlightPromise = poll;
    try {
      return await poll;
    } finally {
      if (inFlightPromise === poll) inFlightPromise = null;
    }
  }

  async function waitForInFlight() {
    const active = inFlightPromise;
    if (!active) return;
    try {
      await active;
    } catch {
      // The following explicit pairing attempt will return its own stable status.
    }
  }

  async function start({ immediate = true } = {}) {
    const generation = configurationGeneration;
    const runtime = await config();
    if (!isCurrentGeneration(generation)) return staleResult();
    if (!runtime) {
      lastStatus = safeStatus('not_configured');
      return { ...lastStatus };
    }
    if (intervalId === null) intervalId = scheduler.setInterval?.(() => { pollOnce().catch(() => {}); }, intervalMs);
    ensureAlarm();
    if (immediate) return pollOnce();
    if (!runtime.pairingId || !runtime.exchangeSecret) return pollOnce();
    lastStatus = safeStatus('awaiting_approval', null, runtime.verificationCode || null, runtime.pairingExpiresAt);
    return { ...lastStatus };
  }

  async function resume() {
    const generation = configurationGeneration;
    const runtime = await config();
    if (!isCurrentGeneration(generation)) return staleResult();
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
    if (!runtime.pairingId || !runtime.exchangeSecret) {
      lastStatus = safeStatus('stopped');
      return { ...lastStatus };
    }
    if (intervalId === null) intervalId = scheduler.setInterval?.(() => { pollOnce().catch(() => {}); }, intervalMs);
    ensureAlarm();
    return pollOnce();
  }

  async function requestPairing({ serverUrl } = {}) {
    const runtime = serverUrl === undefined ? await config() : await configureServerUrl(serverUrl);
    if (!runtime) return { ...lastStatus };
    const generation = configurationGeneration;
    if (!await clearPendingPairing(generation)) return staleResult();
    if (runtime?.blockedCode === 'DEVICE_REVOKED') {
      if (!await removeStorage(['extensionDeviceId', 'extensionPairingBlockedCode'], generation)) return staleResult();
    }
    await waitForInFlight();
    if (!isCurrentGeneration(generation)) return staleResult();
    return start({ immediate: true });
  }

  return {
    start,
    resume,
    stop,
    pollOnce,
    requestPairing,
    disable,
    ensureAlarm,
    getStatus: () => ({ ...lastStatus }),
    isRunning: () => intervalId !== null,
  };
}
