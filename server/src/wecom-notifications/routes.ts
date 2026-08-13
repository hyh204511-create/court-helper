import type { FastifyInstance, FastifyRequest } from 'fastify';

import { assertCookieWrite, authenticateRequest } from '../auth/routes.ts';
import type { AuthService } from '../auth/service.ts';
import type { ServerConfig } from '../config.ts';
import { ForbiddenError } from '../errors.ts';
import type { CaseAccess } from '../cases/types.ts';
import type { WecomNotificationService } from './service.ts';

interface RegisterOptions {
  authService: AuthService;
  config: ServerConfig;
  prefix: string;
  service: WecomNotificationService;
}

function accessOf(request: FastifyRequest): CaseAccess {
  const auth = request.auth as NonNullable<typeof request.auth>;
  return { userId: auth.user.id, role: auth.user.role };
}

export function registerWecomNotificationRoutes(app: FastifyInstance, options: RegisterOptions): void {
  app.get(`${options.prefix}/cases/:id/wecom-notifications`, { preHandler: async (request) => {
    await authenticateRequest(request, options.authService);
    const context = request.auth;
    if (!context || context.mechanism !== 'cookie' || context.session.clientType !== 'admin_ui') throw new ForbiddenError();
  } }, async (request) => {
    const id = (request.params as { id: string }).id;
    return { notifications: await options.service.listForCase(id, accessOf(request)) };
  });

  app.post(`${options.prefix}/wecom-notifications/:id/retry`, { preHandler: async (request) => {
    await authenticateRequest(request, options.authService);
    const context = request.auth;
    if (!context || context.mechanism !== 'cookie' || context.session.clientType !== 'admin_ui') throw new ForbiddenError();
    assertCookieWrite(request, options.authService, options.config);
  } }, async (request) => {
    await options.service.retry((request.params as { id: string }).id, accessOf(request));
    return { delivered: true };
  });
}
