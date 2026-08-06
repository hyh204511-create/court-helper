// court-panel.js — 网页浮动面板（规格 docs/specs/panel-module.md）
// 折叠式：默认右下角悬浮球，点击展开状态面板（Shadow DOM 隔离样式）。
// - 登录由后台统一命令驱动：面板只显示登录状态（脱敏账号），不触发登录；
// - 状态禁猜：未知一律待人工，面板不猜测；
// - 后台是唯一业务入口；面板降级为状态、进度与人工接管提示。

/** 账号脱敏：首尾各 1 位 + ***；≤2 位整体掩码；空值返回空 */
export function maskAccount(account) {
  if (!account) return "";
  const s = String(account).trim();
  if (s.length <= 1) return "*";
  if (s.length === 2) return `${s[0]}*`;
  return `${s[0]}***${s[s.length - 1]}`;
}

const SHELL_HTML = `
  <style>
    *{box-sizing:border-box;margin:0;padding:0}button,input,select{font:inherit}
    .fab{position:fixed;right:16px;bottom:16px;width:48px;height:48px;border-radius:50%;
      background:#1e3a5f;color:#fff;border:1px solid #3d5f8f;cursor:pointer;
      box-shadow:0 4px 14px rgba(0,0,0,.35);font-size:18px;z-index:2147483647;
      display:flex;align-items:center;justify-content:center;user-select:none}
    .fab:hover{background:#2a4d7d}
    .shell{position:fixed;right:16px;bottom:72px;width:420px;max-height:82vh;overflow:hidden;
      display:flex;flex-direction:column;color:#eaf2f8;background:#102333;
      border:1px solid #36536a;border-radius:10px;box-shadow:0 18px 48px rgba(0,0,0,.55);
      font:13px/1.5 "Microsoft YaHei",sans-serif;z-index:2147483647}
    .shell.collapsed{display:none}
    .top{flex:none;display:flex;align-items:center;justify-content:space-between;
      padding:11px 14px;background:#0b1b27;border-bottom:1px solid #ffffff16}
    .brand{font-weight:700;letter-spacing:.02em}
    .login-status{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#8eacbf}
    .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#8eacbf}
    .login-status.ok .dot{background:#46d69a}.login-status.ok{color:#b8f5db}
    .login-status.bad .dot{background:#f17068}.login-status.bad{color:#ffc6c2}
    .collapse{width:26px;height:24px;background:#224159;border:1px solid #ffffff18;
      border-radius:6px;color:#dbeaf5;cursor:pointer}
    .body{min-height:0;overflow-y:auto;padding:12px}
    .notice{padding:8px 10px;margin-bottom:10px;border-left:3px solid #f0b35b;
      background:#f0b35b16;color:#ffdca8;font-size:12px}
    .notice.bad{border-color:#f17068;background:#f1706813;color:#ffc6c2}
    .progress-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;font-size:12px;color:#8eacbf}
    .bar{height:8px;border-radius:4px;background:#152d40;overflow:hidden;margin-bottom:10px}
    .bar > i{display:block;height:100%;width:0;background:#46d69a;transition:width .3s}
    .groups{display:grid;gap:5px;margin-bottom:10px;font-size:12px}
    .groups .g{display:flex;justify-content:space-between;padding:5px 8px;background:#152d40;border-radius:6px;color:#cfe4f2}
    .sync-box{padding:9px 10px;margin-bottom:10px;border:1px solid #ffffff12;border-radius:7px;background:#0d2030}
    .sync-head,.sync-meta{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .sync-head{color:#cfe4f2;font-weight:600}.sync-meta{margin-top:4px;color:#8eacbf;font-size:11px}
    .sync-state{font-weight:400;color:#8eacbf}.sync-state.ok{color:#b8f5db}.sync-state.bad{color:#ffc6c2}
    .sync-unavailable{padding-top:6px;color:#ffc6c2;font-size:12px}
    .btn-sync-retry{width:100%;margin-top:7px;padding:6px;border:1px solid #ffffff18;border-radius:6px;
      color:#dbeaf5;background:#224159;cursor:pointer}.btn-sync-retry:hover{background:#2d526d}
    .sync-conflicts{margin-top:8px;color:#ffdca8;font-size:12px}.sync-conflicts ul{display:grid;gap:3px;margin:4px 0 0 15px;color:#ffc6c2}
    .hidden{display:none!important}
    .foot{flex:none;padding:7px 12px;color:#6f8ea2;background:#0b1b27;
      border-top:1px solid #ffffff12;font-size:11px}
  </style>
  <button class="fab" title="法院立案/强执查询助手">法</button>
  <section class="shell collapsed">
    <header class="top">
      <span class="brand">法院立案/强执查询助手</span>
      <span class="login-status off"><i class="dot"></i><span class="login-text">未登录</span></span>
      <button class="collapse" title="收起">−</button>
    </header>
    <div class="body">
      <div class="notice">业务操作请前往后台控制台；本面板仅显示状态、进度与人工接管提示。</div>
      <section class="sync-box" aria-live="polite">
        <div class="sync-head"><span>服务器同步</span><span class="sync-state">未配置</span></div>
        <div class="sync-meta"><span class="sync-pending">待上传: 0</span><span class="sync-last">最后同步: -</span></div>
        <div class="sync-unavailable hidden"></div>
        <button class="btn-sync-retry hidden" type="button">重试同步</button>
        <div class="sync-conflicts hidden"><span>冲突列表</span><ul></ul></div>
      </section>
      <div class="progress-head"><span class="progress-text">待处理: -</span></div>
      <div class="bar"><i></i></div>
      <div class="groups"></div>
    </div>
    <footer class="foot">后台唯一业务入口 · 未知状态标记待人工</footer>
  </section>`;

/**
 * 创建并挂载浮动面板。
 * @param {object} opts
 * @param {Document} opts.document 目标页面 document
 * @param {object} [opts.handlers] {onSyncRetry}
 * @param {'open'|'closed'} [opts.shadowMode] 测试可传 'open' 以便断言；默认 'closed'
 * @returns {object} { host, setLogin, setProgress, setReady, setSyncStatus }
 */
export function createCourtPanel({ document, handlers = {}, shadowMode = "closed" }) {
  const host = document.createElement("div");
  host.id = "court-helper-panel-root";
  host.style.cssText = "all:initial;position:static";
  const shadow = host.attachShadow({ mode: shadowMode });
  shadow.innerHTML = SHELL_HTML;

  const shell = shadow.querySelector(".shell");
  const fab = shadow.querySelector(".fab");
  const collapse = shadow.querySelector(".collapse");
  const statusEl = shadow.querySelector(".login-status");
  const loginText = shadow.querySelector(".login-text");
  const notice = shadow.querySelector(".notice");
  const progressText = shadow.querySelector(".progress-text");
  const bar = shadow.querySelector(".bar > i");
  const groupsEl = shadow.querySelector(".groups");
  const syncStateText = shadow.querySelector(".sync-state");
  const syncPending = shadow.querySelector(".sync-pending");
  const syncLast = shadow.querySelector(".sync-last");
  const syncUnavailable = shadow.querySelector(".sync-unavailable");
  const syncRetry = shadow.querySelector(".btn-sync-retry");
  const syncConflicts = shadow.querySelector(".sync-conflicts");
  const syncConflictList = syncConflicts.querySelector("ul");

  const toggle = () => shell.classList.toggle("collapsed");
  fab.addEventListener("click", toggle);
  collapse.addEventListener("click", toggle);

  syncRetry.addEventListener("click", () => (handlers.onSyncRetry ?? handlers.onRetrySync)?.());

  /** @param {{state: 'login'|'logged-in'|'session-expired'|'unknown', account?: string|null}} s */
  function setLogin({ state, account = null }) {
    statusEl.classList.remove("ok", "bad", "off");
    if (state === "logged-in") {
      statusEl.classList.add("ok");
      loginText.textContent = `${maskAccount(account) || "已登录"}`;
    } else if (state === "session-expired") {
      statusEl.classList.add("bad");
      loginText.textContent = "已过期，请重新登录";
    } else {
      statusEl.classList.add("off");
      loginText.textContent = "未登录";
    }
  }

  /** @param {{done?: number, total?: number, groups?: Array<{account: string, count: number}>}} p */
  function setProgress({ done = 0, total = 0, groups = [] } = {}) {
    progressText.textContent = total ? `待处理: ${done}/${total}` : "待处理: -";
    bar.style.width = total ? `${Math.min(100, Math.round((done / total) * 100))}%` : "0%";
    groupsEl.textContent = "";
    for (const group of Array.isArray(groups) ? groups : []) {
      const row = shadow.ownerDocument.createElement("div");
      row.className = "g";
      const account = shadow.ownerDocument.createElement("span");
      account.textContent = maskAccount(group?.account);
      const count = shadow.ownerDocument.createElement("span");
      const numericCount = Number(group?.count);
      count.textContent = `${Number.isFinite(numericCount) ? Math.max(0, numericCount) : 0} 条`;
      row.append(account, count);
      groupsEl.appendChild(row);
    }
  }

  /** 同步状态只接收已脱敏的摘要，不在面板渲染凭据、截图或业务明文。 */
  function setSyncStatus({
    status = "idle",
    pendingCount = 0,
    lastSyncAt = null,
    conflicts = [],
    message = "",
  } = {}) {
    const labels = {
      disabled: "未配置",
      idle: "待同步",
      syncing: "同步中",
      online: "在线",
      offline: "不可达",
      paused: "已暂停",
      error: "需重试",
    };
    syncStateText.textContent = labels[status] ?? "待同步";
    syncStateText.classList.toggle("ok", status === "online");
    syncStateText.classList.toggle("bad", status === "offline" || status === "error");
    syncPending.textContent = `待上传: ${Number.isFinite(pendingCount) ? Math.max(0, pendingCount) : 0}`;
    syncLast.textContent = `最后同步: ${lastSyncAt ? String(lastSyncAt) : "-"}`;

    const unavailable = status === "offline";
    syncUnavailable.textContent = unavailable ? (message || "服务器不可达，请重试") : "";
    syncUnavailable.classList.toggle("hidden", !unavailable);
    syncRetry.classList.toggle("hidden", !unavailable && status !== "error");

    syncConflictList.textContent = "";
    const safeConflicts = Array.isArray(conflicts) ? conflicts.slice(0, 50) : [];
    syncConflicts.classList.toggle("hidden", safeConflicts.length === 0);
    for (const conflict of safeConflicts) {
      const item = shadow.ownerDocument.createElement("li");
      const code = typeof conflict?.code === "string" ? conflict.code : "CONFLICT";
      const id = typeof conflict?.id === "string" ? conflict.id : "待人工项";
      item.textContent = `${code} · ${id}`;
      syncConflictList.appendChild(item);
    }
  }

  const setSyncState = setSyncStatus;

  /** @param {boolean} ready 采集器（content script）是否就绪 */
  function setReady(ready) {
    if (ready) {
      notice.textContent = "业务操作请前往后台控制台；本面板仅显示状态、进度与人工接管提示。";
      notice.classList.remove("hidden");
      notice.classList.remove("bad");
    } else {
      notice.textContent = "采集器未就绪，请刷新页面后重试";
      notice.classList.remove("hidden");
      notice.classList.add("bad");
    }
  }

  function mount() {
    if (!document.documentElement.contains(host)) document.documentElement.appendChild(host);
  }
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });

  return { host, setLogin, setProgress, setReady, setSyncStatus, setSyncState };
}
