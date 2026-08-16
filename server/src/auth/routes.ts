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
  publicExtensionDevice,
  publicExtensionPairing,
  publicUser,
  type AuthContext,
} from './service.ts';
import type { AuthRepository, ClientType, Role, UserPatch } from './types.ts';
import type { UserWecomWebhookService } from '../user-wecom-webhooks/service.ts';

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
  userWecomWebhookService?: UserWecomWebhookService;
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

function secureSessionCookie(request: FastifyRequest): boolean {
  if (String(request.protocol ?? '').toLowerCase() === 'https') return true;
  const origin = originOf(request);
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return !(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1');
  } catch {
    return true;
  }
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

function assertExtensionOrigin(request: FastifyRequest, config: ServerConfig): void {
  const origin = originOf(request);
  if (!origin || !config.cors.extensionOrigins.includes(origin)) {
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

export async function requireAdminUiAdmin(request: FastifyRequest, service: AuthService): Promise<void> {
  await authenticateRequest(request, service);
  const context = request.auth;
  if (!context || context.mechanism !== 'cookie' || context.session.clientType !== 'admin_ui' || context.user.role !== 'admin') {
    throw new ForbiddenError();
  }
}

function protectedHandler(service: AuthService) {
  return async (request: FastifyRequest) => authenticateRequest(request, service);
}

function adminHandler(service: AuthService) {
  return async (request: FastifyRequest) => requireAdminUiAdmin(request, service);
}

function optionalSafeLabel(body: RequestBody, field: string): string | undefined {
  if (body[field] === undefined) return undefined;
  return requiredString(body, field);
}

function pairingId(request: FastifyRequest): string {
  const id = (request.params as { id?: unknown }).id;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new ValidationError([{ field: 'id', code: 'uuid_required' }]);
  }
  return id;
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
    const clientType = enumValue(body, 'clientType', ['admin_ui'] as const);
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
        secure: secureSessionCookie(request),
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

  app.post(route(prefix, '/auth/extension-pairings'), async (request, reply) => {
    assertExtensionOrigin(request, config);
    const body = bodyOf(request);
    const result = await service.createExtensionPairing({
      deviceId: requiredString(body, 'deviceId'),
      label: optionalSafeLabel(body, 'label'),
      exchangeSecret: requiredString(body, 'exchangeSecret'),
      ip: request.ip,
    });
    reply.header('cache-control', 'no-store').code(201);
    return {
      pairing: {
        ...publicExtensionPairing(result.pairing),
        verificationCode: result.verificationCode,
      },
    };
  });

  app.get(route(prefix, '/auth/extension-pairings'), async (request) => {
    await requireAdminUiAdmin(request, service);
    const pairings = await service.listPendingExtensionPairings();
    return { pairings: pairings.map(publicExtensionPairing) };
  });

  app.post(route(prefix, '/auth/extension-pairings/:id/approve'), async (request) => {
    await requireAdminUiAdmin(request, service);
    assertCookieWrite(request, service, config);
    const body = bodyOf(request);
    const context = request.auth as AuthContext;
    const pairing = await service.approveExtensionPairing(
      pairingId(request),
      requiredString(body, 'verificationCode'),
      context.user.id,
    );
    return { pairing: publicExtensionPairing(pairing) };
  });

  app.post(route(prefix, '/auth/extension-pairings/:id/exchange'), async (request, reply) => {
    assertExtensionOrigin(request, config);
    const result = await service.exchangeExtensionPairing(
      pairingId(request),
      requiredString(bodyOf(request), 'exchangeSecret'),
    );
    reply.header('cache-control', 'no-store');
    return {
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
      device: publicExtensionDevice(result.device),
    };
  });

  app.get(route(prefix, '/auth/extension-devices'), async (request) => {
    await requireAdminUiAdmin(request, service);
    const devices = await service.listExtensionDevices();
    return { devices: devices.map(publicExtensionDevice) };
  });

  app.post(route(prefix, '/auth/extension-devices/:id/revoke'), async (request) => {
    await requireAdminUiAdmin(request, service);
    assertCookieWrite(request, service, config);
    bodyOf(request);
    const device = await service.revokeExtensionDevice(pairingId(request));
    return { device: publicExtensionDevice(device) };
  });

  app.delete(route(prefix, '/auth/extension-devices/:id'), async (request) => {
    await requireAdminUiAdmin(request, service);
    assertCookieWrite(request, service, config);
    return { deletedCount: await service.deleteExtensionDevice(pairingId(request)) };
  });

  app.delete(route(prefix, '/auth/extension-devices'), async (request) => {
    await requireAdminUiAdmin(request, service);
    assertCookieWrite(request, service, config);
    return { deletedCount: await service.deleteExtensionDevices() };
  });

  app.get(route(prefix, '/users'), { preHandler: adminPreHandler }, async () => {
    const users = await service.listUsers();
    const configured = options.userWecomWebhookService
      ? await options.userWecomWebhookService.statuses(users.map((user) => user.id))
      : new Map<string, boolean>();
    return { users: users.map((user) => ({ ...adminUser(user), wecomWebhookConfigured: configured.get(user.id) ?? false })) };
  });

  app.get(route(prefix, '/users/:id'), { preHandler: adminPreHandler }, async (request) => {
    const user = await service.getUser((request.params as { id: string }).id);
    const status = options.userWecomWebhookService ? await options.userWecomWebhookService.status(user.id) : null;
    return { ...adminUser(user), wecomWebhookConfigured: status?.wecomWebhookConfigured ?? false };
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
