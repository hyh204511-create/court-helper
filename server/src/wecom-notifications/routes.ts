import type { FastifyInstance, FastifyRequest } from 'fastify';

import { assertCookieWrite, authenticateRequest } from '../auth/routes.ts';
import type { AuthService } from '../auth/service.ts';
import type { ServerConfig } from '../config.ts';
import { ForbiddenError, ValidationError } from '../errors.ts';
import type { CaseAccess } from '../cases/types.ts';
import type { WecomNotificationService } from './service.ts';

interface RegisterOptions {
  authService: AuthService;
  config: ServerConfig;
  prefix: string;
  service: WecomNotificationService;
}

const FIELDS = new Set(['salespersonMobile', 'assistantMobile']);
const MOBILE = /^1\d{10}$/;

function parseBody(request: FastifyRequest): [string, string] {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new ValidationError([{ field: 'body', code: 'object_required' }]);
  }
  const body = request.body as Record<string, unknown>;
  const unknown = Object.keys(body).find((field) => !FIELDS.has(field));
  if (unknown) throw new ValidationError([{ field: unknown, code: 'unknown_field' }]);
  const read = (field: string) => {
    const value = body[field];
    if (typeof value !== 'string' || !MOBILE.test(value.trim())) {
      throw new ValidationError([{ field, code: 'mobile_required' }]);
    }
    return value.trim();
  };
  return [read('salespersonMobile'), read('assistantMobile')];
}

function accessOf(request: FastifyRequest): CaseAccess {
  const auth = request.auth as NonNullable<typeof request.auth>;
  return { userId: auth.user.id, role: auth.user.role };
}

export function registerWecomNotificationRoutes(app: FastifyInstance, options: RegisterOptions): void {
  app.post(`${options.prefix}/cases/:id/wecom-notifications`, { preHandler: async (request) => {
    await authenticateRequest(request, options.authService);
    const context = request.auth;
    if (!context || context.mechanism !== 'cookie' || context.session.clientType !== 'admin_ui') {
      throw new ForbiddenError();
    }
    assertCookieWrite(request, options.authService, options.config);
  } }, async (request) => {
    const mobiles = parseBody(request);
    const id = (request.params as { id: string }).id;
    await options.service.send(id, mobiles, accessOf(request));
    return { delivered: true };
  });
}
