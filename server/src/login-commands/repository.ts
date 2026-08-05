import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type {
  LoginCommandCompletion,
  LoginCommandListItem,
  LoginCommandRecord,
  LoginCommandRepository,
  NewLoginCommand,
} from './types.ts';

type Queryable = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
};

function dateValue(value: unknown): Date {
  return value instanceof Date ? new Date(value) : new Date(String(value));
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function commandFromRow(row: Record<string, unknown>): LoginCommandRecord {
  return {
    id: String(row.id),
    platformAccountId: String(row.platform_account_id),
    status: row.status as LoginCommandRecord['status'],
    resultCode: nullableString(row.result_code),
    resultMessage: nullableString(row.result_message),
    claimedBy: nullableString(row.claimed_by),
    createdBy: String(row.created_by),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
    expiresAt: dateValue(row.expires_at),
  };
}

function listItemFromRow(row: Record<string, unknown>): LoginCommandListItem {
  return {
    id: String(row.id),
    platformAccountId: String(row.platform_account_id),
    accountLabel: String(row.account_label),
    status: row.status as LoginCommandListItem['status'],
    resultCode: nullableString(row.result_code),
    resultMessage: nullableString(row.result_message),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

export class PgLoginCommandRepository implements LoginCommandRepository {
  private readonly database: Queryable;

  constructor(database: Pick<Pool, 'query'>) {
    this.database = database as unknown as Queryable;
  }

  async create(input: NewLoginCommand): Promise<LoginCommandRecord> {
    const result = await this.database.query(`
      INSERT INTO login_commands (id, platform_account_id, status, created_by, expires_at)
      VALUES ($1, $2, 'pending', $3, $4)
      RETURNING *
    `, [input.id ?? randomUUID(), input.platformAccountId, input.createdBy, input.expiresAt]);
    return commandFromRow(result.rows[0]);
  }

  async get(id: string): Promise<LoginCommandRecord | null> {
    const result = await this.database.query('SELECT * FROM login_commands WHERE id = $1 LIMIT 1', [id]);
    return result.rows[0] ? commandFromRow(result.rows[0]) : null;
  }

  async listPending(now: Date): Promise<LoginCommandRecord[]> {
    const result = await this.database.query(`
      SELECT *
      FROM login_commands
      WHERE status = 'pending' AND expires_at > $1
      ORDER BY created_at ASC, id ASC
    `, [now]);
    return result.rows.map(commandFromRow);
  }

  async findActiveForAccount(platformAccountId: string, now: Date): Promise<LoginCommandRecord | null> {
    const result = await this.database.query(`
      SELECT *
      FROM login_commands
      WHERE platform_account_id = $1
        AND status IN ('pending', 'executing')
        AND expires_at > $2
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `, [platformAccountId, now]);
    return result.rows[0] ? commandFromRow(result.rows[0]) : null;
  }

  async claimNext(claimedBy: string, now: Date, leaseExpiresAt: Date): Promise<LoginCommandRecord | null> {
    const result = await this.database.query(`
      UPDATE login_commands
      SET status = 'executing',
          claimed_by = $2,
          updated_at = $1,
          expires_at = $3
      WHERE id = (
        SELECT id
        FROM login_commands
        WHERE status = 'pending' AND expires_at > $1
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      )
        AND status = 'pending'
        AND expires_at > $1
      RETURNING *
    `, [now, claimedBy, leaseExpiresAt]);
    return result.rows[0] ? commandFromRow(result.rows[0]) : null;
  }

  async complete(
    id: string,
    claimedBy: string,
    completion: Required<LoginCommandCompletion>,
  ): Promise<LoginCommandRecord | null> {
    const status = completion.ok ? 'success' : 'failed';
    const result = await this.database.query(`
      UPDATE login_commands
      SET status = $3,
          result_code = $4,
          result_message = $5,
          updated_at = NOW()
      WHERE id = $1
        AND status = 'executing'
        AND claimed_by = $2
      RETURNING *
    `, [
      id,
      claimedBy,
      status,
      completion.ok ? null : completion.code,
      completion.ok ? null : completion.message,
    ]);
    return result.rows[0] ? commandFromRow(result.rows[0]) : null;
  }

  async expireStale(now: Date): Promise<number> {
    const result = await this.database.query(`
      UPDATE login_commands
      SET status = 'expired',
          updated_at = $1
      WHERE status = 'pending'
        AND expires_at < $1
    `, [now]);
    return Number(result.rowCount ?? 0);
  }

  async rollbackExpiredLeases(before: Date, pendingExpiresAt: Date): Promise<number> {
    const updatedAt = new Date(pendingExpiresAt.getTime() - 5 * 60 * 1000);
    const result = await this.database.query(`
      UPDATE login_commands
      SET status = 'pending',
          claimed_by = NULL,
          updated_at = $3,
          expires_at = $2
      WHERE status = 'executing'
        AND updated_at < $1
    `, [before, pendingExpiresAt, updatedAt]);
    return Number(result.rowCount ?? 0);
  }

  async listAdmin(limit: number): Promise<LoginCommandListItem[]> {
    const result = await this.database.query(`
      SELECT lc.id,
             lc.platform_account_id,
             pa.label AS account_label,
             lc.status,
             lc.result_code,
             lc.result_message,
             lc.created_at,
             lc.updated_at
      FROM login_commands lc
      JOIN platform_accounts pa ON pa.id = lc.platform_account_id
      ORDER BY lc.created_at DESC, lc.id DESC
      LIMIT $1
    `, [limit]);
    return result.rows.map(listItemFromRow);
  }
}
