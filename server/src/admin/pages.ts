export type AdminPage = 'login' | 'users' | 'platform-accounts' | 'cases' | 'case-detail' | 'forbidden';
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
    </nav>`;
  }
  return `<nav class="nav" aria-label="主导航">
    <a href="/admin/cases"${page === 'cases' || page === 'case-detail' ? ' aria-current="page"' : ''}>案件台账</a>
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
      <div><p class="eyebrow">Sources / Credentials</p><h2>平台账号</h2><p>维护插件使用的平台账号标签与启停状态。明文凭据不提供读回。</p></div>
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
  return caseDetailPage(role, caseId ?? '');
}
