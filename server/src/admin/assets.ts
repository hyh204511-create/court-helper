export function maskAdminUsername(value: unknown): string {
  const username = typeof value === 'string' ? value.trim() : '';
  if (!username) return '';
  if (username.length <= 1) return '*';
  if (username.length === 2) return `${username[0]}*`;
  return `${username[0]}***${username[username.length - 1]}`;
}

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
.account-picker { display: flex; align-items: center; position: relative; border: 1px solid var(--line); border-radius: 10px; background: var(--paper-bright); }
.account-picker:focus-within { border-color: var(--amber); box-shadow: 0 0 0 3px rgba(211, 148, 50, .22); }
.account-picker input { min-width: 0; flex: 1 1 auto; width: auto; border: 0; background: transparent; }
.account-picker input:focus-visible { outline: 0; }
.account-picker-toggle { flex: 0 0 auto; margin-right: 5px; padding: 7px 9px; border: 0; border-radius: 7px; color: var(--ink); background: transparent; }
.account-picker-toggle:hover { background: var(--amber-soft); transform: none; }
.account-picker-menu { position: absolute; z-index: 20; top: calc(100% + 4px); right: 0; left: 0; max-height: 240px; overflow-y: auto; padding: 6px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper-bright); box-shadow: var(--shadow); }
.account-picker-option { display: block; width: 100%; padding: 9px 10px; border: 0; border-radius: 7px; color: var(--ink); background: transparent; text-align: left; }
.account-picker-option:hover { background: var(--amber-soft); transform: none; }
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
.detail-grid[hidden] { display: none; }
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
const ACCOUNT_CASE_PAGE_SIZE = 100;
const ACCOUNT_CASE_MAX_PAGES = 100;
let csrfToken = null;
let currentSessionUser = null;
let casePollTimer = null;
let caseCursor = null;
let nextCaseCursor = null;
let nextReportExportCursor = null;
let browserControlImportBatches = [];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

class ApiError extends Error {
  constructor(status, code, requestId, details = []) {
    super(code || 'REQUEST_FAILED');
    this.status = status;
    this.code = code || 'REQUEST_FAILED';
    this.requestId = requestId || '';
    this.details = Array.isArray(details) ? details : [];
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
    if (error.code === 'DUPLICATE_PENDING') return '已有进行中的统一登录任务，请前往浏览器控制查看';
    if (error.code === 'TEMPLATE_NOT_EMPTY') return '当前查询表块必须为空，请上传仅含表头的模板';
    const detailCode = error.details[0]?.code;
    if (detailCode === 'template_limit_exceeded') return '模板超过限制：最多 5,000 行、20 列';
    if (detailCode === 'template_mismatch') return '模板不匹配，请使用新版 20 列立案与强执查询表';
    if (detailCode === 'sheet_required') return '模板缺少 Sheet1 工作表';
    if (detailCode === 'enforcement_header_required') return '旧版模板缺少强执表头，请改用新版 20 列模板';
    if (detailCode === 'mime_mismatch' || detailCode === 'magic_not_allowed') return '文件不是有效的 xlsx 模板';
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
    throw new ApiError(response.status, body?.error?.code, body?.error?.requestId, body?.error?.details);
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
      window.location.assign('/admin/browser-control');
    } catch (error) {
      setMessage(message, error instanceof TypeError ? '服务器不可达，请重试' : '账号或密码错误/账号不可用');
      setFormBusy(form, false);
    }
  });
}

async function loadSession() {
  const result = await api('/auth/me');
  csrfToken = result.csrfToken || null;
  currentSessionUser = result;
  const currentUser = $('#current-backoffice-user');
  if (currentUser) currentUser.textContent = result.username || '未知用户';
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

function reportExportSizeLabel(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(1) + ' KB';
}

function maskAdminUsername(value) {
  const username = typeof value === 'string' ? value.trim() : '';
  if (!username) return '';
  if (username.length <= 1) return '*';
  if (username.length === 2) return username[0] + '*';
  return username[0] + '***' + username[username.length - 1];
}

function reportExportDownloadName(response, fallback) {
  const disposition = response.headers.get('Content-Disposition') || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded) {
    try { return decodeURIComponent(encoded[1]); } catch { /* Use the safe fallback. */ }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : (fallback || 'report-export.xlsx');
}

function renderStatus(value) {
  return element('span', statusLabel(value), 'status-pill status-' + statusLabel(value));
}

let platformLabels = new Map();

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
      const actions = element('td', null, 'row-actions');
      actions.append(
        actionButton('编辑', 'edit-account', account.id),
        actionButton(account.enabled ? '停用' : '启用', 'toggle-account', account.id),
        actionButton('删除', 'delete-account', account.id, 'small-button danger'),
      );
      row.appendChild(actions);
      target.appendChild(row);
    });
    setMessage(message, '已更新', 'success');
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
      setMessage($('[data-platform-message]'), errorMessage(error));
    }
  });
  void loadPlatformAccounts();
}

async function downloadReportExport(id, fallbackFileName) {
  const response = await fetch(API_BASE + '/report-exports/' + encodeURIComponent(id) + '/download', {
    credentials: 'same-origin',
  });
  if (response.status === 401) {
    window.location.assign('/admin/login');
    throw new ApiError(401, 'AUTH_REQUIRED');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, body?.error?.code, body?.error?.requestId);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = reportExportDownloadName(response, fallbackFileName);
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function loadReportExportUsers() {
  if (document.body.dataset.role !== 'admin') return new Map();
  const result = await api('/users');
  return new Map((result.users || []).map((user) => [user.id, user.username]));
}

function reportExportListPath(cursor) {
  const params = new URLSearchParams({ limit: '200' });
  if (cursor) params.set('cursor', cursor);
  return '/report-exports?' + params.toString();
}

function ensureReportExportNextButton(message) {
  const existing = $('#report-export-next');
  if (existing || !message?.parentElement) return existing;
  const next = element('button', '加载更多', 'secondary');
  next.id = 'report-export-next';
  next.type = 'button';
  next.style.display = 'none';
  message.parentElement.appendChild(next);
  return next;
}

async function loadReportExports(append = false) {
  const target = $('#report-export-rows');
  const message = $('[data-report-export-message]');
  if (!target) return;
  try {
    const cursor = append ? nextReportExportCursor : null;
    const [result, userNames] = await Promise.all([
      api(reportExportListPath(cursor)),
      loadReportExportUsers(),
    ]);
    const reportExports = result.reportExports || [];
    if (!append) clear(target);
    if (!append && !reportExports.length) {
      const row = element('tr');
      const cell = element('td', '暂无报表导出');
      cell.colSpan = document.body.dataset.role === 'admin' ? 6 : 5;
      row.appendChild(cell);
      target.appendChild(row);
    }
    reportExports.forEach((reportExport) => {
      const row = element('tr');
      row.dataset.id = reportExport.id;
      row.dataset.fileName = reportExport.fileName || 'report-export.xlsx';
      row.appendChild(element('td', reportExport.fileName || '—'));
      row.appendChild(element('td', reportExportSizeLabel(reportExport.byteSize)));
      row.appendChild(element('td', String(reportExport.sha256 || '').slice(0, 8) || '—'));
      if (document.body.dataset.role === 'admin') {
        row.appendChild(element('td', maskAdminUsername(userNames.get(reportExport.createdBy)) || '未知用户'));
      }
      row.appendChild(element('td', dateLabel(reportExport.createdAt)));
      const actions = element('td', null, 'row-actions');
      actions.append(
        actionButton('下载', 'download-report-export', reportExport.id),
        actionButton('删除', 'delete-report-export', reportExport.id, 'small-button danger'),
      );
      row.appendChild(actions);
      target.appendChild(row);
    });
    nextReportExportCursor = result.nextCursor || null;
    const next = $('#report-export-next');
    if (next) next.style.display = nextReportExportCursor === null ? 'none' : 'inline-flex';
    setMessage(message, '已更新', 'success');
  } catch (error) {
    setMessage(message, errorMessage(error));
  }
}

let browserCommandPollTimer = null;
let browserControlVisible = true;
let browserControlUserNames = null;
let browserControlAccounts = [];
let browserAccountQueryGeneration = 0;

function browserCommandStatusLabel(status) {
  const labels = { pending: '等待中', executing: '执行中', succeeded: '成功', failed: '失败', expired: '已过期', manual_required: '待人工', cancelled: '已取消' };
  return labels[status] || '未知状态';
}

function browserCommandProgressLabel(progress) {
  if (progress === null || progress === undefined) return '—';
  if (typeof progress === 'number') return String(Math.max(0, Math.min(100, progress))) + '%';
  if (typeof progress === 'object') {
    const value = progress.percent ?? progress.completed ?? progress.total;
    return value === undefined ? '进行中' : String(value);
  }
  return '进行中';
}

function clearPlatformCredential() {
  const view = $('#platform-credential-view');
  const account = $('#platform-credential-account');
  const password = $('#platform-credential-password');
  if (account) account.textContent = '';
  if (password) password.textContent = '';
  if (view) view.hidden = true;
}

function fillPlatformAccountSelect(select, accounts, includeEmpty) {
  if (!select) return;
  const selected = select.value;
  clear(select);
  if (includeEmpty) {
    const empty = element('option', '不选择');
    empty.value = '';
    select.appendChild(empty);
  }
  accounts.forEach((account) => {
    const option = element('option', account.label || '未命名');
    option.value = account.id;
    option.selected = account.id === selected;
    select.appendChild(option);
  });
}

function fillPlatformAccountLabelList(input, list, accounts) {
  if (!input || !list) return;
  const selected = input.value;
  const normalizedSelected = String(selected || '').trim().toLocaleLowerCase('zh-CN');
  clear(list);
  accounts.forEach((account) => {
    const option = element('button', account.label || '未命名', 'account-picker-option');
    option.type = 'button';
    option.setAttribute('role', 'option');
    option.dataset.platformAccountLabel = account.label || '';
    list.appendChild(option);
  });
  if (!accounts.some((account) => String(account.label || '').trim().toLocaleLowerCase('zh-CN') === normalizedSelected)) input.value = accounts[0]?.label || '';
  list.hidden = true;
  input.setAttribute('aria-expanded', 'false');
}

async function loadBrowserControlAccounts() {
  const taskSelect = $('#browser-command-account');
  const loginInput = $('#platform-login-account');
  const loginLabels = $('#platform-login-account-menu');
  if (!taskSelect && !loginInput) return;
  try {
    const result = await api('/platform-accounts');
    const allAccounts = result.platformAccounts || [];
    const enabledAccounts = allAccounts.filter((account) => account.enabled !== false);
    browserControlAccounts = allAccounts;
    fillPlatformAccountSelect(taskSelect, enabledAccounts, true);
    fillPlatformAccountLabelList(loginInput, loginLabels, enabledAccounts);
    const labels = $('#browser-account-labels');
    if (labels) {
      clear(labels);
      allAccounts.forEach((account) => { const option = document.createElement('option'); option.value = account.label || '未命名'; labels.appendChild(option); });
    }
    clearPlatformCredential();
  } catch (error) {
    setMessage($('[data-browser-command-message]'), errorMessage(error));
    setMessage($('[data-platform-login-message]'), errorMessage(error));
  }
}

function browserAccountLabel(platformAccountId) {
  return browserControlAccounts.find((account) => account.id === platformAccountId)?.label || '未指定';
}

function selectedBrowserAccount(query, accounts = browserControlAccounts) {
  const normalized = String(query || '').trim().toLocaleLowerCase('zh-CN');
  if (!normalized) return null;
  const exact = accounts.find((account) => String(account.label || '').trim().toLocaleLowerCase('zh-CN') === normalized);
  if (exact) return exact;
  const matches = accounts.filter((account) => String(account.label || '').toLocaleLowerCase('zh-CN').includes(normalized));
  return matches.length === 1 ? matches[0] : null;
}

function selectedEnabledBrowserAccount(query) {
  return selectedBrowserAccount(query, browserControlAccounts.filter((account) => account.enabled !== false));
}

function filterBrowserCommandRows() {
  const query = String($('#browser-account-search')?.value || '').trim().toLocaleLowerCase('zh-CN');
  document.querySelectorAll('#browser-command-rows tr[data-account-label]').forEach((row) => {
    row.hidden = Boolean(query) && !String(row.dataset.accountLabel || '').toLocaleLowerCase('zh-CN').includes(query);
  });
}

function matchesBrowserAccountKeyword(caseRecord, keyword) {
  if (!keyword) return true;
  const normalized = keyword.toLocaleLowerCase('zh-CN');
  return [caseRecord.plaintiff, caseRecord.defendant, caseRecord.caseNumber].some((candidate) => (
    typeof candidate === 'string'
    && candidate.toLocaleLowerCase('zh-CN').includes(normalized)
  ));
}

async function loadBrowserAccountCases(account, generation) {
  const target = $('#browser-account-case-rows');
  const message = $('[data-browser-account-message]');
  if (!target) return;
  if (generation !== browserAccountQueryGeneration) return;
  clear(target);
  try {
    const keyword = String($('#browser-account-keyword')?.value || '').trim();
    const cases = [];
    const seenCursors = new Set();
    let cursor = null;
    let pageCount = 0;
    while (true) {
      if (pageCount >= ACCOUNT_CASE_MAX_PAGES) throw new ApiError(0, 'CASE_QUERY_PAGINATION_INVALID');
      if (cursor !== null) {
        const cursorKey = String(cursor);
        if (seenCursors.has(cursorKey)) throw new ApiError(0, 'CASE_QUERY_PAGINATION_INVALID');
        seenCursors.add(cursorKey);
      }
      pageCount += 1;
      const params = new URLSearchParams();
      params.set('platformAccountId', account.id);
      params.set('limit', String(ACCOUNT_CASE_PAGE_SIZE));
      if (cursor !== null) params.set('cursor', String(cursor));
      const result = await api('/cases?' + params.toString());
      if (generation !== browserAccountQueryGeneration) return;
      cases.push(...(result.cases || []));
      const nextCursor = result.nextCursor ?? null;
      if (nextCursor !== null && cursor !== null && String(nextCursor) === String(cursor)) {
        throw new ApiError(0, 'CASE_QUERY_PAGINATION_INVALID');
      }
      cursor = nextCursor;
      if (cursor === null) break;
    }
    const filteredCases = cases.filter((caseRecord) => matchesBrowserAccountKeyword(caseRecord, keyword));
    filteredCases.forEach((caseRecord) => {
      const row = element('tr');
      row.append(
        element('td', account.label || '未命名'),
        element('td', caseRecord.kind === 'qz' ? '强执' : '立案'),
        element('td', caseRecord.status === 'UNKNOWN' ? '待人工' : caseRecord.status, 'status-pill'),
        element('td', caseRecord.caseNumber || '—'),
        element('td', dateLabel(caseRecord.queryTime)),
      );
      target.appendChild(row);
    });
    if (!target.firstChild) { const row = element('tr'); const cell = element('td', '该账号暂无案件记录'); cell.colSpan = 5; row.appendChild(cell); target.appendChild(row); }
    setMessage(message, '已定位账号：' + (account.label || '未命名') + '，共 ' + filteredCases.length + ' 条案件', 'success');
  } catch (error) {
    if (generation !== browserAccountQueryGeneration) return;
    setMessage(message, errorMessage(error));
  }
}

async function loadBrowserControlUserNames() {
  if (browserControlUserNames) return browserControlUserNames;
  const names = new Map();
  if (currentSessionUser?.id && currentSessionUser?.username) {
    names.set(currentSessionUser.id, currentSessionUser.username);
  }
  if (currentSessionUser?.role === 'admin') {
    try {
      const result = await api('/users');
      (result.users || []).forEach((user) => names.set(user.id, user.username));
    } catch {
      // The command table remains usable if the optional name map is temporarily unavailable.
    }
  }
  browserControlUserNames = names;
  return names;
}

async function loadImportBatches() {
  const target = $('#import-batch-rows');
  const select = $('#browser-command-batch');
  if (!target || !select) return;
  try {
    const result = await api('/import-batches?limit=100');
    const importBatches = Array.isArray(result.importBatches) ? result.importBatches : [];
    browserControlImportBatches = importBatches;
    clear(target); clear(select);
    const empty = element('option', '不选择'); empty.value = ''; select.appendChild(empty);
    importBatches.forEach((batch) => {
      const liLabel = batch.liRows === 0 ? '立案 0（平台发现）' : '立案 ' + batch.liRows;
      const qzLabel = batch.qzRows === 0 ? '强执 0（平台发现）' : '强执 ' + batch.qzRows;
      const option = element('option', batch.fileName + '（' + liLabel + ' / ' + qzLabel + '）');
      option.value = batch.id;
      option.disabled = Number(batch.liRows) > 0 || Number(batch.qzRows) > 0;
      select.appendChild(option);
      const row = element('tr');
      row.append(element('td', batch.fileName), element('td', batch.liRows === 0 ? '0（平台发现）' : batch.liRows), element('td', batch.qzRows === 0 ? '0（平台发现）' : batch.qzRows), element('td', batch.skippedRows), element('td', dateLabel(batch.createdAt)));
      const actions = element('td', null, 'row-actions');
      if (batch.canDelete) actions.append(actionButton('删除', 'delete-import-batch', batch.id, 'small-button danger'));
      row.appendChild(actions);
      target.appendChild(row);
    });
    if (!target.firstChild) { const row = element('tr'); const cell = element('td', '暂无导入批次'); cell.colSpan = 6; row.appendChild(cell); target.appendChild(row); }
  } catch (error) { browserControlImportBatches = []; setMessage($('[data-import-batch-message]'), errorMessage(error)); }
}

async function loadBrowserCommands() {
  const target = $('#browser-command-rows');
  const message = $('[data-browser-command-status]');
  if (!target || !browserControlVisible) return;
  try {
    const [result, userNames] = await Promise.all([
      api('/browser-commands?limit=100'),
      loadBrowserControlUserNames(),
    ]);
    clear(target);
    (result.commands || []).forEach((command) => {
      const accountLabel = browserAccountLabel(command.platformAccountId);
      const row = element('tr'); row.dataset.id = command.id; row.dataset.type = command.type; row.dataset.account = command.platformAccountId || ''; row.dataset.accountLabel = accountLabel; row.dataset.batch = command.clientBatchId || '';
      const accountCell = element('td', accountLabel); accountCell.dataset.commandAccount = 'true';
      const creator = element('td', userNames.get(command.requestedBy) || '未知用户');
      creator.dataset.commandCreator = 'true';
      row.append(accountCell, element('td', command.type), element('td', browserCommandStatusLabel(command.status), 'status-pill'), element('td', browserCommandProgressLabel(command.progress)), element('td', [command.resultCode, command.resultSummary].filter(Boolean).join(' / ') || '—'), creator, element('td', dateLabel(command.createdAt)));
      const actions = element('td', null, 'row-actions');
      if (['pending', 'executing'].includes(command.status) && command.requestedBy === currentSessionUser?.id) actions.append(actionButton('取消', 'cancel-browser-command', command.id, 'small-button danger'));
      if (['failed', 'manual_required', 'expired'].includes(command.status)) actions.append(actionButton('重试', 'retry-browser-command', command.id));
      if (command.type === 'QUERY_ALL_EXPORT' && ['succeeded', 'failed', 'expired', 'manual_required', 'cancelled'].includes(command.status)) actions.append(actionButton('删除', 'delete-browser-command', command.id, 'small-button danger'));
      row.appendChild(actions); target.appendChild(row);
    });
    if (!target.firstChild) { const row = element('tr'); const cell = element('td', '暂无浏览器任务'); cell.colSpan = 8; row.appendChild(cell); target.appendChild(row); }
    filterBrowserCommandRows();
    setMessage(message, '已更新 ' + (result.commands?.length || 0) + ' 条任务', 'success');
  } catch (error) { setMessage(message, errorMessage(error)); }
}

async function loadExtensionAuthorizations() {
  const pairingTarget = $('#extension-pairing-list');
  const deviceTarget = $('#extension-device-list');
  const message = $('[data-extension-authorization-message]');
  if (!pairingTarget || !deviceTarget) return;
  try {
    const [pairingResult, deviceResult] = await Promise.all([
      api('/auth/extension-pairings'),
      api('/auth/extension-devices'),
    ]);
    clear(pairingTarget);
    (pairingResult.pairings || []).forEach((pairing) => {
      const row = element('tr');
      row.dataset.id = pairing.id;
      row.append(
        element('td', pairing.deviceId || '—'),
        element('td', pairing.label || '未命名'),
        element('td', dateLabel(pairing.expiresAt)),
      );
      const codeCell = element('td');
      const code = document.createElement('input');
      code.type = 'text'; code.inputMode = 'numeric'; code.maxLength = 6; code.autocomplete = 'one-time-code';
      code.setAttribute('aria-label', '扩展核对码');
      codeCell.append(code);
      const actions = element('td', null, 'row-actions');
      actions.append(actionButton('批准', 'approve-extension-pairing', pairing.id));
      row.append(codeCell, actions);
      pairingTarget.append(row);
    });
    if (!pairingTarget.firstChild) {
      const row = element('tr'); const cell = element('td', '暂无待批准的扩展请求'); cell.colSpan = 5; row.append(cell); pairingTarget.append(row);
    }
    clear(deviceTarget);
    (deviceResult.devices || []).forEach((device) => {
      const row = element('tr'); row.dataset.id = device.id;
      row.append(
        element('td', device.deviceId || '—'),
        element('td', device.label || '未命名'),
        element('td', dateLabel(device.lastSeenAt)),
        element('td', device.enabled && !device.revokedAt ? '已授权' : '已撤销'),
      );
      const actions = element('td', null, 'row-actions');
      if (device.enabled && !device.revokedAt) actions.append(actionButton('撤销', 'revoke-extension-device', device.id, 'small-button danger'));
      actions.append(actionButton('删除', 'delete-extension-device', device.id, 'small-button danger'));
      row.append(actions);
      deviceTarget.append(row);
    });
    if (!deviceTarget.firstChild) {
      const row = element('tr'); const cell = element('td', '暂无已授权设备'); cell.colSpan = 5; row.append(cell); deviceTarget.append(row);
    }
    setMessage(message, '授权状态已更新', 'success');
  } catch (error) {
    setMessage(message, errorMessage(error));
  }
}

function startBrowserCommandPolling() {
  if (browserCommandPollTimer) window.clearInterval(browserCommandPollTimer);
  browserCommandPollTimer = window.setInterval(() => { if (browserControlVisible) void loadBrowserCommands(); }, 3000);
  void loadBrowserCommands();
}

function initBrowserControl() {
  const commandForm = $('#browser-command-form');
  const loginForm = $('#platform-login-form');
  const loginAccount = $('#platform-login-account');
  const loginAccountPicker = $('#platform-login-account-picker');
  const loginAccountToggle = $('#platform-login-account-toggle');
  const loginAccountMenu = $('#platform-login-account-menu');
  const importForm = $('#import-batch-form');
  const account = $('#browser-command-account');
  const batch = $('#browser-command-batch');
  const accountSearchForm = $('#browser-account-search-form');
  const accountSearch = $('#browser-account-search');
  let credentialRequestGeneration = 0;
  const invalidatePlatformCredential = () => {
    credentialRequestGeneration += 1;
    clearPlatformCredential();
  };
  const filterLoginAccountMenu = (useQuery = true) => {
    if (!loginAccountMenu) return;
    const query = useQuery ? String(loginAccount?.value || '').trim().toLocaleLowerCase('zh-CN') : '';
    loginAccountMenu.querySelectorAll('[role="option"]').forEach((option) => {
      const label = String(option.dataset.platformAccountLabel || '').toLocaleLowerCase('zh-CN');
      option.hidden = Boolean(query) && !label.includes(query);
    });
  };
  const closeLoginAccountMenu = () => {
    if (!loginAccountMenu) return;
    loginAccountMenu.hidden = true;
    loginAccount?.setAttribute('aria-expanded', 'false');
    loginAccountToggle?.setAttribute('aria-expanded', 'false');
  };
  const openLoginAccountMenu = (showAll = false) => {
    if (!loginAccountMenu) return;
    filterLoginAccountMenu(!showAll);
    loginAccountMenu.hidden = false;
    loginAccount?.setAttribute('aria-expanded', 'true');
    loginAccountToggle?.setAttribute('aria-expanded', 'true');
  };
  document.addEventListener('visibilitychange', () => { browserControlVisible = document.visibilityState === 'visible'; if (browserControlVisible) void loadBrowserCommands(); });
  window.addEventListener('pagehide', invalidatePlatformCredential);
  loginAccount?.addEventListener('input', invalidatePlatformCredential);
  loginAccount?.addEventListener('change', invalidatePlatformCredential);
  loginAccount?.addEventListener('input', () => {
    if (loginAccount.value.trim()) openLoginAccountMenu();
    else closeLoginAccountMenu();
  });
  loginAccountToggle?.addEventListener('click', (event) => {
    event.preventDefault();
    if (loginAccountMenu?.hidden) openLoginAccountMenu(true);
    else closeLoginAccountMenu();
    loginAccount?.focus();
  });
  loginAccountMenu?.addEventListener('click', (event) => {
    const option = event.target.closest('[role="option"]');
    if (!option || !loginAccount) return;
    loginAccount.value = option.dataset.platformAccountLabel || '';
    loginAccount.dispatchEvent(new Event('input', { bubbles: true }));
    closeLoginAccountMenu();
  });
  document.addEventListener('click', (event) => {
    if (loginAccountPicker && !loginAccountPicker.contains(event.target)) closeLoginAccountMenu();
  });
  $('#platform-credential-hide')?.addEventListener('click', invalidatePlatformCredential);
  $('#platform-credential-show')?.addEventListener('click', async () => {
    const selected = selectedEnabledBrowserAccount(loginAccount?.value);
    const platformAccountId = selected?.id || '';
    if (!selected) { setMessage($('[data-platform-login-message]'), '请从启用平台账号标签提示中选择'); return; }
    const requestGeneration = ++credentialRequestGeneration;
    clearPlatformCredential();
    try {
      const credential = await api('/platform-accounts/' + encodeURIComponent(platformAccountId) + '/credential-view');
      if (requestGeneration !== credentialRequestGeneration || selectedEnabledBrowserAccount(loginAccount?.value)?.id !== platformAccountId) return;
      $('#platform-credential-account').textContent = credential.account || '';
      $('#platform-credential-password').textContent = credential.password || '';
      $('#platform-credential-view').hidden = false;
      setMessage($('[data-platform-login-message]'), '凭据已按需读取；关闭或切换账号后立即清空', 'success');
    } catch (error) {
      if (requestGeneration !== credentialRequestGeneration) return;
      clearPlatformCredential();
      setMessage($('[data-platform-login-message]'), errorMessage(error));
    }
  });
  loginForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const selected = selectedEnabledBrowserAccount(loginAccount?.value);
    const platformAccountId = selected?.id || '';
    if (!selected) { setMessage($('[data-platform-login-message]'), '请从启用平台账号标签提示中选择'); return; }
    loginAccount.value = selected.label || '';
    setFormBusy(loginForm, true);
    try {
      await api('/browser-commands', {
        method: 'POST',
        body: JSON.stringify({ type: 'LOGIN', platformAccountId }),
      });
      setMessage($('[data-platform-login-message]'), '登录任务已创建', 'success');
      await loadBrowserCommands();
    } catch (error) {
      setMessage($('[data-platform-login-message]'), errorMessage(error));
    } finally { setFormBusy(loginForm, false); }
  });
  account.required = true;
  batch.required = true;
  commandForm?.addEventListener('submit', async (event) => {
    event.preventDefault(); const platformAccountId = account.value || null; const importBatchId = batch.value || null;
    if (!platformAccountId) { setMessage($('[data-browser-command-message]'), '请选择平台账号'); return; }
    if (!importBatchId) { setMessage($('[data-browser-command-message]'), '一键任务必须选择空白导入批次'); return; }
    setFormBusy(commandForm, true);
    try { await api('/browser-commands', { method: 'POST', body: JSON.stringify({ type: 'QUERY_ALL_EXPORT', platformAccountId, importBatchId }) }); setMessage($('[data-browser-command-message]'), '一键查询导出任务已创建', 'success'); await loadBrowserCommands(); }
    catch (error) { setMessage($('[data-browser-command-message]'), errorMessage(error)); } finally { setFormBusy(commandForm, false); }
  });
  importForm?.addEventListener('submit', async (event) => {
    event.preventDefault(); const file = $('#import-batch-file')?.files?.[0]; if (!file) return;
    const formData = new FormData(); formData.append('file', file); const headers = new Headers(); if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
    setFormBusy(importForm, true);
    try { const response = await fetch(API_BASE + '/import-batches', { method: 'POST', body: formData, headers, credentials: 'same-origin' }); const body = await response.json().catch(() => null); if (!response.ok) throw new ApiError(response.status, body?.error?.code, body?.error?.requestId, body?.error?.details); importForm.reset(); setMessage($('[data-import-batch-message]'), '批次已上传', 'success'); await loadImportBatches(); }
    catch (error) { setMessage($('[data-import-batch-message]'), errorMessage(error)); } finally { setFormBusy(importForm, false); }
  });
  $('#import-batch-rows')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action="delete-import-batch"]');
    if (!button) return;
    if (!window.confirm('确认删除此导入文件？删除后无法用于新查询任务。')) return;
    try {
      button.disabled = true;
      await api('/import-batches/' + encodeURIComponent(button.dataset.id), { method: 'DELETE' });
      await loadImportBatches();
      setMessage($('[data-import-batch-message]'), '导入文件已删除', 'success');
    } catch (error) {
      setMessage($('[data-import-batch-message]'), errorMessage(error));
      button.disabled = false;
    }
  });
  $('#browser-command-refresh')?.addEventListener('click', () => { void loadBrowserCommands(); void loadImportBatches(); });
  accountSearch?.addEventListener('input', filterBrowserCommandRows);
  accountSearchForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const selected = selectedBrowserAccount(accountSearch?.value);
    if (!selected) { setMessage($('[data-browser-account-message]'), '未找到唯一账号，请从账号标签提示中选择'); return; }
    accountSearch.value = selected.label || '';
    filterBrowserCommandRows();
    const generation = ++browserAccountQueryGeneration;
    void loadBrowserAccountCases(selected, generation);
  });
  $('#browser-command-clear')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!window.confirm('确认清空有权查看的全部已结束任务记录？活动任务和案件台账不会删除。')) return;
    try {
      button.disabled = true;
      const result = await api('/browser-commands', { method: 'DELETE' });
      await loadBrowserCommands();
      setMessage($('[data-browser-command-status]'), '已清理 ' + Number(result.deletedCount || 0) + ' 条已结束任务', 'success');
    } catch (error) {
      setMessage($('[data-browser-command-status]'), errorMessage(error));
    } finally { button.disabled = false; }
  });
  $('#browser-command-delete-all')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!window.confirm('确认删除所有已结束的一键查询并导出任务记录？活动任务不会删除。')) return;
    try {
      button.disabled = true;
      const result = await api('/browser-commands?type=QUERY_ALL_EXPORT', { method: 'DELETE' });
      await loadBrowserCommands();
      setMessage($('[data-browser-command-status]'), '已删除 ' + Number(result.deletedCount || 0) + ' 条一键任务', 'success');
    } catch (error) {
      setMessage($('[data-browser-command-status]'), errorMessage(error));
    } finally { button.disabled = false; }
  });
  $('#extension-pairing-list')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action="approve-extension-pairing"]');
    if (!button) return;
    const row = button.closest('tr');
    const verificationCode = row?.querySelector('input')?.value?.trim() || '';
    try {
      button.disabled = true;
      await api('/auth/extension-pairings/' + encodeURIComponent(button.dataset.id) + '/approve', {
        method: 'POST', body: JSON.stringify({ verificationCode }),
      });
      setMessage($('[data-extension-authorization-message]'), '扩展已批准，正在等待设备兑换授权', 'success');
      await loadExtensionAuthorizations();
    } catch (error) {
      setMessage($('[data-extension-authorization-message]'), errorMessage(error));
    } finally { button.disabled = false; }
  });
  $('#extension-device-list')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const isDelete = button.dataset.action === 'delete-extension-device';
    if (!['revoke-extension-device', 'delete-extension-device'].includes(button.dataset.action)) return;
    if (!window.confirm(isDelete ? '确认物理删除此扩展设备？其会话会立即失效。' : '确认撤销此扩展设备？')) return;
    try {
      button.disabled = true;
      if (isDelete) {
        await api('/auth/extension-devices/' + encodeURIComponent(button.dataset.id), { method: 'DELETE' });
      } else {
        await api('/auth/extension-devices/' + encodeURIComponent(button.dataset.id) + '/revoke', { method: 'POST', body: '{}' });
      }
      setMessage($('[data-extension-authorization-message]'), isDelete ? '扩展设备已删除' : '扩展设备已撤销', 'success');
      await loadExtensionAuthorizations();
    } catch (error) {
      setMessage($('[data-extension-authorization-message]'), errorMessage(error));
    } finally { button.disabled = false; }
  });
  $('#extension-device-delete-all')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!window.confirm('确认物理删除所有已授权设备？所有设备会话会立即失效。')) return;
    try {
      button.disabled = true;
      const result = await api('/auth/extension-devices', { method: 'DELETE' });
      await loadExtensionAuthorizations();
      setMessage($('[data-extension-authorization-message]'), '已删除 ' + Number(result.deletedCount || 0) + ' 台设备', 'success');
    } catch (error) {
      setMessage($('[data-extension-authorization-message]'), errorMessage(error));
    } finally { button.disabled = false; }
  });
  $('#browser-command-rows')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]'); if (!button) return; const id = button.dataset.id;
    try {
      button.disabled = true;
      if (button.dataset.action === 'cancel-browser-command') {
        await api('/browser-commands/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: '{}' });
      } else if (button.dataset.action === 'retry-browser-command') {
        const row = button.closest('tr');
        await api('/browser-commands', { method: 'POST', body: JSON.stringify({ type: row.dataset.type, platformAccountId: row.dataset.account || null, importBatchId: row.dataset.batch || null }) });
      } else if (button.dataset.action === 'delete-browser-command') {
        if (!window.confirm('确认物理删除此一键查询并导出任务记录？')) return;
        await api('/browser-commands/' + encodeURIComponent(id), { method: 'DELETE' });
      }
      await loadBrowserCommands();
    }
    catch (error) { setMessage($('[data-browser-command-status]'), errorMessage(error)); } finally { button.disabled = false; }
  });
  void loadBrowserControlAccounts().finally(startBrowserCommandPolling); void loadImportBatches(); void loadExtensionAuthorizations();
}

function initReportExports() {
  const list = $('#report-export-rows');
  const message = $('[data-report-export-message]');
  const next = ensureReportExportNextButton(message);
  if (list) list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const row = button.closest('tr');
    const id = button.dataset.id;
    if (!row || !id) return;
    try {
      button.disabled = true;
      if (button.dataset.action === 'download-report-export') {
        await downloadReportExport(id, row.dataset.fileName);
        setMessage(message, '下载已开始', 'success');
      } else if (button.dataset.action === 'delete-report-export') {
        if (!window.confirm('确认删除该报表导出？')) return;
        await api('/report-exports/' + encodeURIComponent(id), { method: 'DELETE' });
        setMessage(message, '已删除，正在刷新', 'success');
        await loadReportExports();
      }
    } catch (error) {
      setMessage(message, errorMessage(error));
    } finally {
      button.disabled = false;
    }
  });
  if (next) next.addEventListener('click', async () => {
    if (nextReportExportCursor === null || next.disabled) return;
    next.disabled = true;
    try {
      await loadReportExports(true);
    } finally {
      next.disabled = false;
    }
  });
  void loadReportExports();
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
    else if (page === 'report-exports') initReportExports();
    else if (page === 'browser-control') initBrowserControl();
    else if (page === 'case-detail') void loadCaseDetail();
  } catch (error) {
    setMessage($('[data-page-status]'), errorMessage(error));
  }
}

let pageInitialization = null;
function initPageOnce() {
  if (!pageInitialization) pageInitialization = initPage();
  return pageInitialization;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void initPageOnce(); });
else void initPageOnce();
`;
