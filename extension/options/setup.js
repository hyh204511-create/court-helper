import {
  DEFAULT_EXTENSION_SERVER_URL,
  EXTENSION_PAIRING_REQUEST,
  EXTENSION_PAIRING_STATUS_REQUEST,
  normalizeExtensionServerUrl,
} from '../sw/extension-pairing.js';

function safeVerificationCode(value) {
  return typeof value === 'string' && /^\d{6}$/.test(value) ? value : '';
}

function statusMessage(status, code) {
  if (status === 'authorized') return '设备已授权。点击扩展图标可进入后台控制台。';
  if (status === 'awaiting_approval') return '等待管理员批准：请在后台核对下方六码。';
  if (status === 'not_configured') return '尚未配置后台服务地址。';
  if (status === 'rejected' && code === 'DEVICE_REVOKED') return '此设备授权已撤销，请再次请求后台授权。';
  if (status === 'expired') return '配对请求已过期，请重新请求后台授权。';
  return '授权状态暂不可用，请稍后重试。';
}

export function createSetupController({
  document = globalThis.document,
  chromeApi = globalThis.chrome,
} = {}) {
  const form = document?.querySelector('#setup-form');
  const input = document?.querySelector('#server-url');
  const submit = document?.querySelector('#request-authorization');
  const code = document?.querySelector('#verification-code');
  const status = document?.querySelector('#authorization-status');
  let destroyed = false;

  function render(result = {}) {
    if (destroyed) return;
    const verificationCode = safeVerificationCode(result.verificationCode);
    if (code) {
      code.textContent = verificationCode;
      code.hidden = verificationCode === '';
    }
    if (status) {
      status.textContent = statusMessage(result.status, result.code);
      status.dataset.state = result.status || 'unavailable';
    }
  }

  async function send(message) {
    try {
      return await chromeApi?.runtime?.sendMessage?.(message);
    } catch {
      return { ok: false, status: 'unavailable', code: 'PAIRING_UNAVAILABLE' };
    }
  }

  async function initialize() {
    const storage = chromeApi?.storage?.local;
    let stored = {};
    try {
      stored = await storage?.get?.(['serverUrl']) ?? {};
    } catch {
      stored = {};
    }
    if (input) input.value = normalizeExtensionServerUrl(stored.serverUrl) ?? DEFAULT_EXTENSION_SERVER_URL;
    const result = await send({ type: EXTENSION_PAIRING_STATUS_REQUEST });
    render(result?.ok === false ? { status: 'unavailable', code: result.code } : result);
    return result;
  }

  async function requestAuthorization(event) {
    event?.preventDefault?.();
    const normalized = normalizeExtensionServerUrl(input?.value);
    if (!normalized) {
      if (code) { code.textContent = ''; code.hidden = true; }
      if (status) {
        status.textContent = `仅支持 ${DEFAULT_EXTENSION_SERVER_URL}`;
        status.dataset.state = 'invalid';
      }
      input?.setAttribute('aria-invalid', 'true');
      return { ok: false, status: 'invalid', code: 'INVALID_SERVER_URL' };
    }
    input?.removeAttribute('aria-invalid');
    if (input) input.value = normalized;
    if (submit) submit.disabled = true;
    const result = await send({ type: EXTENSION_PAIRING_REQUEST, serverUrl: normalized });
    render(result?.ok === false ? { status: 'unavailable', code: result.code } : result);
    if (submit) submit.disabled = false;
    return result;
  }

  form?.addEventListener('submit', requestAuthorization);

  return {
    init: initialize,
    requestAuthorization,
    destroy() {
      destroyed = true;
      form?.removeEventListener('submit', requestAuthorization);
      if (code) code.textContent = '';
    },
  };
}

if (globalThis.document && globalThis.chrome) {
  const start = () => {
    const controller = createSetupController();
    void controller.init();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
