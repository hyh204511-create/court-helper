import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { assertCookieWrite, authenticateRequest } from '../auth/routes.ts';
import { AuthService } from '../auth/service.ts';
import type { ServerConfig } from '../config.ts';
import type { BrowserCommandService } from '../browser-commands/service.ts';
import {
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../errors.ts';
import {
  decodeImportBatchCursor,
  encodeImportBatchCursor,
  isImportBatchUuid,
  MAX_IMPORT_BATCH_BYTES,
  publicImportBatch,
  ImportBatchService,
} from './service.ts';
import { IMPORT_BATCH_CONTENT_TYPE, type ImportBatchAccess } from './types.ts';

interface RegisterImportBatchOptions {
  service: ImportBatchService;
  authService: AuthService;
  config: ServerConfig;
  prefix: string;
  browserCommandService?: BrowserCommandService;
}

interface MultipartFileData {
  buffer: Buffer;
  contentType: string;
  fileName: string;
}

interface QueryParams {
  cursor?: unknown;
  limit?: unknown;
}

function route(prefix: string, path: string): string {
  return `${prefix}${path}`;
}

function accessOf(request: FastifyRequest): ImportBatchAccess {
  const auth = request.auth as NonNullable<typeof request.auth>;
  return { userId: auth.user.id };
}

async function readFilePart(part: MultipartFile): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of part.file) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size <= MAX_IMPORT_BATCH_BYTES) chunks.push(value);
  }
  if ((part.file as typeof part.file & { truncated?: boolean }).truncated || size > MAX_IMPORT_BATCH_BYTES) {
    throw new PayloadTooLargeError();
  }
  return Buffer.concat(chunks, size);
}

async function multipartUpload(request: FastifyRequest): Promise<MultipartFileData> {
  if (!request.isMultipart()) {
    throw new ValidationError([{ field: 'body', code: 'multipart_required' }]);
  }

  let file: MultipartFileData | null = null;
  let validationError: ValidationError | null = null;
  try {
    for await (const part of request.parts({
      limits: {
        fileSize: MAX_IMPORT_BATCH_BYTES,
        files: 2,
        fields: 2,
        parts: 4,
      },
    })) {
      if (part.type === 'file') {
        const buffer = await readFilePart(part);
        if (part.fieldname !== 'file' || file !== null) {
          validationError ??= new ValidationError([{ field: part.fieldname, code: 'unexpected_file' }]);
          continue;
        }
        file = {
          buffer,
          contentType: part.mimetype,
          fileName: part.filename,
        };
        continue;
      }
      validationError ??= new ValidationError([{ field: part.fieldname, code: 'unexpected_field' }]);
    }
  } catch (error) {
    if ((error as { statusCode?: number })?.statusCode === 413) throw new PayloadTooLargeError();
    throw error;
  }

  if (validationError) throw validationError;
  if (file === null) throw new ValidationError([{ field: 'file', code: 'file_required' }]);
  return file;
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
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 200) {
    throw new ValidationError([{ field: 'limit', code: parsed > 200 ? 'maximum_exceeded' : 'positive_required' }]);
  }
  return parsed;
}

function queryCursor(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError([{ field: 'cursor', code: 'invalid' }]);
  }
  return decodeImportBatchCursor(value);
}

function importBatchId(request: FastifyRequest): string {
  const id = (request.params as { id?: unknown }).id;
  if (!isImportBatchUuid(id)) throw new NotFoundError('Import batch not found');
  return id;
}

export function registerImportBatchRoutes(
  app: FastifyInstance,
  options: RegisterImportBatchOptions,
): void {
  const { authService, browserCommandService, config, prefix, service } = options;
  const protectedPreHandler = async (request: FastifyRequest) => authenticateRequest(request, authService);
  const extensionPreHandler = async (request: FastifyRequest) => {
    await authenticateRequest(request, authService);
    if (request.auth?.session.clientType !== 'extension' || !request.auth.extensionDevice) throw new ForbiddenError();
  };

  app.post(route(prefix, '/import-batches'), { preHandler: protectedPreHandler }, async (request, reply) => {
    assertCookieWrite(request, authService, config);
    const result = await service.upload(await multipartUpload(request), accessOf(request));
    reply.code(201);
    return publicImportBatch(result);
  });

  app.get(route(prefix, '/import-batches'), { preHandler: protectedPreHandler }, async (request) => {
    const query = queryOf(request);
    const page = await service.list({
      limit: queryLimit(query.limit),
      cursor: queryCursor(query.cursor),
    }, accessOf(request));
    return {
      importBatches: page.items.map(publicImportBatch),
      nextCursor: page.nextCursor ? encodeImportBatchCursor(page.nextCursor) : null,
    };
  });

  app.get(route(prefix, '/import-batches/:id/content'), { preHandler: protectedPreHandler }, async (request, reply) => {
    const id = importBatchId(request);
    const { importBatch, stream } = await service.download(id, accessOf(request));
    reply
      .header('cache-control', 'private, no-store')
      .header('content-type', IMPORT_BATCH_CONTENT_TYPE)
      .header('content-length', String(importBatch.byteSize))
      .header('x-content-sha256', importBatch.sha256)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(importBatch.fileName)}`);
    return reply.send(stream);
  });

  if (browserCommandService) {
    app.get(route(prefix, '/import-batches/:id/extension-data'), { preHandler: extensionPreHandler }, async (request, reply) => {
      const id = importBatchId(request);
      const headers = request.headers as Record<string, unknown>;
      const commandId = headers['x-browser-command-id'];
      const claimedDeviceId = headers['x-browser-command-device'];
      const claimToken = headers['x-browser-command-claim'];
      if (typeof commandId !== 'string' || typeof claimedDeviceId !== 'string' || typeof claimToken !== 'string') {
        throw new ValidationError([{ field: 'claim', code: 'required' }]);
      }
      const context = request.auth;
      if (!context?.extensionDevice) throw new ForbiddenError();
      await browserCommandService.authorizeExecutionData(
        commandId,
        id,
        context.extensionDevice.deviceId,
        claimToken,
      );
      const result = await service.readExecutionData(id);
      reply.header('cache-control', 'private, no-store');
      return {
        importBatchId: id,
        rows: result.rows,
      };
    });
  }
}
