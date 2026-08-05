import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';

import { assertCookieWrite, authenticateRequest } from '../auth/routes.ts';
import { AuthService } from '../auth/service.ts';
import type { ServerConfig } from '../config.ts';
import { NotFoundError, PayloadTooLargeError, ValidationError } from '../errors.ts';
import type { ReportExportAccess } from './types.ts';
import {
  decodeReportExportCursor,
  encodeReportExportCursor,
  MAX_REPORT_EXPORT_BYTES,
  isReportExportUuid,
  publicReportExport,
  publicReportExportUpload,
  ReportExportService,
} from './service.ts';
import { REPORT_EXPORT_CONTENT_TYPE } from './types.ts';

interface RegisterReportExportOptions {
  service: ReportExportService;
  authService: AuthService;
  config: ServerConfig;
  prefix: string;
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

const FIELD_NAMES = new Set(['sha256', 'clientExportId']);

function route(prefix: string, path: string): string {
  return `${prefix}${path}`;
}

function accessOf(request: FastifyRequest): ReportExportAccess {
  const auth = request.auth as NonNullable<typeof request.auth>;
  return { userId: auth.user.id, role: auth.user.role };
}

function requiredSha256(fields: Map<string, string>): string {
  const value = fields.get('sha256');
  if (value === undefined || value.trim() === '') {
    throw new ValidationError([{ field: 'sha256', code: 'sha256_required' }]);
  }
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new ValidationError([{ field: 'sha256', code: 'sha256_invalid' }]);
  }
  return value.toLowerCase();
}

async function readFilePart(part: MultipartFile): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of part.file) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size <= MAX_REPORT_EXPORT_BYTES) chunks.push(value);
  }
  if ((part.file as typeof part.file & { truncated?: boolean }).truncated || size > MAX_REPORT_EXPORT_BYTES) {
    throw new PayloadTooLargeError();
  }
  return Buffer.concat(chunks, size);
}

async function multipartUpload(request: FastifyRequest) {
  if (!request.isMultipart()) {
    throw new ValidationError([{ field: 'body', code: 'multipart_required' }]);
  }

  const fields = new Map<string, string>();
  let file: MultipartFileData | null = null;
  let validationError: ValidationError | null = null;
  try {
    for await (const part of request.parts()) {
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
      if (!FIELD_NAMES.has(part.fieldname)) {
        validationError ??= new ValidationError([{ field: part.fieldname, code: 'unknown_field' }]);
        continue;
      }
      if (typeof part.value !== 'string') {
        validationError ??= new ValidationError([{ field: part.fieldname, code: 'string_required' }]);
        continue;
      }
      if (fields.has(part.fieldname)) {
        validationError ??= new ValidationError([{ field: part.fieldname, code: 'duplicate_field' }]);
        continue;
      }
      fields.set(part.fieldname, part.value);
    }
  } catch (error) {
    if ((error as { statusCode?: number })?.statusCode === 413) throw new PayloadTooLargeError();
    throw error;
  }

  if (validationError) throw validationError;
  const sha256 = requiredSha256(fields);
  if (file === null) throw new ValidationError([{ field: 'file', code: 'file_required' }]);

  return {
    fileName: file.fileName,
    contentType: file.contentType,
    sha256,
    buffer: file.buffer,
  };
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
  return decodeReportExportCursor(value);
}

function reportExportId(request: FastifyRequest): string {
  const id = (request.params as { id?: unknown }).id;
  if (!isReportExportUuid(id)) throw new NotFoundError('Report export not found');
  return id;
}

export function registerReportExportRoutes(
  app: FastifyInstance,
  options: RegisterReportExportOptions,
): void {
  const { authService, config, prefix, service } = options;
  const protectedPreHandler = async (request: FastifyRequest) => authenticateRequest(request, authService);

  app.post(route(prefix, '/report-exports'), { preHandler: protectedPreHandler }, async (request, reply) => {
    assertCookieWrite(request, authService, config);
    const result = await service.upload(await multipartUpload(request), accessOf(request));
    reply.code(result.created ? 201 : 200);
    return publicReportExportUpload(result.reportExport, result.created);
  });

  app.get(route(prefix, '/report-exports'), { preHandler: protectedPreHandler }, async (request) => {
    const query = queryOf(request);
    const page = await service.list({
      limit: queryLimit(query.limit),
      cursor: queryCursor(query.cursor),
    }, accessOf(request));
    return {
      reportExports: page.items.map(publicReportExport),
      nextCursor: page.nextCursor ? encodeReportExportCursor(page.nextCursor) : null,
    };
  });

  app.get(route(prefix, '/report-exports/:id/download'), { preHandler: protectedPreHandler }, async (request, reply) => {
    const id = reportExportId(request);
    const { reportExport, stream } = await service.download(id, accessOf(request));
    reply
      .header('cache-control', 'private, no-store')
      .header('content-type', REPORT_EXPORT_CONTENT_TYPE)
      .header('content-length', String(reportExport.byteSize))
      .header('x-content-sha256', reportExport.sha256)
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(reportExport.fileName)}`);
    return reply.send(stream);
  });

  app.get(route(prefix, '/report-exports/:id'), { preHandler: protectedPreHandler }, async (request) => {
    const id = reportExportId(request);
    return publicReportExport(await service.get(id, accessOf(request)));
  });

  app.delete(route(prefix, '/report-exports/:id'), { preHandler: protectedPreHandler }, async (request, reply) => {
    assertCookieWrite(request, authService, config);
    const id = reportExportId(request);
    await service.delete(id, accessOf(request));
    return reply.code(204).send();
  });
}
