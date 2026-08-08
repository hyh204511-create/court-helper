import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type {
  BrowserCommandJsonObject,
  BrowserCommandListOptions,
  BrowserCommandPage,
  BrowserCommandProgress,
  BrowserCommandRecord,
  BrowserCommandRepository,
  BrowserCommandResultInput,
  NewBrowserCommand,
} from './types.ts';

type Queryable = {
  query(sql: string, values?: unknown[]): Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount?: number | null;
  }>;
};

function dateValue(value: unknown): Date {
  return value instanceof Date ? new Date(value) : new Date(String(value));
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function jsonObject(value: unknown): BrowserCommandJsonObject {
  if (typeof value === 'string') return JSON.parse(value) as BrowserCommandJsonObject;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return JSON.parse(JSON.stringify(value)) as BrowserCommandJsonObject;
  }
  return {};
}

function progressValue(value: unknown): BrowserCommandProgress {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return JSON.parse(value) as BrowserCommandProgress;
  return JSON.parse(JSON.stringify(value)) as BrowserCommandProgress;
}

function commandFromRow(row: Record<string, unknown>): BrowserCommandRecord {
  return {
    id: String(row.id),
    type: row.type as BrowserCommandRecord['type'],
    status: row.status as BrowserCommandRecord['status'],
    platformAccountId: nullableString(row.platform_account_id),
    clientBatchId: nullableString(row.client_batch_id),
    requestedBy: String(row.requested_by),
    claimedBy: nullableString(row.claimed_by),
    claimTokenHash: nullableString(row.claim_token_hash),
    payload: jsonObject(row.payload),
    resultCode: nullableString(row.result_code),
    resultSummary: nullableString(row.result_summary),
    progress: progressValue(row.progress),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
    expiresAt: dateValue(row.expires_at),
  };
}

export class PgBrowserCommandRepository implements BrowserCommandRepository {
  private readonly database: Queryable;

  constructor(database: Pick<Pool, 'query'>) {
    this.database = database as unknown as Queryable;
  }

  async create(input: NewBrowserCommand): Promise<BrowserCommandRecord> {
    const result = await this.database.query(`
      INSERT INTO browser_commands (
        id, type, platform_account_id, client_batch_id, requested_by, payload, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      input.id ?? randomUUID(),
      input.type,
      input.platformAccountId,
      input.clientBatchId,
      input.requestedBy,
      JSON.stringify(input.payload),
      input.expiresAt,
    ]);
    return commandFromRow(result.rows[0]);
  }

  async get(id: string): Promise<BrowserCommandRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM browser_commands WHERE id = $1 LIMIT 1',
      [id],
    );
    return result.rows[0] ? commandFromRow(result.rows[0]) : null;
  }

  async list(options: BrowserCommandListOptions): Promise<BrowserCommandPage> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (options.requestedBy !== undefined) {
      values.push(options.requestedBy);
      conditions.push(`requested_by = $${values.length}`);
    }
    if (options.status !== undefined) {
      values.push(options.status);
      conditions.push(`status = $${values.length}`);
    }
    if (options.type !== undefined) {
      values.push(options.type);
      conditions.push(`type = $${values.length}`);
    }
    if (options.cursor !== undefined) {
      values.push(options.cursor.createdAt, options.cursor.id);
      const createdAtIndex = values.length - 1;
      const idIndex = values.length;
      conditions.push(`(created_at < $${createdAtIndex} OR (created_at = $${createdAtIndex} AND id < $${idIndex}))`);
    }
    values.push(options.limit + 1);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.database.query(`
      SELECT *
      FROM browser_commands
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}
    `, values);
    const rows = result.rows.map(commandFromRow);
    const items = rows.slice(0, options.limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > options.limit && last
        ? { createdAt: new Date(last.createdAt), id: last.id }
        : null,
    };
  }

  async findActiveForAccount(platformAccountId: string, now: Date): Promise<BrowserCommandRecord | null> {
    const result = await this.database.query(`
      SELECT *
      FROM browser_commands
      WHERE platform_account_id = $1
        AND status IN ('pending', 'executing')
        AND expires_at > $2
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `, [platformAccountId, now]);
    return result.rows[0] ? commandFromRow(result.rows[0]) : null;
  }

  async claim(
    id: string,
    claimedBy: string,
    claimTokenHash: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<BrowserCommandRecord | null> {
    const result = await this.database.query(`
      UPDATE browser_commands
      SET status = 'executing',
          claimed_by = $2,
          claim_token_hash = $3,
          updated_at = $4,
          expires_at = $5
      WHERE id = $1
        AND status = 'pending'
        AND expires_at > $4
      RETURNING *
    `, [id, claimedBy, claimTokenHash, now, leaseExpiresAt]);
    return result.rows[0] ? commandFromRow(result.rows[0]) : null;
  }

  async writeResult(
    id: string,
    claimedBy: string,
    claimTokenHash: string,
    resultInput: BrowserCommandResultInput,
    now: Date,
  ): Promise<BrowserCommandRecord | null> {
    const result = await this.database.query(`
      UPDATE browser_commands
      SET status = $4,
          result_code = $5,
          result_summary = $6,
          progress = $7,
          updated_at = $8
      WHERE id = $1
        AND claimed_by = $2
        AND claim_token_hash = $3
        AND status = 'executing'
      RETURNING *
    `, [
      id,
      claimedBy,
      claimTokenHash,
      resultInput.status,
      resultInput.resultCode,
      resultInput.resultSummary,
      resultInput.progress === null ? null : JSON.stringify(resultInput.progress),
      now,
    ]);
    return result.rows[0] ? commandFromRow(result.rows[0]) : null;
  }

  async cancel(id: string, requestedBy: string, now: Date): Promise<BrowserCommandRecord | null> {
    const result = await this.database.query(`
      UPDATE browser_commands
      SET status = 'cancelled', updated_at = $3
      WHERE id = $1
        AND requested_by = $2
        AND status IN ('pending', 'executing')
      RETURNING *
    `, [id, requestedBy, now]);
    if (result.rows[0]) return commandFromRow(result.rows[0]);

    // Cancellation is idempotent for an owner, including already terminal commands.
    // Keep the repository contract aligned with the in-memory implementation and
    // avoid turning a harmless repeated click into a false NOT_FOUND.
    const existing = await this.database.query(
      'SELECT * FROM browser_commands WHERE id = $1 AND requested_by = $2 LIMIT 1',
      [id, requestedBy],
    );
    return existing.rows[0] ? commandFromRow(existing.rows[0]) : null;
  }

  async deleteTerminal(requestedBy?: string): Promise<number> {
    const ownerCondition = requestedBy === undefined ? '' : 'AND requested_by = $1';
    const result = await this.database.query(`
      DELETE FROM browser_commands
      WHERE status IN ('succeeded', 'failed', 'expired', 'manual_required', 'cancelled')
      ${ownerCondition}
    `, requestedBy === undefined ? [] : [requestedBy]);
    return Number(result.rowCount ?? 0);
  }

  async expireStale(now: Date): Promise<number> {
    const result = await this.database.query(`
      UPDATE browser_commands
      SET status = 'expired', updated_at = $1
      WHERE status IN ('pending', 'executing')
        AND expires_at <= $1
    `, [now]);
    return Number(result.rowCount ?? 0);
  }
}
