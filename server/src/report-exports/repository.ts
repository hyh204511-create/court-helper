import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type {
  NewReportExport,
  ReportExportCursor,
  ReportExportListOptions,
  ReportExportPage,
  ReportExportRecord,
  ReportExportRepository,
} from './types.ts';

type Queryable = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

function dateValue(value: unknown): Date {
  return value instanceof Date ? new Date(value) : new Date(String(value));
}

function reportExportFromRow(row: Record<string, unknown>): ReportExportRecord {
  return {
    id: String(row.id),
    fileName: String(row.file_name),
    objectKey: String(row.object_key),
    contentType: row.content_type as ReportExportRecord['contentType'],
    byteSize: Number(row.byte_size),
    sha256: String(row.sha256),
    platformAccountId: row.platform_account_id == null ? null : String(row.platform_account_id),
    createdBy: String(row.created_by),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function cursorValues(cursor: ReportExportCursor, values: unknown[]): string {
  values.push(cursor.createdAt, cursor.id);
  return `(created_at < $${values.length - 1} OR (created_at = $${values.length - 1} AND id < $${values.length}))`;
}

export class PgReportExportRepository implements ReportExportRepository {
  private readonly database: Queryable;

  constructor(database: Pick<Pool, 'query'>) {
    this.database = database as unknown as Queryable;
  }

  async findById(id: string, createdBy?: string): Promise<ReportExportRecord | null> {
    const values: unknown[] = [id];
    const ownerClause = createdBy === undefined ? '' : ' AND created_by = $2';
    if (createdBy !== undefined) values.push(createdBy);
    const result = await this.database.query(
      `SELECT * FROM report_exports WHERE id = $1${ownerClause} LIMIT 1`,
      values,
    );
    return result.rows[0] ? reportExportFromRow(result.rows[0]) : null;
  }

  async findBySha256AndCreatedBy(sha256: string, createdBy: string, platformAccountId: string): Promise<ReportExportRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM report_exports WHERE sha256 = $1 AND created_by = $2 AND platform_account_id = $3 LIMIT 1',
      [sha256, createdBy, platformAccountId],
    );
    return result.rows[0] ? reportExportFromRow(result.rows[0]) : null;
  }

  async list(options: ReportExportListOptions): Promise<ReportExportPage> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (options.createdBy !== undefined) {
      values.push(options.createdBy);
      conditions.push(`created_by = $${values.length}`);
    }
    if (options.platformAccountId !== undefined) {
      values.push(options.platformAccountId);
      conditions.push(`platform_account_id = $${values.length}`);
    }
    if (options.cursor !== undefined) {
      conditions.push(cursorValues(options.cursor, values));
    }

    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    values.push(options.limit + 1);
    const result = await this.database.query(`
      SELECT *
      FROM report_exports
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}
    `, values);
    const rows = result.rows.map(reportExportFromRow);
    const items = rows.slice(0, options.limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > options.limit && last
        ? { createdAt: new Date(last.createdAt), id: last.id }
        : null,
    };
  }

  async create(input: NewReportExport): Promise<ReportExportRecord> {
    const result = await this.database.query(`
      INSERT INTO report_exports (
        id, file_name, object_key, content_type, byte_size, sha256, platform_account_id, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      input.id ?? randomUUID(),
      input.fileName,
      input.objectKey,
      input.contentType,
      input.byteSize,
      input.sha256,
      input.platformAccountId,
      input.createdBy,
    ]);
    return reportExportFromRow(result.rows[0]);
  }

  async delete(id: string): Promise<void> {
    await this.database.query('DELETE FROM report_exports WHERE id = $1', [id]);
  }
}
