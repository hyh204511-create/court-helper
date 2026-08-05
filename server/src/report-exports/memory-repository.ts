import { randomUUID } from 'node:crypto';

import type {
  NewReportExport,
  ReportExportListOptions,
  ReportExportPage,
  ReportExportRecord,
  ReportExportRepository,
} from './types.ts';

function uniqueViolation(): Error & { code: string } {
  const error = new Error('unique constraint violation') as Error & { code: string };
  error.code = '23505';
  return error;
}

function copy(value: ReportExportRecord): ReportExportRecord {
  return {
    ...value,
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
  };
}

export class MemoryReportExportRepository implements ReportExportRepository {
  private readonly reportExports = new Map<string, ReportExportRecord>();

  constructor(values: ReportExportRecord[] = []) {
    for (const value of values) this.reportExports.set(value.id, copy(value));
  }

  async findById(id: string, createdBy?: string): Promise<ReportExportRecord | null> {
    const value = this.reportExports.get(id);
    return value && (createdBy === undefined || value.createdBy === createdBy) ? copy(value) : null;
  }

  async findBySha256AndCreatedBy(sha256: string, createdBy: string): Promise<ReportExportRecord | null> {
    const value = [...this.reportExports.values()].find(
      (candidate) => candidate.sha256 === sha256 && candidate.createdBy === createdBy,
    );
    return value ? copy(value) : null;
  }

  async list(options: ReportExportListOptions): Promise<ReportExportPage> {
    const values = [...this.reportExports.values()]
      .filter((value) => options.createdBy === undefined || value.createdBy === options.createdBy)
      .filter((value) => {
        if (options.cursor === undefined) return true;
        const valueTime = value.createdAt.getTime();
        const cursorTime = options.cursor.createdAt.getTime();
        return valueTime < cursorTime
          || (valueTime === cursorTime && value.id.localeCompare(options.cursor.id) < 0);
      })
      .sort((left, right) => (
        right.createdAt.getTime() - left.createdAt.getTime()
        || right.id.localeCompare(left.id)
      ));
    const items = values.slice(0, options.limit);
    const last = items[items.length - 1];
    return {
      items: items.map(copy),
      nextCursor: values.length > options.limit && last
        ? { createdAt: new Date(last.createdAt), id: last.id }
        : null,
    };
  }

  async create(input: NewReportExport): Promise<ReportExportRecord> {
    const id = input.id ?? randomUUID();
    if (this.reportExports.has(id)) throw uniqueViolation();
    if ([...this.reportExports.values()].some(
      (value) => value.objectKey === input.objectKey
        || (value.sha256 === input.sha256 && value.createdBy === input.createdBy),
    )) {
      throw uniqueViolation();
    }
    const now = new Date();
    const value: ReportExportRecord = {
      id,
      fileName: input.fileName,
      objectKey: input.objectKey,
      contentType: input.contentType,
      byteSize: input.byteSize,
      sha256: input.sha256,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.reportExports.set(id, value);
    return copy(value);
  }

  async delete(id: string): Promise<void> {
    this.reportExports.delete(id);
  }
}
