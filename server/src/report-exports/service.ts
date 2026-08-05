import { createHash, randomUUID } from 'node:crypto';

import {
  AppError,
  DependencyUnavailableError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../errors.ts';
import type { StorageBackend } from '../storage/types.ts';
import type {
  NewReportExport,
  ReportExportAccess,
  ReportExportCursor,
  ReportExportListOptions,
  ReportExportPage,
  ReportExportRecord,
  ReportExportRepository,
} from './types.ts';
import { REPORT_EXPORT_CONTENT_TYPE } from './types.ts';

export const MAX_REPORT_EXPORT_BYTES = 20 * 1024 * 1024;
export const REPORT_EXPORT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReportExportUploadInput {
  fileName: string;
  contentType: string;
  sha256: string;
  buffer: Buffer;
}

export interface ReportExportUploadResult {
  reportExport: ReportExportRecord;
  created: boolean;
}

const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function uniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}

async function storageCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new DependencyUnavailableError();
  }
}

function isMissingObjectError(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  const code = typeof candidate?.code === 'string' ? candidate.code.toLowerCase() : '';
  return (
    code === 'enoent'
    || code === 'nosuchkey'
    || code === 'nosuchobject'
    || code === 'notfound'
    || code === 'object_not_found'
    || candidate?.status === 404
    || candidate?.statusCode === 404
  );
}

async function storageDeleteCall(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (isMissingObjectError(error)) return;
    if (error instanceof AppError) throw error;
    throw new DependencyUnavailableError();
  }
}

function fallbackFileName(now: Date): string {
  const timestamp = Number.isFinite(now.getTime()) ? now.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  return `report-${timestamp}.xlsx`;
}

function allowedFileNameCharacter(value: string): boolean {
  return /[\p{L}\p{N}_.\-（）]/u.test(value);
}

export function sanitizeReportExportFileName(fileName: string, now = new Date()): string {
  try {
    const baseName = fileName.replaceAll('\\', '/').split('/').pop() ?? '';
    const filtered = Array.from(baseName.replace(/[\u0000-\u001f\u007f-\u009f]/g, ''))
      .filter(allowedFileNameCharacter)
      .join('');
    if (!/[\p{L}\p{N}]/u.test(filtered)) return fallbackFileName(now);

    const withoutXlsx = filtered.replace(/\.xlsx$/iu, '');
    if (!/[\p{L}\p{N}]/u.test(withoutXlsx)) return fallbackFileName(now);
    const normalized = `${withoutXlsx}.xlsx`;
    if (normalized.length <= 200) return normalized;
    return `${withoutXlsx.slice(0, 200 - '.xlsx'.length)}.xlsx`;
  } catch {
    return fallbackFileName(now);
  }
}

export function validateReportExportContentType(buffer: Buffer, declaredContentType: string): void {
  if (declaredContentType !== REPORT_EXPORT_CONTENT_TYPE) {
    throw new ValidationError([{ field: 'file', code: 'mime_mismatch' }]);
  }
  if (!buffer.subarray(0, XLSX_MAGIC.length).equals(XLSX_MAGIC)) {
    throw new ValidationError([{ field: 'file', code: 'magic_not_allowed' }]);
  }
}

function validateSha256(value: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new ValidationError([{ field: 'sha256', code: 'sha256_invalid' }]);
  }
  return value.toLowerCase();
}

function ownerId(access: ReportExportAccess): string | undefined {
  return access.role === 'admin' ? undefined : access.userId;
}

export function publicReportExport(value: ReportExportRecord) {
  return {
    id: value.id,
    fileName: value.fileName,
    byteSize: value.byteSize,
    sha256: value.sha256,
    createdAt: value.createdAt.toISOString(),
    createdBy: value.createdBy,
  };
}

export function publicReportExportUpload(value: ReportExportRecord, created: boolean) {
  return {
    id: value.id,
    fileName: value.fileName,
    byteSize: value.byteSize,
    sha256: value.sha256,
    createdAt: value.createdAt.toISOString(),
    created,
  };
}

export function isReportExportUuid(value: unknown): value is string {
  return typeof value === 'string' && REPORT_EXPORT_UUID_PATTERN.test(value);
}

export class ReportExportService {
  public readonly repository: ReportExportRepository;
  private readonly storage: StorageBackend;
  private readonly clock: () => Date;

  constructor(
    repository: ReportExportRepository,
    storage: StorageBackend,
    clock: () => Date = () => new Date(),
  ) {
    this.repository = repository;
    this.storage = storage;
    this.clock = clock;
  }

  async upload(input: ReportExportUploadInput, access: ReportExportAccess): Promise<ReportExportUploadResult> {
    if (input.buffer.length > MAX_REPORT_EXPORT_BYTES) throw new PayloadTooLargeError();
    const normalizedHash = validateSha256(input.sha256);
    validateReportExportContentType(input.buffer, input.contentType);
    const actualHash = createHash('sha256').update(input.buffer).digest('hex');
    if (actualHash !== normalizedHash) {
      throw new ValidationError([{ field: 'sha256', code: 'mismatch' }]);
    }

    const existing = await this.repository.findBySha256AndCreatedBy(normalizedHash, access.userId);
    if (existing) return { reportExport: existing, created: false };

    const objectKey = `report-exports/${randomUUID()}.xlsx`;
    await storageCall(() => this.storage.put(objectKey, input.buffer, REPORT_EXPORT_CONTENT_TYPE));

    const newReportExport: NewReportExport = {
      fileName: sanitizeReportExportFileName(input.fileName, this.clock()),
      objectKey,
      contentType: REPORT_EXPORT_CONTENT_TYPE,
      byteSize: input.buffer.length,
      sha256: normalizedHash,
      createdBy: access.userId,
    };

    try {
      const reportExport = await this.repository.create(newReportExport);
      return { reportExport, created: true };
    } catch (error) {
      await storageCall(() => this.storage.delete(objectKey));
      if (uniqueViolation(error)) {
        const concurrent = await this.repository.findBySha256AndCreatedBy(normalizedHash, access.userId);
        if (concurrent) return { reportExport: concurrent, created: false };
      }
      throw error;
    }
  }

  async list(options: ReportExportListOptions, access: ReportExportAccess): Promise<ReportExportPage> {
    return this.repository.list({
      ...options,
      createdBy: ownerId(access),
    });
  }

  async get(id: string, access: ReportExportAccess): Promise<ReportExportRecord> {
    const value = await this.repository.findById(id, ownerId(access));
    if (!value) throw new NotFoundError('Report export not found');
    return value;
  }

  private async getForAction(id: string, access: ReportExportAccess): Promise<ReportExportRecord> {
    const value = await this.repository.findById(id);
    if (!value) throw new NotFoundError('Report export not found');
    if (access.role !== 'admin' && value.createdBy !== access.userId) {
      throw new ForbiddenError();
    }
    return value;
  }

  async download(id: string, access: ReportExportAccess): Promise<{
    reportExport: ReportExportRecord;
    stream: NodeJS.ReadableStream;
  }> {
    const reportExport = await this.getForAction(id, access);
    const stream = await storageCall(() => this.storage.get(reportExport.objectKey));
    if (!stream) throw new NotFoundError('Report export not found');
    return { reportExport, stream };
  }

  async delete(id: string, access: ReportExportAccess): Promise<void> {
    const reportExport = await this.getForAction(id, access);
    await storageDeleteCall(() => this.storage.delete(reportExport.objectKey));
    await this.repository.delete(reportExport.id);
  }
}

export function encodeReportExportCursor(cursor: ReportExportCursor): string {
  return Buffer.from(JSON.stringify({
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  }), 'utf8').toString('base64url');
}

export function decodeReportExportCursor(value: string): ReportExportCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== 'string' || !isReportExportUuid(parsed.id)) throw new Error('invalid cursor');
    const createdAt = new Date(parsed.createdAt);
    if (!Number.isFinite(createdAt.getTime())) throw new Error('invalid cursor');
    return { createdAt, id: parsed.id };
  } catch {
    throw new ValidationError([{ field: 'cursor', code: 'invalid' }]);
  }
}
