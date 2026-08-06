import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { ServerConfig } from '../config.ts';
import {
  assertCookieWrite,
  authenticateRequest,
} from '../auth/routes.ts';
import { AuthService, type AuthContext } from '../auth/service.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import {
  BROWSER_COMMAND_STATUSES,
  BROWSER_COMMAND_TYPES,
  type BrowserCommandStatus,
  type BrowserCommandType,
} from './types.ts';
import {
  BrowserCommandService,
  decodeBrowserCommandCursor,
  encodeBrowserCommandCursor,
  isBrowserCommandUuid,
  publicBrowserCommand,
  type BrowserCommandCreateInput,
  type BrowserCommandResultRequest,
} from './service.ts';

interface RegisterBrowserCommandOptions {
  service: BrowserCommandService;
  authService: AuthService;
  config: ServerConfig;
  prefix: string;
}

interface RequestBody {
  [key: string]: unknown;
}

interface QueryParams {
  status?: unknown;
  type?: unknown;
  limit?: unknown;
  cursor?: unknown;
}

const CREATE_FIELDS = new Set(['type', 'platformAccountId', 'importBatchId', 'payload']);
const CLAIM_FIELDS = new Set(['deviceId']);
const RESULT_FIELDS = new Set([
  'deviceId',
  'claimToken',
  'status',
  'resultCode',
  'resultSummary',
  'progress',
]);

function route(prefix: string, path: string): string {
  return `${prefix}${path}`;
}

function bodyOf(request: FastifyRequest): RequestBody {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new ValidationError([{ field: 'body', code: 'object_required' }]);
  }
  return request.body as RequestBody;
}

function assertKnownFields(body: RequestBody, fields: Set<string>): void {
  const unknown = Object.keys(body).find((field) => !fields.has(field));
  if (unknown !== undefined) {
    throw new ValidationError([{ field: unknown, code: 'unknown_field' }]);
  }
}

function optionalNullableString(body: RequestBody, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError([{ field, code: 'string_required' }]);
  }
  return value;
}

function queryOf(request: FastifyRequest): QueryParams {
  if (!request.query || typeof request.query !== 'object' || Array.isArray(request.query)) return {};
  return request.query as QueryParams;
}

function queryLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ValidationError([{ field: 'limit', code: 'integer_required' }]);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 100) {
    throw new ValidationError([{ field: 'limit', code: parsed > 100 ? 'maximum_exceeded' : 'positive_required' }]);
  }
  return parsed;
}

function enumQuery<T extends string>(value: unknown, field: string, values: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new ValidationError([{ field, code: 'invalid_enum' }]);
  }
  return value as T;
}

function queryCursor(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError([{ field: 'cursor', code: 'invalid' }]);
  }
  return decodeBrowserCommandCursor(value);
}

function commandId(request: FastifyRequest): string {
  const id = (request.params as { id?: unknown }).id;
  if (!isBrowserCommandUuid(id)) throw new NotFoundError('Browser command not found');
  return id;
}

function contextOf(request: FastifyRequest): AuthContext {
  const context = request.auth as AuthContext | null;
  if (!context) throw new ForbiddenError();
  return context;
}

async function requireBackOffice(
  request: FastifyRequest,
  authService: AuthService,
  config: ServerConfig,
): Promise<AuthContext> {
  await authenticateRequest(request, authService);
  const context = contextOf(request);
  if (context.session.clientType !== 'admin_ui') throw new ForbiddenError();
  assertCookieWrite(request, authService, config);
  return context;
}

async function requireExtension(request: FastifyRequest, authService: AuthService): Promise<AuthContext> {
  await authenticateRequest(request, authService);
  const context = contextOf(request);
  if (context.session.clientType !== 'extension') throw new ForbiddenError();
  return context;
}

function createInput(body: RequestBody, requestedBy: string): BrowserCommandCreateInput {
  assertKnownFields(body, CREATE_FIELDS);
  if (typeof body.type !== 'string') {
    throw new ValidationError([{ field: 'type', code: 'required' }]);
  }
  return {
    type: body.type as BrowserCommandType,
    platformAccountId: optionalNullableString(body, 'platformAccountId'),
    importBatchId: optionalNullableString(body, 'importBatchId'),
    payload: body.payload as Record<string, unknown> | undefined,
    requestedBy,
  };
}

function resultInput(body: RequestBody): BrowserCommandResultRequest {
  assertKnownFields(body, RESULT_FIELDS);
  return {
    deviceId: body.deviceId,
    claimToken: body.claimToken,
    status: body.status,
    resultCode: body.resultCode,
    resultSummary: body.resultSummary,
    progress: body.progress,
  };
}

export function registerBrowserCommandRoutes(
  app: FastifyInstance,
  options: RegisterBrowserCommandOptions,
): void {
  const { authService, config, prefix, service } = options;
  const readPreHandler = async (request: FastifyRequest) => {
    await authenticateRequest(request, authService);
    const context = contextOf(request);
    if (context.session.clientType !== 'admin_ui') throw new ForbiddenError();
  };
  const extensionPreHandler = async (request: FastifyRequest) => requireExtension(request, authService);

  app.post(route(prefix, '/browser-commands'), async (request, reply) => {
    const context = await requireBackOffice(request, authService, config);
    const command = await service.create(createInput(bodyOf(request), context.user.id));
    reply.code(201);
    return { command: publicBrowserCommand(command) };
  });

  app.get(route(prefix, '/browser-commands'), { preHandler: readPreHandler }, async (request) => {
    const context = contextOf(request);
    const query = queryOf(request);
    const status = enumQuery(query.status, 'status', BROWSER_COMMAND_STATUSES);
    const type = enumQuery(query.type, 'type', BROWSER_COMMAND_TYPES);
    const page = await service.list({
      requestedBy: context.user.role === 'admin' ? undefined : context.user.id,
      status,
      type,
      limit: queryLimit(query.limit),
      cursor: queryCursor(query.cursor),
    });
    return {
      commands: page.items.map(publicBrowserCommand),
      nextCursor: page.nextCursor ? encodeBrowserCommandCursor(page.nextCursor) : null,
    };
  });

  app.get(route(prefix, '/browser-commands/:id'), { preHandler: readPreHandler }, async (request) => {
    const context = contextOf(request);
    const requestedBy = context.user.role === 'admin' ? undefined : context.user.id;
    const command = await service.get(commandId(request), requestedBy);
    return { command: publicBrowserCommand(command) };
  });

  app.post(route(prefix, '/browser-commands/:id/claim'), { preHandler: extensionPreHandler }, async (request) => {
    const body = bodyOf(request);
    assertKnownFields(body, CLAIM_FIELDS);
    const claim = await service.claim(commandId(request), body.deviceId as string);
    return {
      command: publicBrowserCommand(claim.command),
      claimToken: claim.claimToken,
    };
  });

  app.post(route(prefix, '/browser-commands/:id/result'), { preHandler: extensionPreHandler }, async (request) => {
    const command = await service.writeResult(commandId(request), resultInput(bodyOf(request)));
    return { command: publicBrowserCommand(command) };
  });

  app.post(route(prefix, '/browser-commands/:id/cancel'), async (request) => {
    const context = await requireBackOffice(request, authService, config);
    const body = bodyOf(request);
    assertKnownFields(body, new Set());
    const command = await service.cancel(commandId(request), context.user.id);
    return { command: publicBrowserCommand(command) };
  });
}
