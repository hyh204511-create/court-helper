export const ADMIN_STYLES = String.raw`
:root {
  --ink: #17232d;
  --ink-soft: #52616b;
  --paper: #f4f0e8;
  --paper-bright: #fffdf8;
  --line: #d9d2c4;
  --navy: #102a43;
  --navy-deep: #091c2e;
  --amber: #d39432;
  --amber-soft: #f3dfb5;
  --red: #a9423a;
  --green: #31745d;
  --shadow: 0 22px 60px rgba(9, 28, 46, .14);
  font-family: "Avenir Next", "Noto Sans SC", "PingFang SC", sans-serif;
  color: var(--ink);
  background: var(--paper);
}

* { box-sizing: border-box; }

html { min-width: 320px; background: var(--paper); }

body {
  min-height: 100vh;
  margin: 0;
  background:
    radial-gradient(circle at 10% 0%, rgba(211, 148, 50, .12), transparent 32rem),
    linear-gradient(135deg, #f4f0e8 0%, #eee9df 58%, #e6dfd2 100%);
}

a { color: inherit; }

button, input, select { font: inherit; }

button, .button {
  border: 1px solid transparent;
  border-radius: 999px;
  cursor: pointer;
  transition: transform .18s ease, box-shadow .18s ease, background .18s ease;
}

button:hover, .button:hover { transform: translateY(-1px); }

button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible {
  outline: 3px solid rgba(211, 148, 50, .45);
  outline-offset: 2px;
}

button:disabled { cursor: not-allowed; opacity: .48; transform: none; }

.shell { min-height: 100vh; display: grid; grid-template-columns: 246px minmax(0, 1fr); }

.sidebar {
  position: relative;
  padding: 30px 22px;
  color: #f9f5ec;
  background:
    linear-gradient(160deg, rgba(255,255,255,.05), transparent 34%),
    var(--navy-deep);
  overflow: hidden;
}

.sidebar::after {
  position: absolute;
  right: -72px;
  bottom: 56px;
  width: 180px;
  height: 180px;
  border: 1px solid rgba(211, 148, 50, .35);
  border-radius: 50%;
  content: "";
}

.brand { position: relative; z-index: 1; margin-bottom: 54px; }
.brand-mark { color: var(--amber); font-size: 11px; letter-spacing: .24em; text-transform: uppercase; }
.brand h1 { margin: 8px 0 0; font-family: Georgia, "Noto Serif SC", serif; font-size: 28px; font-weight: 500; letter-spacing: -.04em; }
.brand p { margin: 10px 0 0; color: rgba(249, 245, 236, .62); font-size: 12px; line-height: 1.7; }

.nav { position: relative; z-index: 1; display: grid; gap: 8px; }
.nav a { padding: 12px 14px; border-left: 2px solid transparent; color: rgba(249,245,236,.65); text-decoration: none; font-size: 13px; }
.nav a:hover, .nav a[aria-current="page"] { border-left-color: var(--amber); color: #fff; background: rgba(255,255,255,.06); }

.sidebar-foot { position: absolute; right: 22px; bottom: 26px; left: 22px; z-index: 1; color: rgba(249,245,236,.52); font-size: 11px; line-height: 1.6; }

.content { min-width: 0; padding: 26px clamp(20px, 4vw, 58px) 64px; }
.topbar { display: flex; justify-content: flex-end; min-height: 30px; }
.logout { padding: 7px 13px; border-color: var(--line); color: var(--ink-soft); background: rgba(255,253,248,.58); font-size: 12px; }
.logout:hover { border-color: var(--amber); color: var(--ink); box-shadow: 0 8px 18px rgba(9,28,46,.08); }

.page-head { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin: 18px 0 28px; }
.eyebrow { margin: 0 0 7px; color: var(--amber); font-size: 11px; font-weight: 700; letter-spacing: .2em; text-transform: uppercase; }
.page-head h2 { margin: 0; font-family: Georgia, "Noto Serif SC", serif; font-size: clamp(30px, 4vw, 48px); font-weight: 500; letter-spacing: -.055em; }
.page-head p { max-width: 430px; margin: 8px 0 0; color: var(--ink-soft); font-size: 13px; line-height: 1.7; }

.panel { border: 1px solid rgba(217,210,196,.9); border-radius: 18px; background: rgba(255,253,248,.78); box-shadow: var(--shadow); }
.panel + .panel { margin-top: 18px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 22px 16px; border-bottom: 1px solid var(--line); }
.panel-head h3 { margin: 0; font-family: Georgia, "Noto Serif SC", serif; font-size: 19px; font-weight: 500; }
.panel-head p { margin: 3px 0 0; color: var(--ink-soft); font-size: 12px; }
.panel-body { padding: 22px; }

.field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.field { display: grid; gap: 7px; }
.field label { color: var(--ink-soft); font-size: 12px; font-weight: 700; letter-spacing: .04em; }
.field input, .field select { width: 100%; padding: 11px 12px; border: 1px solid var(--line); border-radius: 10px; color: var(--ink); background: var(--paper-bright); }
.field input::placeholder { color: #9ca3a7; }
.form-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
.primary { padding: 11px 18px; color: #fff; background: var(--navy); box-shadow: 0 8px 18px rgba(16,42,67,.18); }
.primary:hover { background: #173c5d; }
.secondary { padding: 10px 16px; border-color: var(--line); color: var(--ink); background: transparent; }
.danger { padding: 9px 13px; color: #fff; background: var(--red); }
.message { min-height: 20px; margin: 14px 0 0; color: var(--red); font-size: 13px; }
.message.success { color: var(--green); }
.message.muted { color: var(--ink-soft); }

.table-wrap { overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th { padding: 12px 10px; color: var(--ink-soft); font-size: 11px; letter-spacing: .08em; text-align: left; text-transform: uppercase; white-space: nowrap; }
.data-table td { padding: 15px 10px; border-top: 1px solid rgba(217,210,196,.7); vertical-align: top; }
.data-table tbody tr:hover { background: rgba(243,223,181,.18); }
.data-table a { color: var(--navy); font-weight: 700; text-decoration-thickness: 1px; text-underline-offset: 3px; }
.subtle { color: var(--ink-soft); font-size: 12px; }
.muted { color: var(--ink-soft); }
.status-pill { display: inline-flex; align-items: center; padding: 4px 8px; border-radius: 999px; color: var(--navy); background: #dce8ee; font-size: 11px; white-space: nowrap; }
.status-pill.status-待人工 { color: #754c16; background: var(--amber-soft); }
.status-pill.status-已驳回 { color: #7e2f2a; background: #f2d7d2; }
.status-pill.status-立案成功, .status-pill.status-强执成功 { color: #245c49; background: #d9ebdf; }
.status-pill.status-login-pending { color: #754c16; background: var(--amber-soft); }
.status-pill.status-login-executing { color: #0f4c6d; background: #d8e8f2; }
.status-pill.status-login-success { color: #245c49; background: #d9ebdf; }
.status-pill.status-login-failed, .status-pill.status-login-expired { color: #7e2f2a; background: #f2d7d2; }
.row-actions { display: flex; flex-wrap: wrap; gap: 7px; }
.small-button { padding: 6px 9px; border-color: var(--line); color: var(--ink); background: transparent; font-size: 11px; }
.small-button:hover { border-color: var(--amber); background: var(--amber-soft); }

.filters { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 12px; align-items: end; }
.filter-actions { display: flex; gap: 8px; }
.filter-actions button { width: 100%; }
.case-status { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 36px; margin-bottom: 8px; color: var(--ink-soft); font-size: 12px; }
#case-retry { display: none; }

.detail-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.detail-item { padding: 15px; border: 1px solid var(--line); border-radius: 12px; background: rgba(244,240,232,.55); }
.detail-item dt { margin-bottom: 7px; color: var(--ink-soft); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
.detail-item dd { margin: 0; color: var(--ink); font-size: 14px; line-height: 1.55; overflow-wrap: anywhere; }
.reason { white-space: pre-wrap; }
.screenshot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 16px; }
.screenshot-card { overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: var(--paper-bright); }
.screenshot-card img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; background: #e7e2d9; }
.screenshot-meta { display: grid; gap: 7px; padding: 12px; }
.screenshot-meta strong { font-size: 13px; font-weight: 700; }
.screenshot-actions { display: flex; gap: 8px; }
.screenshot-actions a { flex: 1; padding: 8px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--navy); font-size: 11px; text-align: center; text-decoration: none; }
.screenshot-actions a:hover { border-color: var(--amber); background: var(--amber-soft); }

.login-page { display: grid; min-height: 100vh; place-items: center; padding: 24px; }
.login-card { display: grid; grid-template-columns: minmax(180px, .9fr) minmax(300px, 1.1fr); width: min(860px, 100%); overflow: hidden; border: 1px solid rgba(217,210,196,.9); border-radius: 24px; background: var(--paper-bright); box-shadow: var(--shadow); }
.login-art { position: relative; display: flex; min-height: 430px; flex-direction: column; justify-content: end; padding: 34px; color: #fff; background: linear-gradient(145deg, var(--navy-deep), var(--navy)); overflow: hidden; }
.login-art::before, .login-art::after { position: absolute; border: 1px solid rgba(211,148,50,.45); border-radius: 50%; content: ""; }
.login-art::before { top: -105px; right: -78px; width: 280px; height: 280px; }
.login-art::after { right: 24px; bottom: 38px; width: 110px; height: 110px; }
.login-art h1 { position: relative; z-index: 1; margin: 0; font-family: Georgia, "Noto Serif SC", serif; font-size: 38px; font-weight: 500; letter-spacing: -.06em; }
.login-art p { position: relative; z-index: 1; max-width: 220px; margin: 12px 0 0; color: rgba(255,255,255,.66); font-size: 13px; line-height: 1.8; }
.login-form { padding: clamp(30px, 6vw, 66px); }
.login-form h2 { margin: 0; font-family: Georgia, "Noto Serif SC", serif; font-size: 28px; font-weight: 500; }
.login-form > p { margin: 9px 0 30px; color: var(--ink-soft); font-size: 13px; line-height: 1.7; }
.login-form .field + .field { margin-top: 16px; }
.login-form .primary { width: 100%; margin-top: 10px; }

.forbidden { max-width: 620px; margin: 12vh auto; padding: 42px; text-align: center; }
.forbidden h2 { margin: 0; font-family: Georgia, "Noto Serif SC", serif; font-size: 48px; font-weight: 500; }
.forbidden p { color: var(--ink-soft); line-height: 1.8; }

@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; }
  .sidebar { padding: 20px; }
  .brand { margin-bottom: 20px; }
  .nav { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .sidebar-foot { display: none; }
  .content { padding-top: 14px; }
  .filters { grid-template-columns: repeat(3, minmax(120px, 1fr)); }
}

@media (max-width: 620px) {
  .nav { grid-template-columns: 1fr; }
  .field-grid, .detail-grid, .filters { grid-template-columns: 1fr; }
  .page-head { display: block; }
  .login-card { grid-template-columns: 1fr; }
  .login-art { min-height: 230px; }
  .login-art h1 { font-size: 32px; }
  .login-form { padding: 30px 24px; }
}
`;

export const ADMIN_SCRIPT = String.raw`
const API_BASE = '/api/v1';
let csrfToken = null;
let casePollTimer = null;
let caseCursor = null;
let nextCaseCursor = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

class ApiError extends Error {
  constructor(status, code, requestId) {
    super(code || 'REQUEST_FAILED');
    this.status = status;
    this.code = code || 'REQUEST_FAILED';
    this.requestId = requestId || '';
  }
}

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined && value !== null) node.textContent = String(value);
  return node;
}

function actionButton(label, action, id, className = 'small-button') {
  const button = element('button', label, className);
  button.type = 'button';
  button.dataset.action = action;
  if (id) button.dataset.id = id;
  return button;
}

function errorMessage(error) {
  if (error instanceof TypeError) return '服务器不可达，请重试';
  if (error instanceof ApiError) {
    if (error.status === 403) return '无权访问';
    if (error.status === 401 || error.code === 'ACCOUNT_DISABLED') return '账号或密码错误/账号不可用';
    if (error.requestId) return '请求失败，请提供请求编号 ' + error.requestId;
  }
  return '请求失败，请稍后重试';
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const method = String(options.method || 'GET').toUpperCase();
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (csrfToken && ['POST', 'PATCH', 'DELETE'].includes(method)) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(API_BASE + path, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  const body = await response.json().catch(() => null);
  if (response.status === 401) {
    window.location.assign('/admin/login');
    throw new ApiError(401, 'AUTH_REQUIRED', body?.error?.requestId);
  }
  if (!response.ok) {
    throw new ApiError(response.status, body?.error?.code, body?.error?.requestId);
  }
  return body;
}

function setMessage(node, message, kind = '') {
  if (!node) return;
  node.textContent = message || '';
  node.className = 'message' + (kind ? ' ' + kind : '');
}

function setFormBusy(form, busy) {
  if (!form) return;
  $$('button', form).forEach((button) => { button.disabled = busy; });
}

async function initLogin() {
  const form = $('#login-form');
  const message = $('[data-login-message]');
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    if (!username || !password) {
      setMessage(message, '请输入用户名和密码');
      return;
    }
    setFormBusy(form, true);
    try {
      const result = await fetch(API_BASE + '/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, clientType: 'admin_ui' }),
      });
      const body = await result.json().catch(() => null);
      if (!result.ok) throw new ApiError(result.status, body?.error?.code, body?.error?.requestId);
      csrfToken = body.csrfToken || null;
      form.reset();
      window.location.assign('/admin/cases');
    } catch (error) {
      setMessage(message, error instanceof TypeError ? '服务器不可达，请重试' : '账号或密码错误/账号不可用');
      setFormBusy(form, false);
    }
  });
}

async function loadSession() {
  const result = await api('/auth/me');
  csrfToken = result.csrfToken || null;
  return result;
}

function installLogout() {
  const button = $('#logout-button');
  if (!button) return;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
    }
    window.location.assign('/admin/login');
  });
}

function statusLabel(status) {
  return status === 'UNKNOWN' ? '待人工' : (status || '—');
}

function dateLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '—';
}

function renderStatus(value) {
  return element('span', statusLabel(value), 'status-pill status-' + statusLabel(value));
}

let platformLabels = new Map();
let loginCommandTimers = new Map();

function loginCommandStatusLabel(status) {
  if (status === 'pending') return '指令已创建';
  if (status === 'executing') return '执行中';
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'expired') return '已过期';
  return status || '—';
}

function loginCommandStatusKind(status) {
  return ['pending', 'executing', 'success', 'failed', 'expired'].includes(status) ? status : 'pending';
}

function renderLoginCommandPill(status, suffix = '') {
  const text = loginCommandStatusLabel(status) + (suffix ? ' ' + suffix : '');
  return element('span', text, 'status-pill status-login-' + loginCommandStatusKind(status));
}

function setRowLoginStatus(row, status, suffix = '') {
  const target = $('[data-login-command-status]', row);
  if (!target) return;
  clear(target);
  target.appendChild(renderLoginCommandPill(status, suffix));
}

function loginCommandResult(command) {
  if (!command) return '—';
  if (command.status === 'failed') {
    return [command.resultCode, command.resultMessage].filter(Boolean).join(' · ') || '失败';
  }
  if (command.status === 'success') return '成功';
  if (command.status === 'expired') return '已过期';
  return '—';
}

function stopLoginCommandPolling(commandId) {
  const timer = loginCommandTimers.get(commandId);
  if (timer) clearInterval(timer);
  loginCommandTimers.delete(commandId);
}

async function loadLoginCommands() {
  const target = $('#login-command-rows');
  if (!target) return [];
  const result = await api('/login-commands?limit=100');
  const commands = result.commands || [];
  clear(target);
  if (!commands.length) {
    const row = element('tr');
    const cell = element('td', '暂无登录指令');
    cell.colSpan = 5;
    row.appendChild(cell);
    target.appendChild(row);
    return commands;
  }
  commands.forEach((command) => {
    const row = element('tr');
    row.appendChild(element('td', command.accountLabel || '—'));
    const status = element('td');
    status.appendChild(renderLoginCommandPill(command.status));
    row.appendChild(status);
    row.appendChild(element('td', loginCommandResult(command)));
    row.appendChild(element('td', dateLabel(command.createdAt)));
    row.appendChild(element('td', dateLabel(command.updatedAt)));
    target.appendChild(row);
  });
  return commands;
}

function startLoginCommandPolling(row, commandId, button) {
  stopLoginCommandPolling(commandId);
  const startedAt = Date.now();
  const poll = async () => {
    try {
      const commands = await loadLoginCommands();
      const command = commands.find((item) => item.id === commandId);
      if (command) {
        const suffix = command.status === 'failed' && command.resultCode ? '(' + command.resultCode + ')' : '';
        setRowLoginStatus(row, command.status, suffix);
        if (['success', 'failed', 'expired'].includes(command.status)) {
          stopLoginCommandPolling(commandId);
          if (button) button.disabled = row.dataset.enabled !== 'true';
        }
      }
      if (Date.now() - startedAt >= 60000) {
        stopLoginCommandPolling(commandId);
        if (button) button.disabled = row.dataset.enabled !== 'true';
      }
    } catch {
      setRowLoginStatus(row, 'failed', '(REQUEST_FAILED)');
      stopLoginCommandPolling(commandId);
      if (button) button.disabled = row.dataset.enabled !== 'true';
    }
  };
  void poll();
  loginCommandTimers.set(commandId, setInterval(poll, 2000));
}

async function loadPlatformLabels() {
  try {
    const result = await api('/platform-accounts');
    const accounts = result.platformAccounts || [];
    platformLabels = new Map(accounts.map((account) => [account.id, account.label]));
    const select = $('#case-account');
    if (select) {
      const selected = select.value;
      while (select.options.length > 1) select.remove(1);
      accounts.forEach((account) => {
        const option = element('option', account.label);
        option.value = account.id;
        option.selected = account.id === selected;
        select.appendChild(option);
      });
    }
  } catch {
    platformLabels = new Map();
  }
}

function renderCaseRows(items) {
  const rows = $('#case-rows');
  if (!rows) return;
  clear(rows);
  if (!items.length) {
    const row = element('tr');
    const cell = element('td', '暂无案件');
    cell.colSpan = 8;
    row.appendChild(cell);
    rows.appendChild(row);
    return;
  }
  items.forEach((item) => {
    const row = element('tr');
    const numberCell = element('td');
    const link = element('a', item.caseNumber || item.clientUid || '未标注');
    link.href = '/admin/cases/' + encodeURIComponent(item.id);
    numberCell.appendChild(link);
    row.appendChild(numberCell);
    row.appendChild(element('td', item.plaintiff || '—'));
    row.appendChild(element('td', item.defendant || '—'));
    const statusCell = element('td');
    statusCell.appendChild(renderStatus(item.status));
    row.appendChild(statusCell);
    row.appendChild(element('td', item.kind === 'qz' ? '强执' : '立案'));
    row.appendChild(element('td', platformLabels.get(item.platformAccountId) || '—'));
    row.appendChild(element('td', item.rejectReason || '—'));
    row.appendChild(element('td', dateLabel(item.queryTime)));
    rows.appendChild(row);
  });
}

function caseQuery() {
  const params = new URLSearchParams();
  const fields = ['case-kind', 'case-status', 'case-account', 'case-human', 'case-from', 'case-to'];
  const names = ['kind', 'status', 'platformAccountId', 'needsHuman', 'from', 'to'];
  fields.forEach((field, index) => {
    const input = $('#' + field);
    if (input && input.value) params.set(names[index], input.value);
  });
  if (caseCursor !== null) params.set('cursor', caseCursor);
  params.set('limit', '50');
  return params.toString();
}

async function loadCases() {
  const status = $('[data-case-status]');
  const retry = $('#case-retry');
  try {
    const result = await api('/cases?' + caseQuery());
    renderCaseRows(result.cases || []);
    nextCaseCursor = result.nextCursor || null;
    const next = $('#case-next');
    if (next) next.style.display = nextCaseCursor === null ? 'none' : 'inline-flex';
    if (status) setMessage(status, '已更新 · ' + dateLabel(new Date().toISOString()), 'muted');
    if (retry) retry.style.display = 'none';
  } catch (error) {
    const rows = $('#case-rows');
    clear(rows);
    if (status) setMessage(status, '服务器不可达，请重试');
    if (retry) retry.style.display = 'inline-flex';
  }
}

function startCasePolling() {
  if (casePollTimer !== null) return;
  void loadCases();
  casePollTimer = setInterval(loadCases, 4000);
}

function stopCasePolling() {
  if (casePollTimer === null) return;
  clearInterval(casePollTimer);
  casePollTimer = null;
}

function initCases() {
  const filter = $('#case-filters');
  const retry = $('#case-retry');
  const next = $('#case-next');
  if (retry) retry.textContent = '手动重试';
  if (next) next.style.display = 'none';
  const today = new Date();
  const from = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fromField = $('#case-from');
  const toField = $('#case-to');
  if (fromField) fromField.value = from.toISOString().slice(0, 10);
  if (toField) toField.value = today.toISOString().slice(0, 10);
  if (filter) filter.addEventListener('submit', (event) => { event.preventDefault(); caseCursor = null; nextCaseCursor = null; void loadCases(); });
  if (retry) retry.addEventListener('click', () => { void loadCases(); });
  if (next) next.addEventListener('click', () => {
    if (nextCaseCursor === null) return;
    caseCursor = nextCaseCursor;
    void loadCases();
  });
  void loadPlatformLabels();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') startCasePolling();
    else stopCasePolling();
  });
  if (document.visibilityState === 'visible') startCasePolling();
}

async function loadUsers() {
  const target = $('#user-rows');
  const message = $('[data-user-message]');
  try {
    const result = await api('/users');
    const users = result.users || [];
    const enabledAdmins = users.filter((user) => user.role === 'admin' && user.enabled && !user.deletedAt).length;
    clear(target);
    users.forEach((user) => {
      const row = element('tr');
      row.dataset.id = user.id;
      row.dataset.enabled = String(user.enabled);
      const name = element('td');
      const input = document.createElement('input');
      input.value = user.username;
      input.dataset.field = 'username';
      input.setAttribute('aria-label', '用户名');
      name.appendChild(input);
      row.appendChild(name);
      const role = element('td');
      const select = document.createElement('select');
      select.dataset.field = 'role';
      ['admin', 'user'].forEach((value) => {
        const option = element('option', value === 'admin' ? '管理员' : '用户');
        option.value = value;
        option.selected = value === user.role;
        select.appendChild(option);
      });
      role.appendChild(select);
      row.appendChild(role);
      row.appendChild(element('td', user.enabled && !user.deletedAt ? '启用' : '停用'));
      const actions = element('td', null, 'row-actions');
      const locked = user.role === 'admin' && user.enabled && !user.deletedAt && enabledAdmins <= 1;
      const save = actionButton('保存', 'save-user', user.id);
      const toggle = actionButton(user.enabled ? '停用' : '启用', 'toggle-user', user.id);
      const reset = actionButton('重置密码', 'reset-user', user.id);
      const remove = actionButton('删除', 'delete-user', user.id, 'small-button danger');
      [save, select, toggle, remove].forEach((button) => { button.disabled = locked; });
      actions.append(save, toggle, reset, remove);
      row.appendChild(actions);
      target.appendChild(row);
    });
    setMessage(message, '已更新', 'success');
  } catch (error) {
    setMessage(message, errorMessage(error));
  }
}

function initUsers() {
  const form = $('#user-form');
  const list = $('#user-rows');
  if (form) form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormBusy(form, true);
    const message = $('[data-user-message]');
    try {
      await api('/users', {
        method: 'POST',
        body: JSON.stringify({
          username: $('#user-username').value.trim(),
          password: $('#user-password').value,
          role: $('#user-role').value,
        }),
      });
      form.reset();
      setMessage(message, '用户已创建', 'success');
      await loadUsers();
    } catch (error) {
      setMessage(message, errorMessage(error));
    } finally {
      setFormBusy(form, false);
    }
  });
  if (list) list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const row = button.closest('tr');
    const id = button.dataset.id;
    const message = $('[data-user-message]');
    try {
      if (button.dataset.action === 'save-user') {
        await api('/users/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({
          username: $('[data-field="username"]', row).value.trim(),
          role: $('[data-field="role"]', row).value,
        }) });
      } else if (button.dataset.action === 'toggle-user') {
        await api('/users/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled: row.dataset.enabled !== 'true' }) });
      } else if (button.dataset.action === 'delete-user') {
        if (!window.confirm('确认软删除该用户？')) return;
        await api('/users/' + encodeURIComponent(id), { method: 'DELETE' });
      } else if (button.dataset.action === 'reset-user') {
        const password = window.prompt('请输入新密码');
        if (!password) return;
        await api('/users/' + encodeURIComponent(id) + '/reset-password', { method: 'POST', body: JSON.stringify({ password }) });
      }
      setMessage(message, '操作已保存', 'success');
      await loadUsers();
    } catch (error) {
      setMessage(message, errorMessage(error));
    }
  });
  void loadUsers();
}

function resetPlatformForm() {
  const form = $('#platform-form');
  if (!form) return;
  form.reset();
  delete form.dataset.editId;
  $('#platform-form-title').textContent = '新增平台账号';
  $('#credential-state').textContent = '未设置';
  $('#platform-enabled').value = 'true';
}

async function loadPlatformAccounts() {
  const target = $('#platform-rows');
  const message = $('[data-platform-message]');
  try {
    const result = await api('/platform-accounts');
    clear(target);
    (result.platformAccounts || []).forEach((account) => {
      const row = element('tr');
      row.dataset.id = account.id;
      row.dataset.enabled = String(account.enabled);
      row.appendChild(element('td', account.label));
      row.appendChild(element('td', account.enabled ? '启用' : '停用'));
      row.appendChild(element('td', dateLabel(account.updatedAt)));
      const loginStatus = element('td');
      loginStatus.dataset.loginCommandStatus = 'true';
      loginStatus.appendChild(element('span', '—', 'muted'));
      row.appendChild(loginStatus);
      const actions = element('td', null, 'row-actions');
      const remoteLogin = actionButton('远程登录', 'remote-login', account.id);
      remoteLogin.disabled = !account.enabled;
      actions.append(
        remoteLogin,
        actionButton('编辑', 'edit-account', account.id),
        actionButton(account.enabled ? '停用' : '启用', 'toggle-account', account.id),
        actionButton('删除', 'delete-account', account.id, 'small-button danger'),
      );
      row.appendChild(actions);
      target.appendChild(row);
    });
    setMessage(message, '已更新', 'success');
    await loadLoginCommands();
  } catch (error) {
    setMessage(message, errorMessage(error));
  }
}

function initPlatformAccounts() {
  const form = $('#platform-form');
  const list = $('#platform-rows');
  const cancel = $('#platform-cancel');
  if (cancel) cancel.addEventListener('click', resetPlatformForm);
  if (form) form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const label = $('#platform-label').value.trim();
    const account = $('#platform-account').value;
    const password = $('#platform-password').value;
    if (!label || (!form.dataset.editId && (!account || !password)) || (account && !password) || (!account && password)) {
      setMessage($('[data-platform-message]'), '请完整填写标签和凭据');
      return;
    }
    setFormBusy(form, true);
    try {
      const payload = { label, enabled: $('#platform-enabled').value === 'true' };
      if (account && password) { payload.account = account; payload.password = password; }
      const path = form.dataset.editId ? '/platform-accounts/' + encodeURIComponent(form.dataset.editId) : '/platform-accounts';
      await api(path, { method: form.dataset.editId ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      resetPlatformForm();
      setMessage($('[data-platform-message]'), '平台账号已保存，凭据输入已清空', 'success');
      await loadPlatformAccounts();
    } catch (error) {
      setMessage($('[data-platform-message]'), errorMessage(error));
    } finally {
      setFormBusy(form, false);
    }
  });
  if (list) list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const id = button.dataset.id;
    const row = button.closest('tr');
    try {
      if (button.dataset.action === 'remote-login') {
        button.disabled = true;
        setRowLoginStatus(row, 'pending');
        const command = await api('/login-commands', {
          method: 'POST',
          body: JSON.stringify({ platformAccountId: id }),
        });
        setMessage($('[data-platform-message]'), '登录指令已创建', 'success');
        await loadLoginCommands();
        startLoginCommandPolling(row, command.id, button);
        return;
      }
      if (button.dataset.action === 'edit-account') {
        $('#platform-label').value = row.firstChild.textContent;
        $('#platform-enabled').value = row.dataset.enabled === 'true' ? 'true' : 'false';
        $('#platform-account').value = '';
        $('#platform-password').value = '';
        $('#platform-form').dataset.editId = id;
        $('#platform-form-title').textContent = '编辑平台账号';
        $('#credential-state').textContent = '已设置';
        $('#platform-label').focus();
        return;
      }
      if (button.dataset.action === 'toggle-account') {
        await api('/platform-accounts/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled: row.dataset.enabled !== 'true' }) });
      } else if (button.dataset.action === 'delete-account') {
        if (!window.confirm('确认软删除该平台账号？')) return;
        await api('/platform-accounts/' + encodeURIComponent(id), { method: 'DELETE' });
      }
      setMessage($('[data-platform-message]'), '操作已保存', 'success');
      await loadPlatformAccounts();
    } catch (error) {
      if (button.dataset.action === 'remote-login') {
        const duplicate = error instanceof ApiError && error.code === 'DUPLICATE_PENDING';
        setRowLoginStatus(row, duplicate ? 'pending' : 'failed', duplicate ? '(已有未完成指令)' : '(REQUEST_FAILED)');
        button.disabled = row.dataset.enabled !== 'true';
      }
      setMessage($('[data-platform-message]'), errorMessage(error));
    }
  });
  void loadPlatformAccounts();
}

function renderDetail(caseValue, screenshots) {
  const fields = $('#case-fields');
  const gallery = $('#screenshot-list');
  clear(fields);
  clear(gallery);
  const values = [
    ['状态', statusLabel(caseValue.status)],
    ['类型', caseValue.kind === 'qz' ? '强执' : '立案'],
    ['原告', caseValue.plaintiff || '—'],
    ['被告', caseValue.defendant || '—'],
    ['案号', caseValue.caseNumber || '—'],
    ['查询时间', dateLabel(caseValue.queryTime)],
    ['立案日期', caseValue.filedTime || '—'],
    ['驳回时间', caseValue.rejectTime || '—'],
    ['驳回原因', caseValue.rejectReason || '—'],
  ];
  values.forEach(([label, value]) => {
    const item = element('div', null, 'detail-item');
    item.appendChild(element('dt', label));
    item.appendChild(element('dd', value, label === '驳回原因' ? 'reason' : ''));
    fields.appendChild(item);
  });
  if (!screenshots.length) {
    gallery.appendChild(element('p', '暂无截图', 'muted'));
    return;
  }
  screenshots.forEach((screenshot) => {
    const card = element('article', null, 'screenshot-card');
    const contentUrl = screenshot.contentUrl || API_BASE + '/screenshots/' + screenshot.id + '/content';
    const image = document.createElement('img');
    image.src = contentUrl;
    image.alt = '案件截图 ' + screenshot.type;
    image.loading = 'lazy';
    card.appendChild(image);
    const meta = element('div', null, 'screenshot-meta');
    meta.appendChild(element('strong', screenshot.type));
    meta.appendChild(element('span', dateLabel(screenshot.capturedAt), 'subtle'));
    const actions = element('div', null, 'screenshot-actions');
    const view = element('a', '查看');
    view.href = contentUrl;
    view.target = '_blank';
    view.rel = 'noreferrer';
    const download = element('a', '下载');
    download.href = contentUrl + (contentUrl.includes('?') ? '&' : '?') + 'download=1';
    download.download = 'screenshot-' + screenshot.id;
    actions.append(view, download);
    meta.appendChild(actions);
    card.appendChild(meta);
    gallery.appendChild(card);
  });
}

async function loadCaseDetail() {
  const id = document.body.dataset.caseId;
  const message = $('[data-detail-message]');
  try {
    const result = await Promise.all([
      api('/cases/' + encodeURIComponent(id)),
      api('/cases/' + encodeURIComponent(id) + '/screenshots'),
    ]);
    renderDetail(result[0], result[1].screenshots || []);
    setMessage(message, '已加载', 'success');
  } catch (error) {
    setMessage(message, errorMessage(error));
  }
}

async function initPage() {
  const page = document.body.dataset.page;
  if (page === 'login' || page === 'forbidden') {
    if (page === 'login') await initLogin();
    return;
  }
  try {
    await loadSession();
    installLogout();
    if (page === 'cases') initCases();
    else if (page === 'users') initUsers();
    else if (page === 'platform-accounts') initPlatformAccounts();
    else if (page === 'case-detail') void loadCaseDetail();
  } catch (error) {
    setMessage($('[data-page-status]'), errorMessage(error));
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void initPage(); });
else void initPage();
`;
