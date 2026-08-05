import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type {
  CaseListOptions,
  CaseRecord,
  CaseRepository,
  CaseWriteInput,
} from './types.ts';

type Queryable = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

function dateValue(value: unknown): Date {
  return value instanceof Date ? new Date(value) : new Date(String(value));
}

function nullableDateValue(value: unknown): Date | null {
  return value === null || value === undefined ? null : dateValue(value);
}

function dateOnlyValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function dateTimeInput(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? new Date(value) : new Date(value);
}

function caseFromRow(row: Record<string, unknown>): CaseRecord {
  return {
    id: String(row.id),
    createdBy: row.created_by === null || row.created_by === undefined ? null : String(row.created_by),
    clientUid: String(row.client_uid),
    platformAccountId: String(row.platform_account_id),
    kind: row.kind as CaseRecord['kind'],
    plaintiff: row.plaintiff === null || row.plaintiff === undefined ? null : String(row.plaintiff),
    defendant: row.defendant === null || row.defendant === undefined ? null : String(row.defendant),
    status: row.status as CaseRecord['status'],
    filedTime: dateOnlyValue(row.filed_time),
    caseNumber: row.case_number === null || row.case_number === undefined ? null : String(row.case_number),
    rejectTime: dateOnlyValue(row.reject_time),
    rejectReason: row.reject_reason === null || row.reject_reason === undefined ? null : String(row.reject_reason),
    queryTime: nullableDateValue(row.query_time),
    needsHuman: Boolean(row.needs_human),
    errorCode: row.error_code === null || row.error_code === undefined ? null : String(row.error_code),
    sourceEventId: row.source_event_id === null || row.source_event_id === undefined ? '' : String(row.source_event_id),
    sourceUpdatedAt: nullableDateValue(row.source_updated_at),
    revision: Number(row.revision),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function writeValues(input: CaseWriteInput): unknown[] {
  return [
    input.id ?? randomUUID(),
    input.clientUid,
    input.platformAccountId,
    input.createdBy ?? null,
    input.kind,
    input.plaintiff,
    input.defendant,
    input.status,
    input.filedTime,
    input.caseNumber,
    input.rejectTime,
    input.rejectReason,
    dateTimeInput(input.queryTime),
    input.needsHuman,
    input.errorCode,
    input.sourceEventId,
    dateTimeInput(input.sourceUpdatedAt),
  ];
}

export class PgCaseRepository implements CaseRepository {
  private readonly database: Queryable;

  constructor(database: Pick<Pool, 'query'>) {
    this.database = database as unknown as Queryable;
  }

  private async findByIdWithOwner(id: string, createdBy?: string): Promise<CaseRecord | null> {
    const values: unknown[] = [id];
    const ownerClause = createdBy === undefined ? '' : ' AND created_by = $2';
    if (createdBy !== undefined) values.push(createdBy);
    const result = await this.database.query(
      `SELECT * FROM cases WHERE id = $1${ownerClause} LIMIT 1`,
      values,
    );
    return result.rows[0] ? caseFromRow(result.rows[0]) : null;
  }

  async findById(id: string, createdBy?: string): Promise<CaseRecord | null> {
    return this.findByIdWithOwner(id, createdBy);
  }

  async findByClientUid(clientUid: string, createdBy?: string): Promise<CaseRecord | null> {
    const values: unknown[] = [clientUid];
    const ownerClause = createdBy === undefined ? '' : ' AND created_by = $2';
    if (createdBy !== undefined) values.push(createdBy);
    const result = await this.database.query(
      `SELECT * FROM cases WHERE client_uid = $1${ownerClause} LIMIT 1`,
      values,
    );
    return result.rows[0] ? caseFromRow(result.rows[0]) : null;
  }

  async list(options: Partial<CaseListOptions> = {}): Promise<CaseRecord[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (condition: string, value: unknown) => {
      values.push(value);
      conditions.push(condition.replace('?', `$${values.length}`));
    };

    if (options.createdBy !== undefined) add('created_by = ?', options.createdBy);
    if (options.kind !== undefined) add('kind = ?', options.kind);
    if (options.status !== undefined) add('status = ?', options.status);
    if (options.platformAccountId !== undefined) add('platform_account_id = ?', options.platformAccountId);
    if (options.needsHuman !== undefined) add('needs_human = ?', options.needsHuman);
    if (options.from !== undefined) add('filed_time >= ?::date', options.from);
    if (options.to !== undefined) add('filed_time <= ?::date', options.to);
    if (options.afterRevision !== undefined) add('revision > ?', options.afterRevision);

    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const limit = options.limit ?? 200;
    values.push(limit);
    const result = await this.database.query(`
      SELECT *
      FROM cases
      ${where}
      ORDER BY revision ASC, id ASC
      LIMIT $${values.length}
    `, values);
    return result.rows.map(caseFromRow);
  }

  async listChanges(afterRevision: number, limit: number, createdBy?: string): Promise<CaseRecord[]> {
    return this.list({ afterRevision, limit, createdBy });
  }

  async currentRevision(): Promise<number> {
    const result = await this.database.query('SELECT COALESCE(MAX(revision), 0) AS revision FROM cases');
    return Number(result.rows[0]?.revision ?? 0);
  }

  async create(input: CaseWriteInput): Promise<CaseRecord> {
    const result = await this.database.query(`
      INSERT INTO cases (
        id, client_uid, platform_account_id, created_by, kind, plaintiff, defendant, status,
        filed_time, case_number, reject_time, reject_reason, query_time,
        needs_human, error_code, source_event_id, source_updated_at, revision
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
        nextval('cases_revision_seq')
      )
      RETURNING *
    `, writeValues(input));
    return caseFromRow(result.rows[0]);
  }

  async update(id: string, input: CaseWriteInput, createdBy?: string): Promise<CaseRecord | null> {
    const values = [
      id,
      input.clientUid,
      input.platformAccountId,
      input.kind,
      input.plaintiff,
      input.defendant,
      input.status,
      input.filedTime,
      input.caseNumber,
      input.rejectTime,
      input.rejectReason,
      dateTimeInput(input.queryTime),
      input.needsHuman,
      input.errorCode,
      input.sourceEventId,
      dateTimeInput(input.sourceUpdatedAt),
    ];
    const ownerClause = createdBy === undefined ? '' : ' AND created_by = $17';
    if (createdBy !== undefined) values.push(createdBy);
    const result = await this.database.query(`
      UPDATE cases
      SET client_uid = $2,
          platform_account_id = $3,
          kind = $4,
          plaintiff = $5,
          defendant = $6,
          status = $7,
          filed_time = $8,
          case_number = $9,
          reject_time = $10,
          reject_reason = $11,
          query_time = $12,
          needs_human = $13,
          error_code = $14,
          source_event_id = $15,
          source_updated_at = $16,
          revision = nextval('cases_revision_seq'),
          updated_at = NOW()
      WHERE id = $1${ownerClause}
      RETURNING *
    `, values);
    return result.rows[0] ? caseFromRow(result.rows[0]) : null;
  }

  async listExpired(before: Date): Promise<CaseRecord[]> {
    const result = await this.database.query(
      'SELECT * FROM cases WHERE query_time < $1 ORDER BY query_time ASC, id ASC',
      [before],
    );
    return result.rows.map(caseFromRow);
  }

  async delete(id: string): Promise<void> {
    await this.database.query('DELETE FROM cases WHERE id = $1', [id]);
  }
}
