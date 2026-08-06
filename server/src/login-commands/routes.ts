import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { ServerConfig } from '../config.ts';
import { ForbiddenError, ValidationError } from '../errors.ts';
import {
  assertCookieWrite,
  authenticateRequest,
  requireAdmin,
} from '../auth/routes.ts';
import { AuthService, type AuthContext } from '../auth/service.ts';
import {
  LoginCommandService,
  publicLoginCommand,
  publicLoginCommandListItem,
  publicLoginCommandResult,
} from './service.ts';

interface RegisterLoginCommandOptions {
  service: LoginCommandService;
  authService: AuthService;
  config: ServerConfig;
  prefix: string;
}

interface RequestBody {
  [key: string]: unknown;
}

function route(prefix: string, path: string): string {
  return `${prefix}${path}`;
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

function requiredBoolean(body: RequestBody, field: string): boolean {
  const value = body[field];
  if (typeof value !== 'boolean') {
    throw new ValidationError([{ field, code: 'boolean_required' }]);
  }
  return value;
}

function limitFromQuery(query: unknown): number {
  const raw = (query as { limit?: unknown })?.limit;
  if (raw === undefined) return 100;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 100;
  return value;
}

async function requireExtension(request: FastifyRequest, authService: AuthService): Promise<AuthContext> {
  await authenticateRequest(request, authService);
  const context = request.auth as AuthContext;
  if (context.session.clientType !== 'extension') {
    throw new ForbiddenError();
  }
  return context;
}

async function requireAdminCookie(
  request: FastifyRequest,
  authService: AuthService,
  config: ServerConfig,
): Promise<AuthContext> {
  await requireAdmin(request, authService);
  const context = request.auth as AuthContext;
  if (context.session.clientType === 'extension') {
    return context;
  }
  if (context.mechanism !== 'cookie' || context.session.clientType !== 'admin_ui') {
    throw new ForbiddenError('Admin cookie session required');
  }
  assertCookieWrite(request, authService, config);
  return context;
}

function claimedBy(context: AuthContext): string {
  return `sess-${context.session.id.replaceAll('-', '').slice(0, 8)}`;
}

export function registerLoginCommandRoutes(
  app: FastifyInstance,
  options: RegisterLoginCommandOptions,
): void {
  const { authService, config, prefix, service } = options;
  const adminPreHandler = async (request: FastifyRequest) => requireAdmin(request, authService);

  app.post(route(prefix, '/login-commands'), async (request, reply) => {
    const context = await requireAdminCookie(request, authService, config);
    const body = bodyOf(request);
    const command = await service.create(requiredString(body, 'platformAccountId'), context.user.id);
    reply.code(201);
    return publicLoginCommand(command);
  });

  app.get(route(prefix, '/login-commands'), async (request) => {
    const query = request.query as { status?: string; limit?: string };
    if (query.status === 'pending') {
      const context = await requireExtension(request, authService);
      const command = await service.claimNext(claimedBy(context));
      return {
        command: command
          ? { id: command.id, platformAccountId: command.platformAccountId }
          : null,
      };
    }
    await adminPreHandler(request);
    const commands = await service.listAdmin(limitFromQuery(request.query));
    return { commands: commands.map(publicLoginCommandListItem) };
  });

  app.post(route(prefix, '/login-commands/:id/result'), async (request) => {
    const context = await requireExtension(request, authService);
    const body = bodyOf(request);
    const command = await service.complete(
      (request.params as { id: string }).id,
      claimedBy(context),
      {
        ok: requiredBoolean(body, 'ok'),
        code: optionalString(body, 'code'),
        message: optionalString(body, 'message'),
      },
    );
    return publicLoginCommandResult(command);
  });
}
