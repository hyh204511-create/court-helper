export function maskAdminUsername(value: unknown): string {
  const username = typeof value === 'string' ? value.trim() : '';
  if (!username) return '';
  if (username.length <= 1) return '*';
  if (username.length === 2) return `${username[0]}*`;
  return `${username[0]}***${username[username.length - 1]}`;
}

export const ADMIN_STYLES = String.raw`
:root {
  --sidebar-width: 264px;
  --ink: #1f2937;
  --ink-soft: #5f6b7a;
  --paper: #f4f7fb;
  --paper-bright: #ffffff;
  --line: #dfe6ee;
  --line-strong: #cbd5e1;
  --navy: #1677ff;
  --navy-deep: #0b2a4a;
  --navy-hover: #0958d9;
  --blue-soft: #eaf3ff;
  --amber: #ad6800;
  --amber-soft: #fff7e6;
  --red: #c53b35;
  --red-soft: #fff1f0;
  --green: #237b4b;
  --green-soft: #edf8f1;
  --shadow: 0 4px 18px rgba(15, 42, 67, .06);
  --shadow-raised: 0 12px 32px rgba(8, 38, 68, .14);
  font-family: "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", "PingFang SC", sans-serif;
  color: var(--ink);
  background: var(--paper);
}

* { box-sizing: border-box; }

html { min-width: 320px; background: var(--paper); color-scheme: light; }

body {
  min-height: 100vh;
  margin: 0;
  color: var(--ink);
  background: var(--paper);
  line-height: 1.5;
}

a { color: inherit; }

button, input, select { font: inherit; }

button, .button {
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  touch-action: manipulation;
  transition: border-color .18s ease, box-shadow .18s ease, color .18s ease, background-color .18s ease;
}

button:active, .button:active { box-shadow: inset 0 0 0 999px rgba(15, 23, 42, .06); }

button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible {
  outline: 3px solid rgba(22, 119, 255, .28);
  outline-offset: 2px;
}

button:disabled { cursor: not-allowed; opacity: .48; box-shadow: none; }

.skip-link { position: fixed; z-index: 1000; top: 8px; left: 8px; padding: 10px 14px; border-radius: 8px; color: #fff; background: var(--navy-hover); transform: translateY(-160%); transition: transform .18s ease; }
.skip-link:focus { transform: translateY(0); }
.shell { min-height: 100vh; }

.sidebar {
  position: fixed;
  z-index: 40;
  inset: 0 auto 0 0;
  width: var(--sidebar-width);
  min-height: 100dvh;
  padding: 28px 20px;
  overflow-x: hidden;
  overflow-y: auto;
  color: #111827;
  background: linear-gradient(180deg, #d6ebff 0%, #e6f3ff 65%, #f1f8ff 100%);
  border-right: 1px solid #a7cdf0;
  box-shadow: 10px 0 28px rgba(78, 119, 155, .10);
  transition: transform .22s ease;
}

.sidebar::after {
  position: absolute;
  right: -58px;
  bottom: 34px;
  width: 146px;
  height: 146px;
  border: 1px solid rgba(77, 135, 190, .16);
  border-radius: 24px;
  transform: rotate(34deg);
  content: "";
}

.brand { position: relative; z-index: 1; margin-bottom: 34px; padding: 0 8px 28px; border-bottom: 1px solid #cfe2f5; }
.brand h1 { margin: 0; color: #111827; font-size: 28px; font-weight: 800; letter-spacing: .02em; }
.brand p { margin: 10px 0 0; color: #334155; font-size: 14px; line-height: 1.75; }

.nav { position: relative; z-index: 1; display: grid; gap: 6px; }
.nav a { position: relative; min-height: 50px; padding: 12px 14px 12px 18px; border-radius: 8px; color: #111827; text-decoration: none; font-size: 17px; font-weight: 650; transition: color .18s ease, background-color .18s ease; }
.nav a::before { position: absolute; top: 12px; bottom: 12px; left: 7px; width: 3px; border-radius: 3px; background: transparent; content: ""; }
.nav a:hover { color: #0f172a; background: #d9ecff; }
.nav a[aria-current="page"] { color: #0f172a; background: #c5e2ff; box-shadow: inset 0 0 0 1px #9dccff; }
.nav a[aria-current="page"]::before { background: #1677ff; }

.sidebar-foot { position: absolute; right: 28px; bottom: 24px; left: 28px; z-index: 1; color: #475569; font-size: 13px; line-height: 1.7; }

.sidebar-scrim { display: none; }
.content { min-width: 0; min-height: 100vh; margin-left: var(--sidebar-width); padding: 24px clamp(24px, 3.2vw, 52px) 64px; }
.topbar { display: flex; align-items: center; justify-content: flex-end; min-height: 44px; }
.nav-toggle { display: none; width: 44px; height: 44px; align-items: center; justify-content: center; padding: 0; border-color: var(--line); color: var(--ink); background: var(--paper-bright); }
.nav-toggle-icon { display: grid; width: 20px; gap: 4px; }
.nav-toggle-icon span { display: block; width: 100%; height: 2px; border-radius: 2px; background: currentColor; }
.logout { min-height: 40px; padding: 8px 14px; border-color: var(--line); color: var(--ink-soft); background: var(--paper-bright); font-size: 13px; }
.logout:hover { border-color: #91caff; color: var(--navy-hover); background: var(--blue-soft); }

.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 28px; margin: 18px 0 24px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
.eyebrow { margin: 0 0 6px; color: var(--navy-hover); font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
.page-head h2 { margin: 0; font-size: clamp(28px, 3vw, 36px); font-weight: 700; letter-spacing: -.025em; }
.page-head p { max-width: 640px; margin: 8px 0 0; color: var(--ink-soft); font-size: 14px; line-height: 1.65; }
.page-head > .subtle { flex: 0 0 auto; padding: 9px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper-bright); }

.panel { overflow: visible; border: 1px solid var(--line); border-radius: 12px; background: var(--paper-bright); box-shadow: var(--shadow); }
.panel + .panel { margin-top: 20px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; min-height: 72px; padding: 16px 20px; border-bottom: 1px solid var(--line); }
.panel-head h3 { margin: 0; font-size: 18px; font-weight: 700; }
.panel-head h4 { margin: 0; }
.panel-head p { max-width: 760px; margin: 5px 0 0; color: var(--ink-soft); font-size: 13px; line-height: 1.55; }
.panel-head .row-actions { flex: 0 0 auto; margin-left: auto; padding-left: 18px; border-left: 1px solid var(--line); }
.panel-body { padding: 20px; }
.panel-body > h4 { margin: 22px 0 10px; color: #334155; font-size: 14px; }
.panel-body > h4:first-of-type { margin-top: 14px; }

.field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.browser-command-fields { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.field { display: grid; gap: 7px; }
.field label { color: #425466; font-size: 13px; font-weight: 600; }
.field input, .field select { width: 100%; min-height: 44px; padding: 9px 12px; border: 1px solid var(--line-strong); border-radius: 8px; color: var(--ink); background: var(--paper-bright); transition: border-color .18s ease, box-shadow .18s ease; }
.field input:hover, .field select:hover { border-color: #91caff; }
.field input::placeholder { color: #94a3b8; }
.field input:focus, .field select:focus { border-color: var(--navy); box-shadow: 0 0 0 3px rgba(22, 119, 255, .12); }
.account-picker { display: flex; align-items: center; position: relative; min-width: 0; min-height: 44px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--paper-bright); }
.account-picker:hover { border-color: #91caff; }
.account-picker:focus-within { border-color: var(--navy); box-shadow: 0 0 0 3px rgba(22, 119, 255, .12); }
.account-picker input { min-width: 0; flex: 1 1 auto; width: auto; overflow: hidden; border: 0; background: transparent; text-overflow: ellipsis; }
.account-picker input:focus-visible { outline: 0; }
.account-picker-toggle { flex: 0 0 40px; width: 40px; min-height: 38px; margin-right: 3px; padding: 6px; border: 0; border-radius: 6px; color: #526477; background: transparent; }
.account-picker-toggle:hover { color: var(--navy-hover); background: var(--blue-soft); }
.account-picker-menu { position: absolute; z-index: 60; top: calc(100% + 6px); right: 0; left: 0; max-height: 240px; overflow-y: auto; padding: 6px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--paper-bright); box-shadow: var(--shadow-raised); }
.account-picker-option { display: block; width: 100%; min-height: 40px; padding: 9px 10px; border: 0; border-radius: 6px; color: var(--ink); background: transparent; text-align: left; }
.account-picker-option[hidden] { display: none; }
.account-picker-option:hover { color: var(--navy-hover); background: var(--blue-soft); }
.form-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 10px; margin-top: 18px; padding-top: 16px; border-top: 1px solid #edf1f5; }
.primary { min-height: 44px; padding: 10px 18px; color: #fff; background: var(--navy-hover); box-shadow: 0 4px 12px rgba(22, 119, 255, .18); }
.primary:hover { background: #003eb3; box-shadow: 0 6px 16px rgba(22, 119, 255, .24); }
.secondary { min-height: 44px; padding: 9px 16px; border-color: var(--line-strong); color: #334155; background: var(--paper-bright); }
.secondary:hover { border-color: #91caff; color: var(--navy-hover); background: var(--blue-soft); }
.danger { border-color: #ffccc7; color: var(--red); background: var(--red-soft); }
.danger:hover { border-color: #ff7875; color: #a8071a; background: #ffe7e5; }
.message { min-height: 20px; margin: 14px 0 0; color: var(--red); font-size: 13px; }
.message.success { color: var(--green); }
.message.muted { color: var(--ink-soft); }

.table-wrap { max-width: 100%; overflow-x: auto; overscroll-behavior-inline: contain; }
.data-table { width: 100%; min-width: 680px; border-collapse: collapse; font-size: 13px; }
.data-table th { padding: 12px 10px; border-bottom: 1px solid var(--line); color: #526477; background: #f8fafc; font-size: 12px; font-weight: 600; text-align: left; white-space: nowrap; }
.data-table td { padding: 14px 10px; border-bottom: 1px solid #edf1f5; vertical-align: top; }
.data-table tbody tr { transition: background-color .15s ease; }
.data-table tbody tr:hover { background: #f7fbff; }
.data-table a { color: var(--navy-hover); font-weight: 600; text-decoration-thickness: 1px; text-underline-offset: 3px; }
.subtle { color: var(--ink-soft); font-size: 12px; }
.muted { color: var(--ink-soft); }
.status-pill { display: inline-flex; align-items: center; min-height: 26px; padding: 4px 9px; border: 1px solid #bae0ff; border-radius: 999px; color: #0958d9; background: #e6f4ff; font-size: 11px; font-weight: 600; white-space: nowrap; }
.status-pill.status-待人工, .status-pill.status-待人工确认 { border-color: #ffd591; color: #874d00; background: var(--amber-soft); }
.status-pill.status-已驳回 { border-color: #ffccc7; color: #a8071a; background: var(--red-soft); }
.status-pill.status-立案成功, .status-pill.status-强执成功, .status-pill.status-正常 { border-color: #b7ebc6; color: #17663d; background: var(--green-soft); }
.status-pill.status-login-pending { border-color: #ffd591; color: #874d00; background: var(--amber-soft); }
.status-pill.status-login-executing { border-color: #bae0ff; color: #0958d9; background: #e6f4ff; }
.status-pill.status-login-success { border-color: #b7ebc6; color: #17663d; background: var(--green-soft); }
.status-pill.status-login-failed, .status-pill.status-login-expired { border-color: #ffccc7; color: #a8071a; background: var(--red-soft); }
.row-actions { display: flex; flex-wrap: wrap; gap: 7px; }
.small-button { min-height: 34px; padding: 6px 10px; border-color: var(--line-strong); color: #425466; background: var(--paper-bright); font-size: 12px; }
.small-button:hover { border-color: #91caff; color: var(--navy-hover); background: var(--blue-soft); }
.small-button.danger { border-color: #ffccc7; color: var(--red); background: var(--red-soft); }
.small-button.danger:hover { border-color: #ff7875; color: #a8071a; background: #ffe7e5; }

.filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(156px, 1fr)); gap: 14px; align-items: end; }
.filters > .field { min-width: 0; }
.filter-actions { display: flex; gap: 8px; }
.filter-actions button { width: 100%; }
.case-status { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 44px; margin-bottom: 8px; color: var(--ink-soft); font-size: 12px; }
#case-retry { display: none; }

.detail-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.detail-grid[hidden] { display: none; }
.detail-item { padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: #f8fafc; }
.detail-item dt { margin-bottom: 7px; color: var(--ink-soft); font-size: 12px; font-weight: 600; }
.detail-item dd { margin: 0; color: var(--ink); font-size: 14px; line-height: 1.55; overflow-wrap: anywhere; }
.reason { white-space: pre-wrap; }
.screenshot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 16px; }
.screenshot-card { overflow: hidden; border: 1px solid var(--line); border-radius: 10px; background: var(--paper-bright); box-shadow: 0 2px 8px rgba(15, 42, 67, .05); }
.screenshot-card img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; background: #e8eef5; }
.screenshot-meta { display: grid; gap: 7px; padding: 12px; }
.screenshot-meta strong { font-size: 13px; font-weight: 700; }
.screenshot-actions { display: flex; gap: 8px; }
.screenshot-actions a { flex: 1; min-height: 36px; padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: 7px; color: var(--navy-hover); font-size: 12px; text-align: center; text-decoration: none; }
.screenshot-actions a:hover { border-color: #91caff; background: var(--blue-soft); }

.login-page { display: grid; min-height: 100dvh; place-items: center; padding: 24px; background: linear-gradient(135deg, #edf4fb 0%, #f7f9fc 56%, #eaf1f8 100%); }
.login-card { display: grid; grid-template-columns: minmax(280px, .88fr) minmax(360px, 1.12fr); width: min(920px, 100%); overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: var(--paper-bright); box-shadow: 0 24px 60px rgba(8, 38, 68, .14); }
.login-art { position: relative; display: flex; min-height: 500px; flex-direction: column; justify-content: flex-end; padding: 42px; overflow: hidden; color: #fff; background: linear-gradient(155deg, #124878 0%, var(--navy-deep) 62%, #071f38 100%); }
.login-art::before, .login-art::after { position: absolute; border: 1px solid rgba(159, 205, 250, .18); border-radius: 26px; content: ""; transform: rotate(36deg); }
.login-art::before { top: -84px; right: -86px; width: 260px; height: 260px; }
.login-art::after { right: 28px; bottom: 42px; width: 112px; height: 112px; }
.login-art h1 { position: relative; z-index: 1; margin: 12px 0 0; font-size: 34px; font-weight: 700; letter-spacing: .03em; }
.login-art p { position: relative; z-index: 1; max-width: 250px; margin: 14px 0 0; color: rgba(235, 244, 252, .72); font-size: 14px; line-height: 1.8; }
.login-form { align-self: center; padding: clamp(40px, 6vw, 72px); }
.login-form h2 { margin: 0; font-size: 28px; font-weight: 700; }
.login-form > p { margin: 10px 0 30px; color: var(--ink-soft); font-size: 14px; line-height: 1.7; }
.login-form .field + .field { margin-top: 16px; }
.login-form .primary { width: 100%; min-height: 46px; margin-top: 12px; }

.forbidden { max-width: 620px; margin: 12vh auto; padding: 48px; text-align: center; }
.forbidden h2 { margin: 0; color: var(--navy-deep); font-size: 52px; font-weight: 700; }
.forbidden p { color: var(--ink-soft); line-height: 1.8; }

@media (max-width: 960px) {
  body.sidebar-open { overflow: hidden; }
  .sidebar { width: min(var(--sidebar-width), 86vw); transform: translateX(-102%); box-shadow: none; }
  body.sidebar-open .sidebar { transform: translateX(0); box-shadow: 16px 0 38px rgba(6, 29, 52, .24); }
  .sidebar-scrim { position: fixed; z-index: 30; inset: 0; display: block; border: 0; background: rgba(6, 22, 38, .52); opacity: 0; transition: opacity .18s ease; }
  .sidebar-scrim[hidden] { display: none; }
  body.sidebar-open .sidebar-scrim { opacity: 1; }
  .content { margin-left: 0; padding: 18px 24px 48px; }
  .browser-command-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .topbar { justify-content: space-between; }
  .nav-toggle { display: inline-flex; }
  .sidebar-foot { position: relative; right: auto; bottom: auto; left: auto; margin: 38px 8px 0; }
  .page-head { margin-top: 14px; }
}

@media (max-width: 620px) {
  .content { padding: 14px 14px 40px; }
  .field-grid, .detail-grid, .filters { grid-template-columns: 1fr; }
  .page-head { display: block; margin-bottom: 18px; padding-bottom: 16px; }
  .page-head > .subtle { display: inline-block; margin-top: 14px; }
  .page-head h2 { font-size: 28px; }
  .panel-head { align-items: flex-start; flex-direction: column; gap: 12px; padding: 15px 16px; }
  .panel-head .row-actions { width: 100%; margin: 0; padding: 12px 0 0; border-top: 1px solid var(--line); border-left: 0; }
  .panel-head .row-actions > * { min-height: 44px; }
  .panel-body { padding: 16px; }
  .form-actions { align-items: stretch; flex-direction: column; }
  .form-actions button, .form-actions .button { width: 100%; }
  .small-button { min-height: 44px; }
  .case-status { align-items: stretch; flex-direction: column; }
  .case-status .row-actions { width: 100%; }
  .case-status .row-actions button { flex: 1; min-height: 44px; }
  .login-card { grid-template-columns: 1fr; }
  .login-art { min-height: 250px; padding: 30px 26px; }
  .login-art h1 { font-size: 30px; }
  .login-form { padding: 30px 24px; }
  .forbidden { margin: 8vh 14px; padding: 36px 22px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
}
`;

export const ADMIN_SCRIPT = String.raw`
const API_BASE = '/api/v1';
let csrfToken = null;
let currentSessionUser = null;
let casePollTimer = null;
let caseCursor = null;
let nextCaseCursor = null;
let nextReportExportCursor = null;
let appliedCasePlatformAccountId = null;
let appliedReportPlatformAccountId = null;
let caseAccountValidationMessage = null;
let reportAccountValidationMessage = null;
let browserControlImportBatches = [];
let platformAccountLoadGeneration = 0;
let importBatchLoadGeneration = 0;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function initNavigationDrawer() {
  const toggle = $('#sidebar-toggle');
  const sidebar = $('#admin-sidebar');
  const scrim = $('#sidebar-scrim');
  if (!toggle || !sidebar || !scrim) return;

  const desktopQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(min-width: 961px)')
    : null;
  let open = false;
  const setOpen = (nextOpen, restoreFocus = false) => {
    open = Boolean(nextOpen);
    document.body.classList.toggle('sidebar-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '关闭主菜单' : '打开主菜单');
    scrim.hidden = !open;
    const hiddenDrawer = desktopQuery ? !desktopQuery.matches && !open : false;
    sidebar.toggleAttribute('inert', hiddenDrawer);
    if (hiddenDrawer) sidebar.setAttribute('aria-hidden', 'true');
    else sidebar.removeAttribute('aria-hidden');
    if (!open && restoreFocus) toggle.focus();
  };
  const closeAndRestore = () => setOpen(false, true);

  toggle.addEventListener('click', () => setOpen(!open));
  scrim.addEventListener('click', closeAndRestore);
  $$('.nav a', sidebar).forEach((link) => link.addEventListener('click', closeAndRestore));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) closeAndRestore();
  });

  const handleViewportChange = (event) => {
    if (event.matches && open) setOpen(false);
    else setOpen(open);
  };
  desktopQuery?.addEventListener?.('change', handleViewportChange);
  window.addEventListener('pagehide', () => setOpen(false));
  setOpen(false);
}

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
    if (detailCode === 'template_limit_exceeded') return '模板超过限制：最多 5,000 行、21 列';
    if (detailCode === 'template_mismatch') return '模板不匹配，请使用新版 21 列立案与强执查询表';
    if (detailCode === 'sheet_required') return '模板缺少 Sheet1 工作表';
    if (detailCode === 'enforcement_header_required') return '旧版模板缺少强执表头，请改用新版 21 列模板';
    if (detailCode === 'mime_mismatch' || detailCode === 'magic_not_allowed') return '文件不是有效的 xlsx 模板';
    if (error.requestId) return '请求失败，请提供请求编号 ' + error.requestId;
  }
  return '请求失败，请稍后重试';
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const method = String(options.method || 'GET').toUpperCase();
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (csrfToken && ['POST', 'PATCH', 'DELETE'].includes(method)) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(API_BASE + path, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  const body = await response.json().catch(() => null);
  if (response.status === 401) {
    csrfToken = null;
    currentSessionUser = null;
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
    csrfToken = null;
    currentSessionUser = null;
    window.location.assign('/admin/login');
  });
}

function statusLabel(status) {
  return status === 'UNKNOWN' ? '待人工确认' : (status || '—');
}

function handlingStatusLabel(needsHuman) {
  return needsHuman ? '待人工' : '正常';
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
let platformAccountOptions = [];

async function loadPlatformLabels() {
  try {
    const result = await api('/platform-accounts');
    const accounts = result.platformAccounts || [];
    platformAccountOptions = accounts;
    platformLabels = new Map(accounts.map((account) => [account.id, account.label]));
    for (const [input, menu] of [
      [$('#case-account'), $('#case-account-menu')],
      [$('#report-export-account'), $('#report-export-account-menu')],
    ]) {
      fillPlatformAccountLabelList(input, menu, accounts, false, true);
    }
  } catch {
    platformAccountOptions = [];
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
    cell.colSpan = 9;
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
    const handlingLabel = handlingStatusLabel(item.needsHuman);
    const handlingCell = element('td');
    handlingCell.appendChild(element('span', handlingLabel, 'status-pill status-' + handlingLabel));
    row.appendChild(handlingCell);
    row.appendChild(element('td', item.kind === 'qz' ? '强执' : '立案'));
    row.appendChild(element('td', platformLabels.get(item.platformAccountId) || '—'));
    row.appendChild(element('td', item.rejectReason || '—'));
    row.appendChild(element('td', dateLabel(item.queryTime)));
    rows.appendChild(row);
  });
}

function caseQuery() {
  const params = new URLSearchParams();
  const fields = ['case-kind', 'case-status', 'case-human', 'case-from', 'case-to'];
  const names = ['kind', 'status', 'needsHuman', 'from', 'to'];
  fields.forEach((field, index) => {
    const input = $('#' + field);
    if (input && input.value) params.set(names[index], input.value);
  });
  if (appliedCasePlatformAccountId) params.set('platformAccountId', appliedCasePlatformAccountId);
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
    if (status) {
      if (caseAccountValidationMessage) setMessage(status, caseAccountValidationMessage);
      else setMessage(status, '已更新 · ' + dateLabel(new Date().toISOString()), 'muted');
    }
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
  const account = $('#case-account');
  const accountPicker = $('#case-account-picker');
  const accountToggle = $('#case-account-toggle');
  const accountMenu = $('#case-account-menu');
  const retry = $('#case-retry');
  const next = $('#case-next');
  if (retry) retry.textContent = '手动重试';
  if (next) next.style.display = 'none';
  bindAccountPicker(account, accountPicker, accountToggle, accountMenu);
  account?.addEventListener('input', () => { caseAccountValidationMessage = null; });
  if (filter) filter.addEventListener('submit', (event) => {
    event.preventDefault();
    const selected = resolveOptionalPlatformAccount(account?.value);
    if (selected === undefined) {
      caseAccountValidationMessage = '未找到唯一账号，请从平台账号列表中选择';
      setMessage($('[data-case-status]'), caseAccountValidationMessage);
      return;
    }
    caseAccountValidationMessage = null;
    appliedCasePlatformAccountId = selected?.id || null;
    if (selected) account.value = selected.label || '';
    caseCursor = null;
    nextCaseCursor = null;
    void loadCases();
  });
  if (retry) retry.addEventListener('click', () => { void loadCases(); });
  if (next) next.addEventListener('click', () => {
    if (nextCaseCursor === null) return;
    caseCursor = nextCaseCursor;
    void loadCases();
  });
  const requestedAccount = new URLSearchParams(window.location.search).get('platformAccountId');
  void loadPlatformLabels().then(() => {
    const requested = platformAccountOptions.find((option) => option.id === requestedAccount);
    if (account && requested) {
      account.value = requested.label || '';
      appliedCasePlatformAccountId = requested.id;
      caseCursor = null;
      nextCaseCursor = null;
      void loadCases();
    }
  });
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
  $('#platform-salesperson-mobile').value = '';
  $('#platform-assistant-mobile').value = '';
}

async function loadPlatformAccounts() {
  const generation = ++platformAccountLoadGeneration;
  const target = $('#platform-rows');
  const message = $('[data-platform-message]');
  try {
    const result = await api('/platform-accounts');
    if (generation !== platformAccountLoadGeneration) return;
    const accounts = result.platformAccounts || [];
    fillPlatformAccountLabelList($('#platform-list-account'), $('#platform-list-account-menu'), accounts, false, true);
    clear(target);
    accounts.forEach((account) => {
      const row = element('tr');
      row.dataset.id = account.id;
      row.dataset.enabled = String(account.enabled);
      row.dataset.accountLabel = account.label || '';
      row.dataset.contactsConfigured = String(account.contactsConfigured === true);
      row.appendChild(element('td', account.label));
      row.appendChild(element('td', account.enabled ? '启用' : '停用'));
      row.appendChild(element('td', account.contactsConfigured ? '已配置' : '未配置'));
      row.appendChild(element('td', dateLabel(account.updatedAt)));
      const actions = element('td', null, 'row-actions');
      actions.append(
        actionButton('编辑', 'edit-account', account.id),
        ...(account.contactsConfigured ? [actionButton('清除联系人', 'clear-account-contacts', account.id)] : []),
        actionButton(account.enabled ? '停用' : '启用', 'toggle-account', account.id),
        actionButton('删除', 'delete-account', account.id, 'small-button danger'),
      );
      row.appendChild(actions);
      target.appendChild(row);
    });
    filterPlatformAccountRows();
    setMessage(message, '已更新', 'success');
  } catch (error) {
    setMessage(message, errorMessage(error));
  }
}

function initPlatformAccounts() {
  const form = $('#platform-form');
  const list = $('#platform-rows');
  const cancel = $('#platform-cancel');
  const importForm = $('#platform-import-form');
  const listFilter = $('#platform-list-filters');
  const listAccount = $('#platform-list-account');
  bindAccountPicker(listAccount, $('#platform-list-account-picker'), $('#platform-list-account-toggle'), $('#platform-list-account-menu'));
  listAccount?.addEventListener('input', filterPlatformAccountRows);
  listFilter?.addEventListener('submit', (event) => { event.preventDefault(); filterPlatformAccountRows(); });
  if (importForm) importForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = $('#platform-import-file').files?.[0];
    if (!file) return;
    setFormBusy(importForm, true);
    try {
      const result = await api('/platform-accounts/import', { method: 'POST', body: new FormData(importForm) });
      const skipped = Number(result.skipped || 0);
      setMessage($('[data-platform-import-message]'), '导入完成：成功 ' + Number(result.imported || 0) + ' 条，跳过 ' + skipped + ' 条', skipped ? '' : 'success');
      importForm.reset();
      await loadPlatformAccounts();
    } catch (error) {
      setMessage($('[data-platform-import-message]'), errorMessage(error));
    } finally {
      setFormBusy(importForm, false);
    }
  });
  if (cancel) cancel.addEventListener('click', resetPlatformForm);
  if (form) form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const label = $('#platform-label').value.trim();
    const account = $('#platform-account').value;
    const password = $('#platform-password').value;
    const salespersonMobile = $('#platform-salesperson-mobile').value.trim();
    const assistantMobile = $('#platform-assistant-mobile').value.trim();
    if (!label || (!form.dataset.editId && (!account || !password)) || (account && !password) || (!account && password) || Boolean(salespersonMobile) !== Boolean(assistantMobile)) {
      setMessage($('[data-platform-message]'), '请完整填写标签和凭据');
      return;
    }
    setFormBusy(form, true);
    try {
      const payload = { label, enabled: $('#platform-enabled').value === 'true' };
      if (!form.dataset.editId || salespersonMobile || assistantMobile) {
        payload.salespersonMobile = salespersonMobile || null;
        payload.assistantMobile = assistantMobile || null;
      }
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
        $('#platform-salesperson-mobile').value = '';
        $('#platform-assistant-mobile').value = '';
        $('#platform-form').dataset.editId = id;
        $('#platform-form-title').textContent = '编辑平台账号';
        $('#credential-state').textContent = '已设置';
        $('#platform-label').focus();
        return;
      }
      if (button.dataset.action === 'toggle-account') {
        await api('/platform-accounts/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ enabled: row.dataset.enabled !== 'true' }) });
      } else if (button.dataset.action === 'clear-account-contacts') {
        if (!window.confirm('确认清除该平台账号绑定的业务员和助理手机号？')) return;
        await api('/platform-accounts/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ salespersonMobile: null, assistantMobile: null }) });
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
  if (appliedReportPlatformAccountId) params.set('platformAccountId', appliedReportPlatformAccountId);
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
      cell.colSpan = document.body.dataset.role === 'admin' ? 7 : 6;
      row.appendChild(cell);
      target.appendChild(row);
    }
    reportExports.forEach((reportExport) => {
      const row = element('tr');
      row.dataset.id = reportExport.id;
      row.dataset.fileName = reportExport.fileName || 'report-export.xlsx';
      const accountCell = element('td');
      const accountLink = element('a', platformLabels.get(reportExport.platformAccountId) || '历史记录');
      accountLink.href = reportExport.platformAccountId
        ? '/admin/cases?platformAccountId=' + encodeURIComponent(reportExport.platformAccountId)
        : '/admin/cases';
      accountCell.appendChild(accountLink);
      row.appendChild(accountCell);
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
    if (reportAccountValidationMessage) setMessage(message, reportAccountValidationMessage);
    else setMessage(message, '已更新', 'success');
  } catch (error) {
    if (reportAccountValidationMessage) setMessage(message, reportAccountValidationMessage);
    else setMessage(message, errorMessage(error));
  }
}

let browserCommandPollTimer = null;
let browserControlVisible = true;
let browserControlUserNames = null;
let browserControlAccounts = [];

function browserCommandStatusLabel(status) {
  const labels = { pending: '等待中', executing: '执行中', succeeded: '成功', failed: '失败', expired: '已过期', manual_required: '待人工', cancelled: '已取消' };
  return labels[status] || '未知状态';
}

function browserCommandTypeLabel(type) {
  const labels = {
    LOGIN: '统一登录',
    QUERY_LI: '立案查询',
    QUERY_QZ: '强执查询',
    QUERY_ALL_EXPORT: '一键查询并导出',
    EXPORT_REPORT: '报表导出',
  };
  return labels[type] || '未知任务';
}

function browserCommandResultLabel(code, summary) {
  const labels = {
    UNKNOWN: '未知结果',
    NEEDS_HUMAN: '需要人工处理',
    SESSION_EXPIRED: '会话已过期',
    AUTH_REQUIRED: '需要重新登录',
    ACCOUNT_DISABLED: '平台账号已停用',
    ACCOUNT_LABEL_UNAVAILABLE: '无法取得平台账号名称',
    CREDENTIAL_UNAVAILABLE: '平台账号凭据暂不可用',
    CREDENTIAL_FETCH_FAILED: '平台账号凭据获取失败',
    LOGIN_REDIRECT: '已跳转登录页',
    SELECTOR_CHANGED: '页面选择器已变化',
    API_REQUEST_FAILED: '接口请求失败',
  };
  const translated = labels[code] || (code ? String(code) : '');
  return [translated, summary].filter(Boolean).join(' / ') || '—';
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

function fillPlatformAccountLabelList(input, list, accounts, selectFirst = false, preserveQuery = false) {
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
  if (!preserveQuery && !accounts.some((account) => String(account.label || '').trim().toLocaleLowerCase('zh-CN') === normalizedSelected)) {
    input.value = selectFirst ? accounts[0]?.label || '' : '';
  }
  list.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  document.querySelectorAll('[aria-controls="' + list.id + '"]').forEach((control) => {
    control.setAttribute('aria-expanded', 'false');
  });
}

async function loadBrowserControlAccounts() {
  const taskInput = $('#browser-command-account');
  const taskLabels = $('#browser-command-account-menu');
  const loginInput = $('#platform-login-account');
  const loginLabels = $('#platform-login-account-menu');
  if (!taskInput && !loginInput) return;
  try {
    const result = await api('/platform-accounts');
    const allAccounts = result.platformAccounts || [];
    const enabledAccounts = allAccounts.filter((account) => account.enabled !== false);
    browserControlAccounts = allAccounts;
    fillPlatformAccountLabelList(taskInput, taskLabels, enabledAccounts);
    fillPlatformAccountLabelList(loginInput, loginLabels, enabledAccounts, true);
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

function resolveOptionalPlatformAccount(query) {
  if (!String(query || '').trim()) return null;
  return selectedBrowserAccount(query, platformAccountOptions) || undefined;
}

function filterPlatformAccountRows() {
  const query = String($('#platform-list-account')?.value || '').trim().toLocaleLowerCase('zh-CN');
  document.querySelectorAll('#platform-rows tr[data-account-label]').forEach((row) => {
    row.hidden = Boolean(query) && !String(row.dataset.accountLabel || '').toLocaleLowerCase('zh-CN').includes(query);
  });
}

function selectedEnabledBrowserAccount(query) {
  return selectedBrowserAccount(query, browserControlAccounts.filter((account) => account.enabled !== false));
}

function bindAccountPicker(input, picker, toggle, menu) {
  if (!input || !menu) return;
  const filterMenu = (useQuery = true) => {
    const query = useQuery ? String(input.value || '').trim().toLocaleLowerCase('zh-CN') : '';
    menu.querySelectorAll('[role="option"]').forEach((option) => {
      const label = String(option.dataset.platformAccountLabel || '').toLocaleLowerCase('zh-CN');
      option.hidden = Boolean(query) && !label.includes(query);
    });
  };
  const closeMenu = () => {
    menu.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    toggle?.setAttribute('aria-expanded', 'false');
  };
  const openMenu = (showAll = false) => {
    filterMenu(!showAll);
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    toggle?.setAttribute('aria-expanded', 'true');
  };
  input.addEventListener('input', () => {
    if (input.value.trim()) openMenu();
    else closeMenu();
  });
  toggle?.addEventListener('click', (event) => {
    event.preventDefault();
    if (menu.hidden) openMenu(true);
    else closeMenu();
    input.focus();
  });
  menu.addEventListener('click', (event) => {
    const option = event.target.closest('[role="option"]');
    if (!option) return;
    input.value = option.dataset.platformAccountLabel || '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    closeMenu();
  });
  document.addEventListener('click', (event) => {
    if (picker && !picker.contains(event.target)) closeMenu();
  });
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
  const generation = ++importBatchLoadGeneration;
  const target = $('#import-batch-rows');
  const select = $('#browser-command-batch');
  if (!target || !select) return;
  try {
    const result = await api('/import-batches?limit=100');
    if (generation !== importBatchLoadGeneration) return;
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
      row.append(accountCell, element('td', browserCommandTypeLabel(command.type)), element('td', browserCommandStatusLabel(command.status), 'status-pill'), element('td', browserCommandProgressLabel(command.progress)), element('td', browserCommandResultLabel(command.resultCode, command.resultSummary)), creator, element('td', dateLabel(command.createdAt)));
      const actions = element('td', null, 'row-actions');
      if (['pending', 'executing'].includes(command.status) && command.requestedBy === currentSessionUser?.id) actions.append(actionButton('取消', 'cancel-browser-command', command.id, 'small-button danger'));
      if (['failed', 'manual_required', 'expired'].includes(command.status)) actions.append(actionButton('重试', 'retry-browser-command', command.id));
      if (command.type === 'QUERY_ALL_EXPORT' && ['succeeded', 'failed', 'expired', 'manual_required', 'cancelled'].includes(command.status)) actions.append(actionButton('删除', 'delete-browser-command', command.id, 'small-button danger'));
      row.appendChild(actions); target.appendChild(row);
    });
    if (!target.firstChild) { const row = element('tr'); const cell = element('td', '暂无浏览器任务'); cell.colSpan = 8; row.appendChild(cell); target.appendChild(row); }
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
  const accountPicker = $('#browser-command-account-picker');
  const accountToggle = $('#browser-command-account-toggle');
  const accountMenu = $('#browser-command-account-menu');
  const batch = $('#browser-command-batch');
  const salesperson = $('#browser-command-salesperson');
  let credentialRequestGeneration = 0;
  const invalidatePlatformCredential = () => {
    credentialRequestGeneration += 1;
    clearPlatformCredential();
  };
  document.addEventListener('visibilitychange', () => { browserControlVisible = document.visibilityState === 'visible'; if (browserControlVisible) void loadBrowserCommands(); });
  window.addEventListener('pagehide', invalidatePlatformCredential);
  loginAccount?.addEventListener('input', invalidatePlatformCredential);
  loginAccount?.addEventListener('change', invalidatePlatformCredential);
  bindAccountPicker(loginAccount, loginAccountPicker, loginAccountToggle, loginAccountMenu);
  bindAccountPicker(account, accountPicker, accountToggle, accountMenu);
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
  salesperson.required = true;
  commandForm?.addEventListener('submit', async (event) => {
    event.preventDefault(); const selected = selectedEnabledBrowserAccount(account.value); const platformAccountId = selected?.id || null; const importBatchId = batch.value || null; const salespersonName = salesperson.value.trim();
    if (!selected) { setMessage($('[data-browser-command-message]'), '请从启用平台账号标签提示中选择'); return; }
    if (!importBatchId) { setMessage($('[data-browser-command-message]'), '一键任务必须选择空白导入批次'); return; }
    if (!salespersonName) { setMessage($('[data-browser-command-message]'), '请输入业务员'); return; }
    if (salespersonName.length > 100) { setMessage($('[data-browser-command-message]'), '业务员最多 100 个字符'); return; }
    account.value = selected.label || '';
    salesperson.value = salespersonName;
    setFormBusy(commandForm, true);
    try { await api('/browser-commands', { method: 'POST', body: JSON.stringify({ type: 'QUERY_ALL_EXPORT', platformAccountId, importBatchId, payload: { salesperson: salespersonName } }) }); setMessage($('[data-browser-command-message]'), '一键查询导出任务已创建', 'success'); await loadBrowserCommands(); }
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
  const filters = $('#report-export-filters');
  const account = $('#report-export-account');
  bindAccountPicker(account, $('#report-export-account-picker'), $('#report-export-account-toggle'), $('#report-export-account-menu'));
  account?.addEventListener('input', () => { reportAccountValidationMessage = null; });
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
  if (filters) filters.addEventListener('submit', (event) => {
    event.preventDefault();
    const selected = resolveOptionalPlatformAccount(account?.value);
    if (selected === undefined) {
      reportAccountValidationMessage = '未找到唯一账号，请从平台账号列表中选择';
      setMessage(message, reportAccountValidationMessage);
      return;
    }
    reportAccountValidationMessage = null;
    appliedReportPlatformAccountId = selected?.id || null;
    if (selected) account.value = selected.label || '';
    nextReportExportCursor = null;
    void loadReportExports();
  });
  void loadPlatformLabels().finally(() => loadReportExports());
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

async function loadWecomNotifications() {
  const list = $('#wecom-notification-list');
  if (!list) return;
  const message = $('[data-wecom-message]');
  const result = await api('/cases/' + encodeURIComponent(document.body.dataset.caseId) + '/wecom-notifications');
  clear(list);
  const notifications = result.notifications || [];
  if (!notifications.length) { setMessage(message, '当前案件尚无自动推送记录'); return; }
  notifications.forEach((notification) => {
    const item = element('div', null, 'detail-item');
    item.appendChild(element('dt', notification.resultStatus));
    const retryable = notification.status === 'failed' && notification.attemptCount < 2;
    const status = notification.status === 'sent' ? '已推送' : retryable ? '推送失败，待人工重试' : notification.status === 'failed' ? '推送失败，已达重试上限' : '正在处理';
    item.appendChild(element('dd', status));
    if (retryable) item.appendChild(actionButton('人工重试', 'retry-wecom', notification.id));
    list.appendChild(item);
  });
}

function initWecomNotification() {
  const list = $('#wecom-notification-list');
  if (!list) return;
  list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action="retry-wecom"]');
    if (!button || !window.confirm('确认人工重试本条企业微信通知？')) return;
    button.disabled = true;
    try { await api('/wecom-notifications/' + encodeURIComponent(button.dataset.id) + '/retry', { method: 'POST' }); await loadWecomNotifications(); }
    catch (error) { setMessage($('[data-wecom-message]'), errorMessage(error)); }
    finally { button.disabled = false; }
  });
  void loadWecomNotifications();
}

async function initPage() {
  const page = document.body.dataset.page;
  initNavigationDrawer();
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
    else if (page === 'case-detail') { initWecomNotification(); void loadCaseDetail(); }
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
