import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { authenticateRequest } from '../auth/routes.ts';
import { AuthService, type AuthContext } from '../auth/service.ts';
import { AuthenticationRequiredError, ForbiddenError } from '../errors.ts';
import { ADMIN_SCRIPT, ADMIN_STYLES } from './assets.ts';
import { renderAdminPage, type AdminPage, type AdminRole } from './pages.ts';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join('; ');

interface RegisterAdminOptions {
  authService: AuthService;
  localWindowsDelivery?: { enabled: boolean; extensionDir?: string };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function renderLocalSetup(ocrReady: boolean, extensionDir?: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>法院查询助手安装向导</title><link rel="stylesheet" href="/admin/assets/admin.css"></head><body><main class="auth-shell"><section class="auth-card"><h1>法院查询助手已安装</h1><p>后台状态：正常</p><p>OCR 状态：${ocrReady ? '正常' : '正在启动，请稍后运行“诊断与修复”'}</p><ol><li>打开 Edge，在地址栏输入 <code>edge://extensions</code>。</li><li>打开“开发人员模式”，点击“加载解压缩的扩展”。</li><li>选择 <code>${escapeHtml(extensionDir ?? 'C:\\Program Files\\CourtHelper\\extension')}</code>。</li><li>返回本页，登录后台并按页面提示完成设备配对。</li></ol><p><a class="primary-link" href="/admin/login">进入后台登录</a></p></section></main></body></html>`;
}

function secureHeaders(reply: FastifyReply): void {
  reply
    .header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Referrer-Policy', 'no-referrer')
    .header('Cache-Control', 'no-store');
}

function sendHtml(reply: FastifyReply, html: string, statusCode = 200) {
  secureHeaders(reply);
  return reply.code(statusCode).type('text/html; charset=utf-8').send(html);
}

function sendAsset(reply: FastifyReply, body: string, contentType: string) {
  secureHeaders(reply);
  return reply.code(200).type(contentType).send(body);
}

async function pageAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
): Promise<AuthContext | null> {
  try {
    await authenticateRequest(request, authService);
    const context = request.auth;
    if (!context || context.mechanism !== 'cookie' || context.session.clientType !== 'admin_ui') {
      throw new ForbiddenError();
    }
    return context;
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      reply.redirect('/admin/login');
      return null;
    }
    throw error;
  }
}

function pageRole(context: AuthContext): AdminRole {
  return context.user.role === 'admin' ? 'admin' : 'user';
}

function renderProtectedPage(
  page: AdminPage,
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
  requiredRole: AdminRole | null,
  caseId?: string,
) {
  return pageAuth(request, reply, authService).then((context) => {
    if (!context) return reply;
    const role = pageRole(context);
    if (requiredRole !== null && role !== requiredRole) {
      return sendHtml(reply, renderAdminPage('forbidden', 'user'), 403);
    }
    return sendHtml(reply, renderAdminPage(page, role, caseId));
  });
}

export function registerAdminRoutes(app: FastifyInstance, options: RegisterAdminOptions): void {
  const { authService } = options;

  app.get('/admin/assets/admin.css', async (_request, reply) => sendAsset(reply, ADMIN_STYLES, 'text/css; charset=utf-8'));
  app.get('/admin/assets/admin.js', async (_request, reply) => sendAsset(reply, ADMIN_SCRIPT, 'text/javascript; charset=utf-8'));

  app.get('/', async (_request, reply) => reply.redirect('/admin/browser-control'));
  app.get('/admin/login', async (_request, reply) => sendHtml(reply, renderAdminPage('login', 'user')));
  app.get('/admin', async (_request, reply) => reply.redirect('/admin/browser-control'));
  if (options.localWindowsDelivery?.enabled) {
    app.get('/local-setup', async (_request, reply) => {
      let ocrReady = false;
      try {
        const response = await fetch('http://127.0.0.1:8765/health', { signal: AbortSignal.timeout(1_000) });
        ocrReady = response.ok && (await response.json() as { ok?: unknown }).ok === true;
      } catch { /* OCR failure must not block the local onboarding page. */ }
      return sendHtml(reply, renderLocalSetup(ocrReady, options.localWindowsDelivery?.extensionDir));
    });
  }

  app.get('/admin/users', async (request, reply) => renderProtectedPage('users', request, reply, authService, 'admin'));
  app.get('/admin/platform-accounts', async (request, reply) => renderProtectedPage('platform-accounts', request, reply, authService, 'admin'));
  app.get('/admin/cases', async (request, reply) => renderProtectedPage('cases', request, reply, authService, null));
  app.get('/admin/report-exports', async (request, reply) => renderProtectedPage('report-exports', request, reply, authService, null));
  app.get('/admin/browser-control', async (request, reply) => renderProtectedPage('browser-control', request, reply, authService, null));
  app.get('/admin/cases/:id', async (request, reply) => renderProtectedPage(
    'case-detail',
    request,
    reply,
    authService,
    null,
    (request.params as { id: string }).id,
  ));
}

export { CONTENT_SECURITY_POLICY };
