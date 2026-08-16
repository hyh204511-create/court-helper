import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ServerConfig } from '../config.ts';
import { ConflictError, ForbiddenError, ValidationError } from '../errors.ts';
import {
  assertCookieWrite,
  authenticateRequest,
  requireAdmin,
} from '../auth/routes.ts';
import { AuthService } from '../auth/service.ts';
import { publicPlatformAccount, PlatformAccountService } from './service.ts';
import {
  parsePlatformAccountWorkbook,
  PlatformAccountImportError,
} from './import.ts';

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

function optionalContactName(body: RequestBody, field: string): string | null | undefined {
  if (body[field] === undefined) return undefined;
  if (body[field] === null) return null;
  if (typeof body[field] !== 'string') {
    throw new ValidationError([{ field, code: 'contact_name_required' }]);
  }
  const value = body[field].trim();
  if (value === '') return null;
  if (Array.from(value).length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new ValidationError([{ field, code: 'contact_name_required' }]);
  }
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}

function route(prefix: string, path: string): string {
  return `${prefix}${path}`;
}

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

async function importWorkbook(request: FastifyRequest): Promise<Buffer> {
  if (!request.isMultipart()) throw new ValidationError([{ field: 'body', code: 'multipart_required' }]);
  let buffer: Buffer | null = null;
  for await (const part of request.parts({ limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 0, parts: 1 } })) {
    if (part.type !== 'file' || part.fieldname !== 'file' || buffer !== null) {
      throw new ValidationError([{ field: part.type === 'file' ? part.fieldname : 'body', code: 'unexpected_file' }]);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of (part as MultipartFile).file) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.length;
      if (size <= MAX_IMPORT_BYTES) chunks.push(value);
    }
    if ((part.file as typeof part.file & { truncated?: boolean }).truncated || size > MAX_IMPORT_BYTES) {
      throw new ValidationError([{ field: 'file', code: 'maximum_exceeded' }]);
    }
    buffer = Buffer.concat(chunks, size);
  }
  if (!buffer) throw new ValidationError([{ field: 'file', code: 'file_required' }]);
  return buffer;
}

export function registerPlatformAccountRoutes(
  app: FastifyInstance,
  options: RegisterPlatformAccountOptions,
): void {
  const { authService, config, prefix, service } = options;
  const protectedPreHandler = async (request: FastifyRequest) => authenticateRequest(request, authService);
  const adminPreHandler = async (request: FastifyRequest) => requireAdmin(request, authService);
  const credentialViewPreHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'private, no-store');
    await authenticateRequest(request, authService);
    const context = request.auth;
    if (!context || context.mechanism !== 'cookie' || context.session.clientType !== 'admin_ui') {
      throw new ForbiddenError();
    }
    const origin = request.headers.origin;
    if (typeof origin === 'string' && !config.cors.adminOrigins.includes(origin)) {
      throw new ForbiddenError('Origin not allowed');
    }
  };
  const extensionCredentialPreHandler = async (request: FastifyRequest) => {
    await authenticateRequest(request, authService);
    const context = request.auth;
    if (!context || context.mechanism !== 'bearer' || context.session.clientType !== 'extension') {
      throw new ForbiddenError();
    }
  };

  app.get(route(prefix, '/platform-accounts'), { preHandler: protectedPreHandler }, async (request) => {
    const context = request.auth as NonNullable<typeof request.auth>;
    const accounts = await service.list(context.user.role);
    const includeContactNames = context.user.role === 'admin'
      && context.mechanism === 'cookie'
      && context.session.clientType === 'admin_ui';
    return { platformAccounts: accounts.map((account) => publicPlatformAccount(account, includeContactNames)) };
  });

  app.post(route(prefix, '/platform-accounts'), { preHandler: adminPreHandler }, async (request, reply) => {
    assertCookieWrite(request, authService, config);
    const body = bodyOf(request);
    const label = requiredString(body, 'label');
    const account = requiredString(body, 'account');
    const password = requiredString(body, 'password');
    const enabled = optionalBoolean(body, 'enabled') ?? true;
    const salespersonName = optionalContactName(body, 'salespersonName') ?? null;
    const assistantName = optionalContactName(body, 'assistantName') ?? null;
    if ((salespersonName === null) !== (assistantName === null)) throw new ValidationError([{ field: 'contacts', code: 'pair_required' }]);
    try {
      const created = await service.create(
        (request.auth as NonNullable<typeof request.auth>).user.id,
        label,
        { account, password },
        enabled,
        { salespersonName, assistantName },
      );
      reply.code(201);
      return publicPlatformAccount(created);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('Platform account label already exists');
      throw error;
    }
  });

  app.post(route(prefix, '/platform-accounts/import'), { preHandler: adminPreHandler }, async (request, reply) => {
    assertCookieWrite(request, authService, config);
    let workbook;
    try {
      workbook = await parsePlatformAccountWorkbook(await importWorkbook(request));
    } catch (error) {
      if (error instanceof PlatformAccountImportError) {
        const code = error.code === 'ROW_LIMIT_EXCEEDED' ? 'maximum_exceeded' : error.code.toLowerCase();
        throw new ValidationError([{ field: 'file', code }]);
      }
      throw error;
    }
    const reasons = [...workbook.reasons];
    let imported = 0;
    const createdBy = (request.auth as NonNullable<typeof request.auth>).user.id;
    for (const row of workbook.rows) {
      try {
        await service.create(
          createdBy,
          row.label,
          { account: row.account, password: row.password },
          true,
          { salespersonName: row.salespersonName, assistantName: row.assistantName },
        );
        imported += 1;
      } catch (error) {
        if (isUniqueViolation(error)) reasons.push({ rowNumber: row.rowNumber, code: 'DUPLICATE_LABEL' });
        else throw error;
      }
    }
    reply.code(201);
    return { imported, skipped: reasons.length, reasons };
  });

  app.patch(route(prefix, '/platform-accounts/:id'), { preHandler: adminPreHandler }, async (request) => {
    assertCookieWrite(request, authService, config);
    const body = bodyOf(request);
    const label = optionalString(body, 'label');
    const enabled = optionalBoolean(body, 'enabled');
    const salespersonName = optionalContactName(body, 'salespersonName');
    const assistantName = optionalContactName(body, 'assistantName');
    if ((salespersonName === null) !== (assistantName === null)) throw new ValidationError([{ field: 'contacts', code: 'pair_required' }]);
    const hasAccount = body.account !== undefined;
    const hasPassword = body.password !== undefined;
    if (hasAccount !== hasPassword) {
      throw new ValidationError([{ field: hasAccount ? 'password' : 'account', code: 'required' }]);
    }
    const account = hasAccount ? requiredString(body, 'account') : undefined;
    const password = hasPassword ? requiredString(body, 'password') : undefined;
    if (label === undefined && enabled === undefined && account === undefined && password === undefined && salespersonName === undefined && assistantName === undefined) {
      throw new ValidationError([{ field: 'body', code: 'no_changes' }]);
    }
    try {
      const updated = await service.update(
        (request.params as { id: string }).id,
        { label, enabled, salespersonName, assistantName },
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

  if (prefix === '/api/v1') {
    app.get(route(prefix, '/platform-accounts/:id/credential-view'), { preHandler: credentialViewPreHandler }, async (request, reply) => {
      return service.credential((request.params as { id: string }).id);
    });
  }

  app.post(route(prefix, '/platform-accounts/:id/credential'), { preHandler: extensionCredentialPreHandler }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = (request.params as { id: string }).id;
    const [record, credential] = await Promise.all([service.get(id), service.credential(id)]);
    return { label: record.label, ...credential };
  });
}
