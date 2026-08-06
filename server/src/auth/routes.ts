import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ServerConfig } from '../config.ts';
import {
  AuthenticationRequiredError,
  ConflictError,
  ForbiddenError,
  TooManyRequestsError,
  ValidationError,
} from '../errors.ts';
import {
  adminUser,
  AuthService,
  normalizeUsername,
  publicUser,
  type AuthContext,
} from './service.ts';
import type { AuthRepository, ClientType, Role, UserPatch } from './types.ts';

export const SESSION_COOKIE_NAME = 'court_helper_session';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

interface RequestBody {
  [key: string]: unknown;
}

interface RegisterAuthOptions {
  service: AuthService;
  repository: AuthRepository;
  config: ServerConfig;
  prefix: string;
  onAdminUiLogin?: () => Promise<void>;
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

function enumValue<T extends string>(body: RequestBody, field: string, values: readonly T[]): T {
  const value = body[field];
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new ValidationError([{ field, code: 'invalid_enum' }]);
  }
  return value as T;
}

function optionalBoolean(body: RequestBody, field: string): boolean | undefined {
  if (body[field] === undefined) return undefined;
  if (typeof body[field] !== 'boolean') {
    throw new ValidationError([{ field, code: 'boolean_required' }]);
  }
  return body[field] as boolean;
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string };
  return candidate?.code === '23505';
}

function originOf(request: FastifyRequest): string | undefined {
  const origin = request.headers.origin;
  return typeof origin === 'string' ? origin : undefined;
}

function assertLoginOrigin(request: FastifyRequest, config: ServerConfig, clientType: ClientType): void {
  const origin = originOf(request);
  const allowed = clientType === 'admin_ui'
    ? config.cors.adminOrigins
    : config.cors.extensionOrigins;
  if (!origin || !allowed.includes(origin)) {
    throw new ForbiddenError('Origin not allowed');
  }
}

export function assertCookieWrite(request: FastifyRequest, service: AuthService, config: ServerConfig): void {
  const context = request.auth;
  if (!context || context.mechanism !== 'cookie') return;
  const origin = originOf(request);
  if (!origin || !config.cors.adminOrigins.includes(origin)) {
    throw new ForbiddenError('Origin not allowed');
  }
  const csrfHeader = request.headers['x-csrf-token'];
  const csrfToken = typeof csrfHeader === 'string' ? csrfHeader : undefined;
  if (!service.isCsrfTokenValid(context.session.id, csrfToken)) {
    throw new ForbiddenError('CSRF validation failed');
  }
}

export async function authenticateRequest(request: FastifyRequest, service: AuthService): Promise<void> {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    if (typeof authorization !== 'string' || !/^Bearer\s+\S+$/.test(authorization)) {
      throw new AuthenticationRequiredError();
    }
    request.auth = await service.authenticate(authorization.replace(/^Bearer\s+/, ''), 'bearer');
    return;
  }

  const cookieToken = request.cookies?.[SESSION_COOKIE_NAME];
  if (!cookieToken) {
    throw new AuthenticationRequiredError();
  }
  request.auth = await service.authenticate(cookieToken, 'cookie');
}

export async function requireAdmin(request: FastifyRequest, service: AuthService): Promise<void> {
  await authenticateRequest(request, service);
  if (request.auth?.user.role !== 'admin') {
    throw new ForbiddenError();
  }
}

function protectedHandler(service: AuthService) {
  return async (request: FastifyRequest) => authenticateRequest(request, service);
}

function adminHandler(service: AuthService) {
  return async (request: FastifyRequest) => requireAdmin(request, service);
}

function route(prefix: string, path: string): string {
  return `${prefix}${path}`;
}

export function registerAuthRoutes(app: FastifyInstance, options: RegisterAuthOptions): void {
  const { config, prefix, repository, service } = options;
  const protectedPreHandler = protectedHandler(service);
  const adminPreHandler = adminHandler(service);

  app.post(route(prefix, '/auth/login'), async (request, reply) => {
    const body = bodyOf(request);
    const username = requiredString(body, 'username');
    const password = requiredString(body, 'password');
    const clientType = enumValue(body, 'clientType', ['admin_ui', 'extension'] as const);
    assertLoginOrigin(request, config, clientType);
    let result;
    try {
      result = await service.login(username, password, clientType, request.ip);
    } catch (error) {
      if (error instanceof TooManyRequestsError) {
        reply.header('retry-after', String(Math.ceil(error.retryAfterSeconds)));
      }
      throw error;
    }

    if (clientType === 'admin_ui') {
      reply.setCookie(SESSION_COOKIE_NAME, result.token, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/',
        maxAge: config.auth.sessionTtlSeconds,
      });
      void options.onAdminUiLogin?.().catch(() => {});
      return { ...publicUser(result.user), csrfToken: result.csrfToken };
    }
    return { ...publicUser(result.user), token: result.token };
  });

  app.get(route(prefix, '/auth/me'), { preHandler: protectedPreHandler }, async (request) => {
    const context = request.auth as AuthContext;
    const csrfToken = context.mechanism === 'cookie'
      ? service.getCsrfToken(context.session.id)
      : undefined;
    return {
      ...publicUser(context.user),
      ...(csrfToken ? { csrfToken } : {}),
    };
  });

  app.post(route(prefix, '/auth/logout'), { preHandler: protectedPreHandler }, async (request, reply) => {
    assertCookieWrite(request, service, config);
    await service.logout(request.auth as AuthContext);
    if ((request.auth as AuthContext).mechanism === 'cookie') {
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    }
    return { ok: true };
  });

  app.get(route(prefix, '/users'), { preHandler: adminPreHandler }, async () => {
    const users = await service.listUsers();
    return { users: users.map(adminUser) };
  });

  app.get(route(prefix, '/users/:id'), { preHandler: adminPreHandler }, async (request) => {
    const user = await service.getUser((request.params as { id: string }).id);
    return adminUser(user);
  });

  app.post(route(prefix, '/users'), { preHandler: adminPreHandler }, async (request, reply) => {
    assertCookieWrite(request, service, config);
    const body = bodyOf(request);
    const username = requiredString(body, 'username');
    const password = requiredString(body, 'password');
    const role = enumValue(body, 'role', ['admin', 'user'] as const);
    const enabled = optionalBoolean(body, 'enabled') ?? true;
    try {
      const user = await service.createUser(username, password, role, enabled);
      reply.code(201);
      return adminUser(user);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('Username already exists');
      throw error;
    }
  });

  app.patch(route(prefix, '/users/:id'), { preHandler: adminPreHandler }, async (request) => {
    assertCookieWrite(request, service, config);
    const body = bodyOf(request);
    const id = (request.params as { id: string }).id;
    const current = await service.getUser(id);
    const role = body.role === undefined ? undefined : enumValue(body, 'role', ['admin', 'user'] as const);
    const enabled = optionalBoolean(body, 'enabled');
    const username = body.username === undefined ? undefined : requiredString(body, 'username');
    if (role === undefined && enabled === undefined && username === undefined) {
      throw new ValidationError([{ field: 'body', code: 'no_changes' }]);
    }
    if (
      current.role === 'admin' && current.enabled && current.deletedAt === null
      && (role === 'user' || enabled === false)
      && await repository.countEnabledAdmins() <= 1
    ) {
      throw new ConflictError('Cannot change the last enabled admin', 'LAST_ADMIN');
    }
    const patch: UserPatch = { role, enabled, username };
    try {
      return adminUser(await service.updateUser(id, patch));
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('Username already exists');
      throw error;
    }
  });

  app.delete(route(prefix, '/users/:id'), { preHandler: adminPreHandler }, async (request) => {
    assertCookieWrite(request, service, config);
    const id = (request.params as { id: string }).id;
    const current = await service.getUser(id);
    if (current.role === 'admin' && current.enabled && current.deletedAt === null && await repository.countEnabledAdmins() <= 1) {
      throw new ConflictError('Cannot delete the last enabled admin', 'LAST_ADMIN');
    }
    return adminUser(await service.deleteUser(id));
  });

  app.post(route(prefix, '/users/:id/reset-password'), { preHandler: adminPreHandler }, async (request) => {
    assertCookieWrite(request, service, config);
    const password = requiredString(bodyOf(request), 'password');
    const id = (request.params as { id: string }).id;
    return adminUser(await service.resetPassword(id, password));
  });
}
