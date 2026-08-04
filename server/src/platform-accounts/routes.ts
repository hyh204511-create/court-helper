import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { ServerConfig } from '../config.ts';
import { ConflictError, ForbiddenError, ValidationError } from '../errors.ts';
import {
  assertCookieWrite,
  authenticateRequest,
  requireAdmin,
} from '../auth/routes.ts';
import { AuthService } from '../auth/service.ts';
import { publicPlatformAccount, PlatformAccountService } from './service.ts';

interface RequestBody {
  [key: string]: unknown;
}

interface RegisterPlatformAccountOptions {
  service: PlatformAccountService;
  authService: AuthService;
  config: ServerConfig;
  prefix: string;
}

function bodyOf(request: FastifyRequest): RequestBody {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new ValidationError([{ field: 'body', code: 'object_required' }]);
  }
  return request.body as RequestBody;
}

function requiredString(body: RequestBody, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError([{ field, code: 'required' }]);
  }
  return value;
}

function optionalString(body: RequestBody, field: string): string | undefined {
  if (body[field] === undefined) return undefined;
  return requiredString(body, field);
}

function optionalBoolean(body: RequestBody, field: string): boolean | undefined {
  if (body[field] === undefined) return undefined;
  if (typeof body[field] !== 'boolean') {
    throw new ValidationError([{ field, code: 'boolean_required' }]);
  }
  return body[field] as boolean;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}

async function requireExtensionSession(request: FastifyRequest, service: AuthService): Promise<void> {
  await authenticateRequest(request, service);
  if (request.auth?.session.clientType !== 'extension') {
    throw new ForbiddenError('Extension session required');
  }
}

function route(prefix: string, path: string): string {
  return `${prefix}${path}`;
}

export function registerPlatformAccountRoutes(
  app: FastifyInstance,
  options: RegisterPlatformAccountOptions,
): void {
  const { authService, config, prefix, service } = options;
  const protectedPreHandler = async (request: FastifyRequest) => authenticateRequest(request, authService);
  const adminPreHandler = async (request: FastifyRequest) => requireAdmin(request, authService);
  const extensionPreHandler = async (request: FastifyRequest) => requireExtensionSession(request, authService);

  app.get(route(prefix, '/platform-accounts'), { preHandler: protectedPreHandler }, async (request) => {
    const accounts = await service.list((request.auth as NonNullable<typeof request.auth>).user.role);
    return { platformAccounts: accounts.map(publicPlatformAccount) };
  });

  app.post(route(prefix, '/platform-accounts'), { preHandler: adminPreHandler }, async (request, reply) => {
    assertCookieWrite(request, authService, config);
    const body = bodyOf(request);
    const label = requiredString(body, 'label');
    const account = requiredString(body, 'account');
    const password = requiredString(body, 'password');
    const enabled = optionalBoolean(body, 'enabled') ?? true;
    try {
      const created = await service.create(
        (request.auth as NonNullable<typeof request.auth>).user.id,
        label,
        { account, password },
        enabled,
      );
      reply.code(201);
      return publicPlatformAccount(created);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('Platform account label already exists');
      throw error;
    }
  });

  app.patch(route(prefix, '/platform-accounts/:id'), { preHandler: adminPreHandler }, async (request) => {
    assertCookieWrite(request, authService, config);
    const body = bodyOf(request);
    const label = optionalString(body, 'label');
    const enabled = optionalBoolean(body, 'enabled');
    const hasAccount = body.account !== undefined;
    const hasPassword = body.password !== undefined;
    if (hasAccount !== hasPassword) {
      throw new ValidationError([{ field: hasAccount ? 'password' : 'account', code: 'required' }]);
    }
    const account = hasAccount ? requiredString(body, 'account') : undefined;
    const password = hasPassword ? requiredString(body, 'password') : undefined;
    if (label === undefined && enabled === undefined && account === undefined && password === undefined) {
      throw new ValidationError([{ field: 'body', code: 'no_changes' }]);
    }
    try {
      const updated = await service.update(
        (request.params as { id: string }).id,
        { label, enabled },
        account === undefined ? undefined : { account, password: password as string },
      );
      return publicPlatformAccount(updated);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('Platform account label already exists');
      throw error;
    }
  });

  app.delete(route(prefix, '/platform-accounts/:id'), { preHandler: adminPreHandler }, async (request) => {
    assertCookieWrite(request, authService, config);
    const deleted = await service.delete((request.params as { id: string }).id);
    return publicPlatformAccount(deleted);
  });

  app.post(route(prefix, '/platform-accounts/:id/credential'), { preHandler: extensionPreHandler }, async (request, reply) => {
    const credential = await service.credential((request.params as { id: string }).id);
    reply.header('Cache-Control', 'no-store');
    return credential;
  });
}
