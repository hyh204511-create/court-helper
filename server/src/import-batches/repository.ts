import type { Pool } from 'pg';

import type {
  ImportBatchCursor,
  ImportBatchListOptions,
  ImportBatchPage,
  ImportBatchRecord,
  ImportBatchRepository,
  NewImportBatch,
} from './types.ts';

type Queryable = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

function dateValue(value: unknown): Date {
  return value instanceof Date ? new Date(value) : new Date(String(value));
}

function importBatchFromRow(row: Record<string, unknown>): ImportBatchRecord {
  return {
    id: String(row.id),
    fileName: String(row.file_name),
    objectKey: String(row.object_key),
    contentType: row.content_type as ImportBatchRecord['contentType'],
    byteSize: Number(row.byte_size),
    sha256: String(row.sha256),
    liRows: Number(row.li_rows),
    qzRows: Number(row.qz_rows),
    skippedRows: Number(row.skipped_rows),
    createdBy: String(row.created_by),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
    expiresAt: dateValue(row.expires_at),
  };
}

function cursorClause(cursor: ImportBatchCursor, values: unknown[]): string {
  values.push(cursor.createdAt, cursor.id);
  return `(created_at < $${values.length - 1} OR (created_at = $${values.length - 1} AND id < $${values.length}))`;
}

export class PgImportBatchRepository implements ImportBatchRepository {
  private readonly database: Queryable;

  constructor(database: Pick<Pool, 'query'>) {
    this.database = database as unknown as Queryable;
  }

  async findById(id: string): Promise<ImportBatchRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM import_batches WHERE id = $1 LIMIT 1',
      [id],
    );
    return result.rows[0] ? importBatchFromRow(result.rows[0]) : null;
  }

  async list(options: ImportBatchListOptions): Promise<ImportBatchPage> {
    const values: unknown[] = [];
    const where = options.cursor === undefined ? '' : `WHERE ${cursorClause(options.cursor, values)}`;
    values.push(options.limit + 1);
    const result = await this.database.query(`
      SELECT *
      FROM import_batches
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}
    `, values);
    const rows = result.rows.map(importBatchFromRow);
    const items = rows.slice(0, options.limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > options.limit && last
        ? { createdAt: new Date(last.createdAt), id: last.id }
        : null,
    };
  }

  async create(input: NewImportBatch): Promise<ImportBatchRecord> {
    const result = await this.database.query(`
      INSERT INTO import_batches (
        id, file_name, object_key, content_type, byte_size, sha256,
        li_rows, qz_rows, skipped_rows, created_by,
        created_at, updated_at, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `, [
      input.id,
      input.fileName,
      input.objectKey,
      input.contentType,
      input.byteSize,
      input.sha256,
      input.liRows,
      input.qzRows,
      input.skippedRows,
      input.createdBy,
      input.createdAt,
      input.updatedAt,
      input.expiresAt,
    ]);
    return importBatchFromRow(result.rows[0]);
  }

  async delete(id: string): Promise<void> {
    await this.database.query('DELETE FROM import_batches WHERE id = $1', [id]);
  }
}
