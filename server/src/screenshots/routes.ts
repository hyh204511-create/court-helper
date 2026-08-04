import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';

import { authenticateRequest } from '../auth/routes.ts';
import { AuthService } from '../auth/service.ts';
import {
  PayloadTooLargeError,
  ValidationError,
} from '../errors.ts';
import {
  MAX_SCREENSHOT_BYTES,
  publicScreenshot,
  ScreenshotService,
} from './service.ts';
import {
  SCREENSHOT_CONTENT_TYPES,
  SCREENSHOT_TYPES,
  type ScreenshotContentType,
  type ScreenshotType,
} from './types.ts';

interface RegisterScreenshotOptions {
  service: ScreenshotService;
  authService: AuthService;
  prefix: string;
}

const FIELD_NAMES = new Set(['eventId', 'type', 'capturedAt', 'sha256']);

interface MultipartFileData {
  buffer: Buffer;
  contentType: string;
}

function route(prefix: string, path: string): string {
  return `${prefix}${path}`;
}

function requiredString(fields: Map<string, string>, field: string): string {
  const value = fields.get(field);
  if (value === undefined || value.trim() === '') {
    throw new ValidationError([{ field, code: 'required' }]);
  }
  return value;
}

function enumValue(value: string, field: string, values: readonly string[]): string {
  if (!values.includes(value)) throw new ValidationError([{ field, code: 'invalid_enum' }]);
  return value;
}

function capturedAtValue(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ValidationError([{ field: 'capturedAt', code: 'datetime_required' }]);
  }
  return parsed;
}

function sha256Value(value: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new ValidationError([{ field: 'sha256', code: 'sha256_required' }]);
  }
  return value.toLowerCase();
}

async function readFilePart(part: MultipartFile): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of part.file) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size <= MAX_SCREENSHOT_BYTES) chunks.push(value);
  }
  if ((part.file as typeof part.file & { truncated?: boolean }).truncated || size > MAX_SCREENSHOT_BYTES) {
    throw new PayloadTooLargeError();
  }
  return Buffer.concat(chunks, size);
}

async function multipartUpload(request: FastifyRequest, caseId: string) {
  if (!request.isMultipart()) {
    throw new ValidationError([{ field: 'body', code: 'multipart_required' }]);
  }

  const fields = new Map<string, string>();
  let file: MultipartFileData | null = null;
  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        const buffer = await readFilePart(part);
        if (part.fieldname !== 'file' || file !== null) {
          throw new ValidationError([{ field: part.fieldname, code: 'unexpected_file' }]);
        }
        file = { buffer, contentType: part.mimetype };
        continue;
      }
      if (!FIELD_NAMES.has(part.fieldname)) {
        throw new ValidationError([{ field: part.fieldname, code: 'unknown_field' }]);
      }
      if (typeof part.value !== 'string') {
        throw new ValidationError([{ field: part.fieldname, code: 'string_required' }]);
      }
      if (fields.has(part.fieldname)) {
        throw new ValidationError([{ field: part.fieldname, code: 'duplicate_field' }]);
      }
      fields.set(part.fieldname, part.value);
    }
  } catch (error) {
    if ((error as { statusCode?: number })?.statusCode === 413) {
      throw new PayloadTooLargeError();
    }
    throw error;
  }

  if (file === null) {
    throw new ValidationError([{ field: 'file', code: 'required' }]);
  }
  const buffer = file.buffer;
  const contentType = file.contentType;
  if (!SCREENSHOT_CONTENT_TYPES.includes(contentType as ScreenshotContentType)) {
    throw new ValidationError([{ field: 'file', code: 'mime_not_allowed' }]);
  }

  const expectedHash = sha256Value(requiredString(fields, 'sha256'));
  const actualHash = createHash('sha256').update(buffer).digest('hex');
  if (actualHash !== expectedHash) {
    throw new ValidationError([{ field: 'sha256', code: 'mismatch' }]);
  }

  return {
    caseId,
    eventId: requiredString(fields, 'eventId'),
    type: enumValue(requiredString(fields, 'type'), 'type', SCREENSHOT_TYPES) as ScreenshotType,
    capturedAt: capturedAtValue(requiredString(fields, 'capturedAt')),
    sha256: actualHash,
    contentType: contentType as ScreenshotContentType,
    buffer,
  };
}

function downloadValue(request: FastifyRequest): boolean {
  const query = request.query as { download?: unknown } | undefined;
  if (query?.download === undefined || query.download === '0') return false;
  if (query.download === '1') return true;
  throw new ValidationError([{ field: 'download', code: 'boolean_required' }]);
}

export function registerScreenshotRoutes(
  app: FastifyInstance,
  options: RegisterScreenshotOptions,
): void {
  const { authService, prefix, service } = options;
  const protectedPreHandler = async (request: FastifyRequest) => authenticateRequest(request, authService);

  app.post(route(prefix, '/cases/:id/screenshots'), { preHandler: protectedPreHandler }, async (request, reply) => {
    const caseId = (request.params as { id: string }).id;
    const result = await service.upload(await multipartUpload(request, caseId));
    reply.code(result.created ? 201 : 200);
    return publicScreenshot(result.screenshot, prefix);
  });

  app.get(route(prefix, '/cases/:id/screenshots'), { preHandler: protectedPreHandler }, async (request) => {
    const caseId = (request.params as { id: string }).id;
    const screenshots = await service.listForCase(caseId);
    return { screenshots: screenshots.map((value) => publicScreenshot(value, prefix)) };
  });

  app.get(route(prefix, '/screenshots/:id/content'), { preHandler: protectedPreHandler }, async (request, reply) => {
    const download = downloadValue(request);
    const id = (request.params as { id: string }).id;
    const { screenshot, stream } = await service.content(id);
    const extension = screenshot.contentType === 'image/png' ? 'png' : 'jpg';
    reply
      .header('cache-control', 'private, no-store')
      .header('content-type', screenshot.contentType)
      .header('content-length', String(screenshot.byteSize))
      .header(
        'content-disposition',
        `${download ? 'attachment' : 'inline'}; filename="screenshot-${screenshot.id}.${extension}"`,
      );
    return reply.send(stream);
  });
}
