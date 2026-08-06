import {
  DEFAULT_EXTENSION_SERVER_URL,
  normalizeExtensionServerUrl,
} from './extension-pairing.js';

export const BROWSER_CONTROL_PATH = '/admin/browser-control';

const ACTION_STATE_KEYS = Object.freeze([
  'serverUrl',
  'token',
  'expiresAt',
  'remoteLoginEnabled',
  'browserCommandDeviceId',
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function hasAuthorizedConsole(state, now = Date.now()) {
  return normalizeExtensionServerUrl(state?.serverUrl) === DEFAULT_EXTENSION_SERVER_URL
    && text(state?.token) !== ''
    && Number(state?.expiresAt) > now
    && state?.remoteLoginEnabled === true
    && text(state?.browserCommandDeviceId) !== '';
}

export async function routeExtensionAction({
  chromeApi = globalThis.chrome,
  now = Date.now,
} = {}) {
  let state = null;
  try {
    state = await chromeApi?.storage?.local?.get?.(ACTION_STATE_KEYS);
  } catch {
    state = null;
  }

  if (hasAuthorizedConsole(state, now())) {
    await chromeApi?.tabs?.create?.({
      url: `${DEFAULT_EXTENSION_SERVER_URL}${BROWSER_CONTROL_PATH}`,
    });
    return { destination: 'console' };
  }

  await chromeApi?.runtime?.openOptionsPage?.();
  return { destination: 'setup' };
}
