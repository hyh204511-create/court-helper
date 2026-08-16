import { createHash, randomUUID } from 'node:crypto';

import ExcelJS from 'exceljs';

import {
  AppError,
  ConflictError,
  DependencyUnavailableError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../errors.ts';
import { RETENTION_WINDOW_MS } from '../retention/policy.ts';
import type { StorageBackend } from '../storage/types.ts';
import {
  IMPORT_BATCH_CONTENT_TYPE,
  type ImportBatchAccess,
  type ImportBatchCursor,
  type ImportBatchListOptions,
  type ImportBatchPage,
  type ImportBatchRecord,
  type ImportBatchRepository,
  type NewImportBatch,
} from './types.ts';

export const MAX_IMPORT_BATCH_BYTES = 20 * 1024 * 1024;
export const MAX_IMPORT_BATCH_WORKSHEETS = 2;
export const MAX_IMPORT_BATCH_ROWS = 5_000;
export const MAX_IMPORT_BATCH_COLUMNS = 22;
export const IMPORT_BATCH_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const LI_HEADERS = [
  '原告', '被告', '账号', '密码', '立案状态', '立案成功时间', '案号',
  '成功图片', '驳回时间', '驳回原因', '驳回图片', '查询时间',
] as const;
const COMBINED_HEADERS = [
  ...LI_HEADERS.slice(0, 11), '立案查询时间',
  '强执状态', '强执成功时间', '强执案号', '成功图片',
  '驳回时间', '驳回原因', '驳回图片', '强执查询时间',
] as const;
const COMBINED_SALESPERSON_HEADER = '业务员';
const COMBINED_ASSISTANT_HEADER = '助理';
const COMBINED_SALESPERSON_COLUMN = COMBINED_HEADERS.length + 1;
const COMBINED_ASSISTANT_COLUMN = COMBINED_HEADERS.length + 2;
const BUSINESS_NAME_LIMIT = 100;

export interface ImportBatchUploadInput {
  fileName: string;
  contentType: string;
  buffer: Buffer;
}

export interface ImportBatchSummary {
  liRows: number;
  qzRows: number;
  skippedRows: number;
}

export interface ImportBatchExecutionRow {
  kind: 'li' | 'qz';
  account: string;
  plaintiff: string;
  defendant: string;
  status: string;
  filedTime: string | null;
  caseNumber: string | null;
  rejectTime: string | null;
  rejectReason: string | null;
  queryTime: string | null;
  salesperson: string | null;
  assistant: string | null;
}

function validation(code: string): ValidationError {
  return new ValidationError([{ field: 'file', code }]);
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

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function fallbackFileName(now: Date): string {
  const date = Number.isFinite(now.getTime())
    ? now.toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  return `import-${date}.xlsx`;
}

function allowedFileNameCharacter(value: string): boolean {
  return /[\p{L}\p{N}_.\-（）]/u.test(value);
}

export function sanitizeImportBatchFileName(fileName: string, now = new Date()): string {
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

export function validateImportBatchContentType(buffer: Buffer, declaredContentType: string): void {
  if (declaredContentType !== IMPORT_BATCH_CONTENT_TYPE) {
    throw validation('mime_mismatch');
  }
  if (!buffer.subarray(0, XLSX_MAGIC.length).equals(XLSX_MAGIC)) {
    throw validation('magic_not_allowed');
  }
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return '';

  const candidate = value as {
    text?: unknown;
    result?: unknown;
    richText?: unknown;
  };
  if (typeof candidate.text === 'string') return candidate.text.trim();
  if (candidate.result !== undefined) return cellText(candidate.result);
  if (Array.isArray(candidate.richText)) {
    return candidate.richText
      .map((part) => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .join('')
      .trim();
  }
  return '';
}

function hasLiHeader(sheet: ExcelJS.Worksheet): boolean {
  return LI_HEADERS.every((header, index) => cellText(sheet.getCell(1, index + 1).value) === header);
}

function hasCombinedHeader(sheet: ExcelJS.Worksheet): boolean {
  if (!COMBINED_HEADERS.every((header, index) => cellText(sheet.getCell(1, index + 1).value) === header)) {
    return false;
  }
  if (sheet.columnCount === COMBINED_HEADERS.length) return true;
  if (cellText(sheet.getCell(1, COMBINED_SALESPERSON_COLUMN).value) !== COMBINED_SALESPERSON_HEADER) return false;
  return sheet.columnCount === COMBINED_SALESPERSON_COLUMN
    || (sheet.columnCount === COMBINED_ASSISTANT_COLUMN
      && cellText(sheet.getCell(1, COMBINED_ASSISTANT_COLUMN).value) === COMBINED_ASSISTANT_HEADER);
}

function validateBusinessAssignments(sheet: ExcelJS.Worksheet): void {
  const seen = new Map<string, string>();
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const salesperson = cellText(sheet.getCell(row, COMBINED_SALESPERSON_COLUMN).value);
    const assistant = cellText(sheet.getCell(row, COMBINED_ASSISTANT_COLUMN).value);
    if (salesperson.length > BUSINESS_NAME_LIMIT || assistant.length > BUSINESS_NAME_LIMIT) {
      throw validation('business_name_too_long');
    }
    if (!salesperson && !assistant) continue;
    const account = cellText(sheet.getCell(row, 3).value);
    const plaintiff = cellText(sheet.getCell(row, 1).value);
    const defendant = cellText(sheet.getCell(row, 2).value);
    if (!account || !plaintiff) throw validation('business_identity_required');
    const key = [account, plaintiff, defendant].join('\u0000');
    const value = [salesperson, assistant].join('\u0000');
    const existing = seen.get(key);
    if (existing !== undefined && existing !== value) throw validation('business_assignment_conflict');
    seen.set(key, value);
  }
}

function enforcementHeaderRow(sheet: ExcelJS.Worksheet): number | null {
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    if (
      cellText(sheet.getCell(row, 1).value) === '原告'
      && cellText(sheet.getCell(row, 5).value) === '强执状态'
    ) return row;
  }
  return null;
}

function summarizeRows(sheet: ExcelJS.Worksheet, startRow: number, endRow: number): {
  validRows: number;
  skippedRows: number;
} {
  let validRows = 0;
  let skippedRows = 0;
  for (let row = startRow; row <= endRow; row += 1) {
    const plaintiff = cellText(sheet.getCell(row, 1).value);
    const account = cellText(sheet.getCell(row, 3).value);
    if (plaintiff === '' && account === '') continue;
    if (plaintiff === '' || account === '') {
      skippedRows += 1;
      continue;
    }
    validRows += 1;
  }
  return { validRows, skippedRows };
}

export async function summarizeImportBatch(buffer: Buffer): Promise<ImportBatchSummary> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(
      buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
      { ignoreNodes: ['drawing', 'picture', 'legacyDrawing', 'legacyDrawingHF'] },
    );
  } catch {
    throw validation('template_mismatch');
  }

  if (workbook.worksheets.length > MAX_IMPORT_BATCH_WORKSHEETS) {
    throw validation('template_limit_exceeded');
  }
  const sheet = workbook.getWorksheet('Sheet1');
  if (!sheet) throw validation('sheet_required');
  if (sheet.rowCount > MAX_IMPORT_BATCH_ROWS || sheet.columnCount > MAX_IMPORT_BATCH_COLUMNS) {
    throw validation('template_limit_exceeded');
  }
  if (sheet.columnCount > LI_HEADERS.length) {
    if (!hasCombinedHeader(sheet)) throw validation('template_mismatch');
    validateBusinessAssignments(sheet);
    const combined = summarizeRows(sheet, 2, sheet.rowCount);
    return {
      liRows: combined.validRows,
      qzRows: combined.validRows,
      skippedRows: combined.skippedRows,
    };
  }
  if (!hasLiHeader(sheet)) throw validation('template_mismatch');

  const qzHeaderRow = enforcementHeaderRow(sheet);
  if (qzHeaderRow === null) throw validation('enforcement_header_required');
  const li = summarizeRows(sheet, 2, qzHeaderRow - 1);
  const qz = summarizeRows(sheet, qzHeaderRow + 1, sheet.rowCount);
  return {
    liRows: li.validRows,
    qzRows: qz.validRows,
    skippedRows: li.skippedRows + qz.skippedRows,
  };
}

export function publicImportBatch(value: ImportBatchRecord, access: ImportBatchAccess) {
  return {
    id: value.id,
    fileName: value.fileName,
    byteSize: value.byteSize,
    sha256: value.sha256,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
    expiresAt: value.expiresAt.toISOString(),
    liRows: value.liRows,
    qzRows: value.qzRows,
    skippedRows: value.skippedRows,
    canDelete: access.role === 'admin' || value.createdBy === access.userId,
  };
}

export function isImportBatchUuid(value: unknown): value is string {
  return typeof value === 'string' && IMPORT_BATCH_UUID_PATTERN.test(value);
}

export class ImportBatchService {
  public readonly repository: ImportBatchRepository;
  private readonly storage: StorageBackend;
  private readonly clock: () => Date;

  constructor(
    repository: ImportBatchRepository,
    storage: StorageBackend,
    clock: () => Date = () => new Date(),
  ) {
    this.repository = repository;
    this.storage = storage;
    this.clock = clock;
  }

  async upload(input: ImportBatchUploadInput, access: ImportBatchAccess): Promise<ImportBatchRecord> {
    if (input.buffer.length > MAX_IMPORT_BATCH_BYTES) throw new PayloadTooLargeError();
    if (input.buffer.length === 0) throw validation('byte_size_invalid');
    validateImportBatchContentType(input.buffer, input.contentType);
    const summary = await summarizeImportBatch(input.buffer);
    const now = new Date(this.clock());
    const id = randomUUID();
    const objectKey = `import-batches/${id}.xlsx`;
    const newImportBatch: NewImportBatch = {
      id,
      fileName: sanitizeImportBatchFileName(input.fileName, now),
      objectKey,
      contentType: IMPORT_BATCH_CONTENT_TYPE,
      byteSize: input.buffer.length,
      sha256: createHash('sha256').update(input.buffer).digest('hex'),
      liRows: summary.liRows,
      qzRows: summary.qzRows,
      skippedRows: summary.skippedRows,
      createdBy: access.userId,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + RETENTION_WINDOW_MS),
    };

    await storageCall(() => this.storage.put(objectKey, input.buffer, IMPORT_BATCH_CONTENT_TYPE));
    try {
      return await this.repository.create(newImportBatch);
    } catch (error) {
      try {
        await storageDeleteCall(() => this.storage.delete(objectKey));
      } catch {
        // The original metadata failure stays authoritative and never includes the object key.
      }
      throw error;
    }
  }

  async list(options: ImportBatchListOptions, _access: ImportBatchAccess): Promise<ImportBatchPage> {
    return this.repository.list(options);
  }

  async get(id: string, _access: ImportBatchAccess): Promise<ImportBatchRecord> {
    const value = await this.repository.findById(id);
    if (!value) throw new NotFoundError('Import batch not found');
    return value;
  }

  async download(id: string, access: ImportBatchAccess): Promise<{
    importBatch: ImportBatchRecord;
    stream: NodeJS.ReadableStream;
  }> {
    const importBatch = await this.get(id, access);
    const stream = await storageCall(() => this.storage.get(importBatch.objectKey));
    if (!stream) throw new NotFoundError('Import batch not found');
    return { importBatch, stream };
  }

  async delete(id: string, access: ImportBatchAccess): Promise<void> {
    const importBatch = await this.get(id, access);
    if (access.role !== 'admin' && importBatch.createdBy !== access.userId) throw new ForbiddenError();
    await storageDeleteCall(() => this.storage.delete(importBatch.objectKey));
    await this.repository.delete(importBatch.id);
  }

  async readExecutionData(id: string): Promise<{ importBatch: ImportBatchRecord; rows: ImportBatchExecutionRow[] }> {
    const importBatch = await this.get(id, { userId: 'extension', role: 'extension' });
    if (importBatch.expiresAt.getTime() <= this.clock().getTime()) {
      throw new ConflictError('Import batch expired', 'IMPORT_BATCH_EXPIRED');
    }
    const stream = await storageCall(() => this.storage.get(importBatch.objectKey));
    if (!stream) throw new NotFoundError('Import batch not found');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await readStream(stream) as unknown as Parameters<typeof workbook.xlsx.load>[0], {
      ignoreNodes: ['drawing', 'picture', 'legacyDrawing', 'legacyDrawingHF'],
    });
    const sheet = workbook.getWorksheet('Sheet1');
    if (!sheet) throw validation('sheet_required');
    const rows: ImportBatchExecutionRow[] = [];
    const collect = (
      start: number,
      end: number,
      kind: 'li' | 'qz',
      statusColumn = 5,
      includeBusinessAssignments = false,
    ) => {
      for (let row = start; row <= end; row += 1) {
        const plaintiff = cellText(sheet.getCell(row, 1).value);
        const account = cellText(sheet.getCell(row, 3).value);
        if (!plaintiff && !account) continue;
        if (!plaintiff || !account) continue;
        const date = (column: number) => {
          const value = sheet.getCell(row, column).value;
          if (value instanceof Date) return value.toISOString().slice(0, 10);
          const text = cellText(value);
          const match = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/.exec(text);
          return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : null;
        };
        rows.push({
          kind,
          account,
          plaintiff,
          defendant: cellText(sheet.getCell(row, 2).value),
          status: cellText(sheet.getCell(row, statusColumn).value) || 'UNKNOWN',
          filedTime: date(statusColumn + 1),
          caseNumber: cellText(sheet.getCell(row, statusColumn + 2).value) || null,
          rejectTime: date(statusColumn + 4),
          rejectReason: cellText(sheet.getCell(row, statusColumn + 5).value) || null,
          queryTime: date(statusColumn + 7),
          salesperson: includeBusinessAssignments
            ? cellText(sheet.getCell(row, COMBINED_SALESPERSON_COLUMN).value) || null
            : null,
          assistant: includeBusinessAssignments
            ? cellText(sheet.getCell(row, COMBINED_ASSISTANT_COLUMN).value) || null
            : null,
        });
      }
    };
    if (sheet.columnCount > LI_HEADERS.length) {
      if (!hasCombinedHeader(sheet)) throw validation('template_mismatch');
      collect(2, sheet.rowCount, 'li', 5, true);
      collect(2, sheet.rowCount, 'qz', 13, true);
    } else {
      const qzHeader = enforcementHeaderRow(sheet);
      if (qzHeader === null) throw validation('enforcement_header_required');
      collect(2, qzHeader - 1, 'li');
      collect(qzHeader + 1, sheet.rowCount, 'qz');
    }
    return { importBatch, rows };
  }
}

export function encodeImportBatchCursor(cursor: ImportBatchCursor): string {
  return Buffer.from(JSON.stringify({
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  }), 'utf8').toString('base64url');
}

export function decodeImportBatchCursor(value: string): ImportBatchCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== 'string' || !isImportBatchUuid(parsed.id)) throw new Error('invalid cursor');
    const createdAt = new Date(parsed.createdAt);
    if (!Number.isFinite(createdAt.getTime())) throw new Error('invalid cursor');
    return { createdAt, id: parsed.id };
  } catch {
    throw new ValidationError([{ field: 'cursor', code: 'invalid' }]);
  }
}
