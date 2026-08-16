import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { ServerConfig } from '../config.ts';
import { ValidationError } from '../errors.ts';
import { assertCookieWrite, requireAdminUiAdmin } from '../auth/routes.ts';
import type { AuthService } from '../auth/service.ts';
import type { UserWecomWebhookService } from './service.ts';

interface Options { prefix: string; config: ServerConfig; authService: AuthService; service: UserWecomWebhookService }

function idOf(request: FastifyRequest): string {
  const id = (request.params as { id?: unknown }).id;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new ValidationError([{ field: 'id', code: 'uuid_required' }]);
  }
  return id;
}

function webhookUrlOf(request: FastifyRequest): string {
  const body = request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError([{ field: 'body', code: 'object_required' }]);
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'webhookUrl') throw new ValidationError([{ field: 'body', code: 'unexpected_field' }]);
  return (body as { webhookUrl?: unknown }).webhookUrl as string;
}

export function registerUserWecomWebhookRoutes(app: FastifyInstance, options: Options): void {
  const path = (suffix: string) => `${options.prefix}${suffix}`;
  app.put(path('/users/:id/wecom-webhook'), async (request) => {
    await requireAdminUiAdmin(request, options.authService);
    assertCookieWrite(request, options.authService, options.config);
    return options.service.set(idOf(request), webhookUrlOf(request));
  });
  app.delete(path('/users/:id/wecom-webhook'), async (request) => {
    await requireAdminUiAdmin(request, options.authService);
    assertCookieWrite(request, options.authService, options.config);
    return options.service.clear(idOf(request));
  });
}
