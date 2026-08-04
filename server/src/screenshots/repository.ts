import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type {
  NewScreenshot,
  ScreenshotRecord,
  ScreenshotRepository,
  ScreenshotType,
  ScreenshotUpdate,
} from './types.ts';

type Queryable = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

function dateValue(value: unknown): Date {
  return value instanceof Date ? new Date(value) : new Date(String(value));
}

function screenshotFromRow(row: Record<string, unknown>): ScreenshotRecord {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    type: row.type as ScreenshotRecord['type'],
    objectKey: String(row.object_key),
    contentType: row.content_type as ScreenshotRecord['contentType'],
    byteSize: Number(row.byte_size),
    sha256: String(row.sha256),
    capturedAt: dateValue(row.captured_at),
    createdAt: dateValue(row.created_at),
  };
}

export class PgScreenshotRepository implements ScreenshotRepository {
  private readonly database: Queryable;

  constructor(database: Pick<Pool, 'query'>) {
    this.database = database as unknown as Queryable;
  }

  async findById(id: string): Promise<ScreenshotRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM screenshots WHERE id = $1 LIMIT 1',
      [id],
    );
    return result.rows[0] ? screenshotFromRow(result.rows[0]) : null;
  }

  async findByCaseIdAndType(caseId: string, type: ScreenshotType): Promise<ScreenshotRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM screenshots WHERE case_id = $1 AND type = $2 LIMIT 1',
      [caseId, type],
    );
    return result.rows[0] ? screenshotFromRow(result.rows[0]) : null;
  }

  async listByCaseId(caseId: string): Promise<ScreenshotRecord[]> {
    const result = await this.database.query(
      'SELECT * FROM screenshots WHERE case_id = $1 ORDER BY created_at ASC, id ASC',
      [caseId],
    );
    return result.rows.map(screenshotFromRow);
  }

  async create(input: NewScreenshot): Promise<ScreenshotRecord> {
    const result = await this.database.query(`
      INSERT INTO screenshots (
        id, case_id, type, object_key, content_type, byte_size, sha256, captured_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      input.id ?? randomUUID(),
      input.caseId,
      input.type,
      input.objectKey,
      input.contentType,
      input.byteSize,
      input.sha256,
      input.capturedAt,
    ]);
    return screenshotFromRow(result.rows[0]);
  }

  async update(id: string, input: ScreenshotUpdate): Promise<ScreenshotRecord | null> {
    const result = await this.database.query(`
      UPDATE screenshots
      SET object_key = $2,
          content_type = $3,
          byte_size = $4,
          sha256 = $5,
          captured_at = $6
      WHERE id = $1
      RETURNING *
    `, [
      id,
      input.objectKey,
      input.contentType,
      input.byteSize,
      input.sha256,
      input.capturedAt,
    ]);
    return result.rows[0] ? screenshotFromRow(result.rows[0]) : null;
  }

  async delete(id: string): Promise<void> {
    await this.database.query('DELETE FROM screenshots WHERE id = $1', [id]);
  }
}
