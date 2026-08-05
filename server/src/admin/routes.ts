import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { authenticateRequest } from '../auth/routes.ts';
import { AuthService, type AuthContext } from '../auth/service.ts';
import { AuthenticationRequiredError } from '../errors.ts';
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
    return request.auth;
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

  app.get('/admin/login', async (_request, reply) => sendHtml(reply, renderAdminPage('login', 'user')));
  app.get('/admin', async (_request, reply) => reply.redirect('/admin/cases'));

  app.get('/admin/users', async (request, reply) => renderProtectedPage('users', request, reply, authService, 'admin'));
  app.get('/admin/platform-accounts', async (request, reply) => renderProtectedPage('platform-accounts', request, reply, authService, 'admin'));
  app.get('/admin/cases', async (request, reply) => renderProtectedPage('cases', request, reply, authService, null));
  app.get('/admin/report-exports', async (request, reply) => renderProtectedPage('report-exports', request, reply, authService, null));
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
