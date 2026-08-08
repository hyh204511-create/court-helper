export type AdminPage = 'login' | 'users' | 'platform-accounts' | 'cases' | 'case-detail' | 'report-exports' | 'browser-control' | 'forbidden';
export type AdminRole = 'admin' | 'user';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function navFor(role: AdminRole, page: AdminPage): string {
  if (role === 'user') {
    return `<nav class="nav" aria-label="主导航">
      <a href="/admin/cases"${page === 'cases' || page === 'case-detail' ? ' aria-current="page"' : ''}>案件台账</a>
      <a href="/admin/report-exports"${page === 'report-exports' ? ' aria-current="page"' : ''}>报表导出</a>
      <a href="/admin/browser-control"${page === 'browser-control' ? ' aria-current="page"' : ''}>浏览器控制</a>
    </nav>`;
  }
  return `<nav class="nav" aria-label="主导航">
    <a href="/admin/cases"${page === 'cases' || page === 'case-detail' ? ' aria-current="page"' : ''}>案件台账</a>
    <a href="/admin/report-exports"${page === 'report-exports' ? ' aria-current="page"' : ''}>报表导出</a>
    <a href="/admin/browser-control"${page === 'browser-control' ? ' aria-current="page"' : ''}>浏览器控制</a>
    <a href="/admin/users"${page === 'users' ? ' aria-current="page"' : ''}>系统用户</a>
    <a href="/admin/platform-accounts"${page === 'platform-accounts' ? ' aria-current="page"' : ''}>平台账号</a>
  </nav>`;
}

function layout(page: AdminPage, role: AdminRole, title: string, main: string, caseId?: string): string {
  const caseAttribute = caseId === undefined ? '' : ` data-case-id="${escapeHtml(caseId)}"`;
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} · 案件台账</title>
    <link rel="stylesheet" href="/admin/assets/admin.css">
    <script type="module" src="/admin/assets/admin.js" defer></script>
  </head>
  <body data-page="${page}" data-role="${role}"${caseAttribute}>
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">Court Helper / Registry</div>
          <h1>案件台账</h1>
          <p>保留期内的立案与强执结果，集中查看、核验与取证。</p>
        </div>
        ${navFor(role, page)}
        <div class="sidebar-foot">内部工作台<br>数据按服务端保留策略管理</div>
      </aside>
      <main class="content">
        <div class="topbar"><button id="logout-button" class="logout" type="button">退出登录</button></div>
        ${main}
      </main>
    </div>
  </body>
</html>`;
}

function loginPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>登录 · 案件台账</title>
    <link rel="stylesheet" href="/admin/assets/admin.css">
    <script type="module" src="/admin/assets/admin.js" defer></script>
  </head>
  <body data-page="login" data-role="user">
    <main class="login-page">
      <section class="login-card" aria-labelledby="login-title">
        <div class="login-art">
          <div class="brand-mark">Court Helper / Registry</div>
          <h1>案件台账</h1>
          <p>面向内部工作人员的案件查询、状态核验与截图存证工作台。</p>
        </div>
        <form id="login-form" class="login-form">
          <h2 id="login-title">欢迎回来</h2>
          <p>使用系统账号登录。凭据只通过同源安全连接提交。</p>
          <div class="field">
            <label for="login-username">用户名</label>
            <input id="login-username" name="username" type="text" autocomplete="username" required maxlength="100">
          </div>
          <div class="field">
            <label for="login-password">密码</label>
            <input id="login-password" name="password" type="password" autocomplete="current-password" required maxlength="200">
          </div>
          <button class="primary" type="submit">进入台账</button>
          <p class="message" data-login-message aria-live="polite"></p>
        </form>
      </section>
    </main>
  </body>
</html>`;
}

function usersPage(): string {
  return layout('users', 'admin', '系统用户', `
    <header class="page-head">
      <div><p class="eyebrow">Access / People</p><h2>系统用户</h2><p>管理内部登录身份、角色与会话状态。密码只在创建或重置时输入。</p></div>
    </header>
    <section class="panel" aria-labelledby="new-user-title">
      <div class="panel-head"><div><h3 id="new-user-title">新增用户</h3><p>提交成功后重新从服务器读取列表。</p></div></div>
      <div class="panel-body">
        <form id="user-form">
          <div class="field-grid">
            <div class="field"><label for="user-username">用户名</label><input id="user-username" type="text" autocomplete="username" required maxlength="100"></div>
            <div class="field"><label for="user-role">角色</label><select id="user-role"><option value="user">用户</option><option value="admin">管理员</option></select></div>
            <div class="field"><label for="user-password">初始密码</label><input id="user-password" type="password" autocomplete="new-password" required maxlength="200"></div>
          </div>
          <div class="form-actions"><button class="primary" type="submit">创建用户</button></div>
        </form>
        <p class="message" data-user-message aria-live="polite"></p>
      </div>
    </section>
    <section class="panel" aria-labelledby="user-list-title">
      <div class="panel-head"><div><h3 id="user-list-title">账号列表</h3><p>支持改名、角色调整、停用、软删除与重置密码；服务端再次校验最后一个管理员保护。</p></div></div>
      <div class="panel-body table-wrap"><table class="data-table"><thead><tr><th>用户名</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody id="user-rows"></tbody></table></div>
    </section>`);
}

function platformAccountsPage(): string {
  return layout('platform-accounts', 'admin', '平台账号', `
    <header class="page-head">
      <div><p class="eyebrow">Sources / Credentials</p><h2>平台账号</h2><p>维护扩展使用的平台账号标签与启停状态；登录和按需查看凭据统一在浏览器控制台完成。</p></div>
    </header>
    <section class="panel" aria-labelledby="platform-form-title">
      <div class="panel-head"><div><h3 id="platform-form-title">新增平台账号</h3><p>编辑时只替换凭据，不会回显已有内容；已有记录仅显示“已设置”，新建表单显示“未设置”。</p></div><span class="subtle">凭据：<strong id="credential-state">未设置</strong></span></div>
      <div class="panel-body">
        <form id="platform-form">
          <div class="field-grid">
            <div class="field"><label for="platform-label">显示标签</label><input id="platform-label" type="text" required maxlength="100"></div>
            <div class="field"><label for="platform-account">平台账号</label><input id="platform-account" type="text" autocomplete="new-password" maxlength="200"></div>
            <div class="field"><label for="platform-password">平台密码</label><input id="platform-password" type="password" autocomplete="new-password" maxlength="200"></div>
            <div class="field"><label for="platform-enabled">状态</label><select id="platform-enabled"><option value="true">启用</option><option value="false">停用</option></select></div>
          </div>
          <div class="form-actions"><button class="primary" type="submit">保存平台账号</button><button id="platform-cancel" class="secondary" type="button">清空</button></div>
        </form>
        <p class="message" data-platform-message aria-live="polite"></p>
      </div>
    </section>
    <section class="panel" aria-labelledby="platform-list-title">
      <div class="panel-head"><div><h3 id="platform-list-title">账号列表</h3><p>列表和普通响应只返回标签、状态与更新时间。</p></div></div>
      <div class="panel-body table-wrap"><table class="data-table"><thead><tr><th>标签</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody id="platform-rows"></tbody></table></div>
    </section>`);
}

function casesPage(role: AdminRole): string {
  return layout('cases', role, '案件台账', `
    <header class="page-head">
      <div><p class="eyebrow">Cases / Retained Window</p><h2>案件台账</h2><p>显示服务端当前保留期内的结果。页面可见时自动刷新，隐藏页面时暂停。</p></div>
    </header>
    <section class="panel" aria-labelledby="case-filter-title">
      <div class="panel-head"><div><h3 id="case-filter-title">筛选案件</h3><p>筛选条件和当前页由浏览器保留，轮询不会自动跳页。</p></div></div>
      <div class="panel-body">
        <form id="case-filters" class="filters">
          <div class="field"><label for="case-kind">类型</label><select id="case-kind"><option value="">全部</option><option value="li">立案</option><option value="qz">强执</option></select></div>
          <div class="field"><label for="case-status">状态</label><select id="case-status"><option value="">全部</option><option value="立案成功">立案成功</option><option value="强执成功">强执成功</option><option value="已驳回">已驳回</option><option value="审核中">审核中</option><option value="UNKNOWN">待人工</option></select></div>
          <div class="field"><label for="case-account">平台账号</label><select id="case-account"><option value="">全部平台账号</option></select></div>
          <div class="field"><label for="case-human">待人工</label><select id="case-human"><option value="">全部</option><option value="true">是</option><option value="false">否</option></select></div>
          <div class="field"><label for="case-from">起始日期</label><input id="case-from" type="date"></div>
          <div class="field"><label for="case-to">结束日期</label><input id="case-to" type="date"></div>
          <div class="filter-actions"><button class="primary" type="submit">应用筛选</button></div>
        </form>
      </div>
    </section>
    <section class="panel" aria-labelledby="case-list-title">
      <div class="panel-head"><div><h3 id="case-list-title">案件列表</h3><p>驳回原因按纯文本显示，未知状态保持“待人工”。</p></div></div>
      <div class="panel-body">
        <div class="case-status"><span data-case-status class="message muted" aria-live="polite">准备读取</span><span class="row-actions"><button id="case-retry" class="secondary" type="button">手动重试</button><button id="case-next" class="secondary" type="button">下一页</button></span></div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>案号</th><th>原告</th><th>被告</th><th>状态</th><th>类型</th><th>平台账号</th><th>驳回原因</th><th>查询时间</th></tr></thead><tbody id="case-rows"></tbody></table></div>
      </div>
    </section>`);
}

function caseDetailPage(role: AdminRole, caseId: string): string {
  return layout('case-detail', role, '案件详情', `
    <header class="page-head">
      <div><p class="eyebrow">Case / Read Only</p><h2>案件详情</h2><p>只读查看案件字段与授权截图，状态不会由页面推断或改写。</p></div>
      <a class="button secondary" href="/admin/cases">返回案件列表</a>
    </header>
    <section class="panel" aria-labelledby="detail-title">
      <div class="panel-head"><div><h3 id="detail-title">案件信息</h3><p>案件 ID：${escapeHtml(caseId)}</p></div></div>
      <div class="panel-body"><div id="case-fields" class="detail-grid"></div><p class="message" data-detail-message aria-live="polite"></p></div>
    </section>
    <section class="panel" aria-labelledby="screenshot-title">
      <div class="panel-head"><div><h3 id="screenshot-title">截图存证</h3><p>内容经鉴权 API 查看或下载，不暴露存储内部信息。</p></div></div>
      <div class="panel-body"><div id="screenshot-list" class="screenshot-grid"></div></div>
    </section>`, caseId);
}

function reportExportsPage(role: AdminRole): string {
  const exporterColumn = role === 'admin' ? '<th>导出人</th>' : '';
  return layout('report-exports', role, '报表导出', `
    <header class="page-head">
      <div><p class="eyebrow">Exports / Retained Files</p><h2>报表导出</h2><p>查看保留期内的报表文件，按权限鉴权下载或删除。</p></div>
    </header>
    <section class="panel" aria-labelledby="report-export-list-title">
      <div class="panel-head"><div><h3 id="report-export-list-title">导出记录</h3><p>文件内容不在页面缓存；下载由当前会话直接鉴权。</p></div></div>
      <div class="panel-body">
        <div class="case-status"><span data-report-export-message class="message muted" aria-live="polite">准备读取</span></div>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>文件名</th><th>大小</th><th>SHA256</th>${exporterColumn}<th>导出时间</th><th>操作</th></tr></thead><tbody id="report-export-rows"></tbody></table></div>
      </div>
    </section>`);
}

function browserControlPage(role: AdminRole): string {
  const extensionAuthorization = role === 'admin' ? `
    <section class="panel" aria-labelledby="extension-authorization-title">
      <div class="panel-head"><div><h3 id="extension-authorization-title">扩展设备授权</h3><p>扩展会自行发起一次性配对请求。请核对扩展显示的六码后批准；设备只能执行业务操作，不能管理系统用户。</p></div></div>
      <div class="panel-body">
        <p class="message muted" data-extension-authorization-message aria-live="polite">准备读取</p>
        <h4>待批准请求</h4>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>设备</th><th>标签</th><th>过期时间</th><th>核对码</th><th>操作</th></tr></thead><tbody id="extension-pairing-list"></tbody></table></div>
        <h4>已授权设备</h4>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>设备</th><th>标签</th><th>最近在线</th><th>状态</th><th>操作</th></tr></thead><tbody id="extension-device-list"></tbody></table></div><div class="form-actions"><button id="extension-device-delete-all" class="small-button danger" type="button">一键删除所有设备</button></div>
      </div>
    </section>` : '';
  return layout('browser-control', role, '浏览器控制', `
    <header class="page-head"><div><p class="eyebrow">Browser / Commands</p><h2>浏览器控制</h2><p>登录、导入、查询和导出的唯一业务入口。任务由扩展在已打开的法院标签页执行。</p></div><p class="subtle">当前后台用户：<strong id="current-backoffice-user">加载中…</strong></p></header>
    <section class="panel" aria-labelledby="platform-login-title">
      <div class="panel-head"><div><h3 id="platform-login-title">平台账号与自动登录</h3><p>选择启用账号后创建统一 LOGIN 命令；完整凭据只在本页按需查看，不进入任务负载。</p></div></div>
      <div class="panel-body">
        <form id="platform-login-form">
          <div class="field-grid"><div class="field"><label for="platform-login-account">平台账号</label><div class="account-picker" id="platform-login-account-picker"><input id="platform-login-account" type="search" autocomplete="off" placeholder="输入账号标签或关键词" role="combobox" aria-autocomplete="list" aria-controls="platform-login-account-menu" aria-expanded="false" required><button id="platform-login-account-toggle" class="account-picker-toggle" type="button" aria-label="展开平台账号列表" aria-controls="platform-login-account-menu" aria-expanded="false">▼</button><div id="platform-login-account-menu" class="account-picker-menu" role="listbox" hidden></div></div></div></div>
          <div class="form-actions"><button class="primary" type="submit">一键登录</button><button class="secondary" id="platform-credential-show" type="button">查看账号与密码</button><button class="secondary" id="platform-credential-hide" type="button">关闭凭据</button></div>
        </form>
        <div id="platform-credential-view" class="detail-grid" hidden><dl class="detail-item"><dt>平台账号</dt><dd id="platform-credential-account"></dd></dl><dl class="detail-item"><dt>平台密码</dt><dd id="platform-credential-password"></dd></dl></div>
        <p class="message" data-platform-login-message aria-live="polite"></p>
      </div>
    </section>
    ${extensionAuthorization}
    <section class="panel" aria-labelledby="browser-command-title">
      <div class="panel-head"><div><h3 id="browser-command-title">一键查询并导出</h3><p>依次查询立案和强执，全部采集完成后生成并上传报表；登录请使用上方独立入口。</p></div></div>
      <div class="panel-body">
        <form id="browser-command-form">
          <div class="field-grid">
            <div class="field"><label for="browser-command-account">平台账号（必选）</label><select id="browser-command-account"><option value="">加载中…</option></select></div>
            <div class="field"><label for="browser-command-batch">空白导入批次（必选）</label><select id="browser-command-batch"><option value="">不选择</option></select></div>
          </div>
          <div class="form-actions"><button class="primary" type="submit">一键查询并导出</button><button class="secondary" id="browser-command-refresh" type="button">立即刷新</button></div>
        </form><p class="message" data-browser-command-message aria-live="polite"></p>
      </div>
    </section>
    <section class="panel" aria-labelledby="import-batch-title">
      <div class="panel-head"><div><h3 id="import-batch-title">导入查询批次</h3><p>上传 xlsx 后选择批次绑定查询任务。服务端仅返回批次摘要。</p></div></div>
      <div class="panel-body"><form id="import-batch-form" enctype="multipart/form-data"><div class="field"><label for="import-batch-file">Excel 模板</label><input id="import-batch-file" name="file" type="file" accept=".xlsx" required></div><div class="form-actions"><button class="primary" type="submit">上传批次</button></div></form><p class="message" data-import-batch-message aria-live="polite"></p><div class="table-wrap"><table class="data-table"><thead><tr><th>文件</th><th>立案行</th><th>强执行</th><th>跳过</th><th>创建时间</th></tr></thead><tbody id="import-batch-rows"></tbody></table></div></div>
    </section>
    <section class="panel" aria-labelledby="browser-account-search-title">
      <div class="panel-head"><div><h3 id="browser-account-search-title">账号查询与案件状态</h3><p>按平台账号标签搜索定位，可再按原告、被告或案号关键词筛选；关键词只在本次页面内存中使用，案件状态来自台账精确结果。</p></div></div>
      <div class="panel-body">
        <form id="browser-account-search-form" class="filters">
          <div class="field"><label for="browser-account-search">账号标签</label><input id="browser-account-search" type="search" list="browser-account-labels" autocomplete="off" placeholder="输入账号标签" required><datalist id="browser-account-labels"></datalist></div>
          <div class="field"><label for="browser-account-keyword">案件关键词（可选）</label><input id="browser-account-keyword" type="search" autocomplete="off" placeholder="原告、被告或案号"></div>
          <div class="filter-actions"><button class="primary" type="submit">查询账号</button></div>
        </form>
        <p class="message muted" data-browser-account-message aria-live="polite">请选择账号查询</p>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>平台账号</th><th>案件类型</th><th>案件状态</th><th>案号</th><th>查询时间</th></tr></thead><tbody id="browser-account-case-rows"></tbody></table></div>
      </div>
    </section>
    <section class="panel" aria-labelledby="browser-command-list-title">
      <div class="panel-head"><div><h3 id="browser-command-list-title">任务列表</h3><p>状态、进度与错误码来自扩展回写；账号搜索同时过滤这里的任务。</p></div><div class="row-actions"><button id="browser-command-delete-all" class="small-button danger" type="button">一键删除所有一键任务</button><button id="browser-command-clear" class="small-button danger" type="button">清空已结束任务</button></div></div>
      <div class="panel-body"><div class="case-status"><span data-browser-command-status class="message muted" aria-live="polite">准备读取</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>平台账号</th><th>类型</th><th>状态</th><th>进度</th><th>结果</th><th>创建者</th><th>创建时间</th><th>操作</th></tr></thead><tbody id="browser-command-rows"></tbody></table></div></div>
    </section>`);
}

function forbiddenPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>403 · 案件台账</title>
    <link rel="stylesheet" href="/admin/assets/admin.css">
    <script type="module" src="/admin/assets/admin.js" defer></script>
  </head>
  <body data-page="forbidden" data-role="user">
    <main class="content forbidden panel">
      <p class="eyebrow">Access / Restricted</p>
      <h2>403</h2>
      <p>无权访问该管理页面。请联系管理员获取必要的角色权限。</p>
      <a class="button primary" href="/admin/cases">返回案件台账</a>
    </main>
  </body>
</html>`;
}

export function renderAdminPage(page: AdminPage, role: AdminRole, caseId?: string): string {
  if (page === 'login') return loginPage();
  if (page === 'forbidden') return forbiddenPage();
  if (page === 'users') return usersPage();
  if (page === 'platform-accounts') return platformAccountsPage();
  if (page === 'cases') return casesPage(role);
  if (page === 'report-exports') return reportExportsPage(role);
  if (page === 'browser-control') return browserControlPage(role);
  return caseDetailPage(role, caseId ?? '');
}
