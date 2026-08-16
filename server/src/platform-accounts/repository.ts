import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type {
  NewPlatformAccount,
  PlatformAccountListOptions,
  PlatformAccountPatch,
  PlatformAccountRecord,
  PlatformAccountRepository,
} from './types.ts';

type Queryable = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

function dateValue(value: unknown): Date {
  return value instanceof Date ? new Date(value) : new Date(String(value));
}

function bufferValue(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value));
}

function accountFromRow(row: Record<string, unknown>): PlatformAccountRecord {
  return {
    id: String(row.id),
    label: String(row.label),
    secretCiphertext: bufferValue(row.secret_ciphertext),
    secretIv: bufferValue(row.secret_iv),
    secretTag: bufferValue(row.secret_tag),
    secretVersion: Number(row.secret_version),
    enabled: Boolean(row.enabled),
    deletedAt: row.deleted_at ? dateValue(row.deleted_at) : null,
    createdBy: String(row.created_by),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
    salespersonWecomUserId: row.salesperson_wecom_userid ? String(row.salesperson_wecom_userid) : null,
    assistantWecomUserId: row.assistant_wecom_userid ? String(row.assistant_wecom_userid) : null,
  };
}

export class PgPlatformAccountRepository implements PlatformAccountRepository {
  private readonly database: Queryable;

  constructor(database: Pick<Pool, 'query'>) {
    this.database = database as unknown as Queryable;
  }

  async findById(id: string): Promise<PlatformAccountRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM platform_accounts WHERE id = $1 LIMIT 1',
      [id],
    );
    return result.rows[0] ? accountFromRow(result.rows[0]) : null;
  }

  async list(options: PlatformAccountListOptions = {}): Promise<PlatformAccountRecord[]> {
    const conditions: string[] = [];
    if (options.includeDeleted !== true) conditions.push('deleted_at IS NULL');
    if (options.enabledOnly === true) conditions.push('enabled = TRUE');
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.database.query(`
      SELECT *
      FROM platform_accounts
      ${where}
      ORDER BY label ASC
    `);
    return result.rows.map(accountFromRow);
  }

  async create(input: NewPlatformAccount): Promise<PlatformAccountRecord> {
    const result = await this.database.query(`
      INSERT INTO platform_accounts
        (id, label, secret_ciphertext, secret_iv, secret_tag, secret_version, enabled, created_by, salesperson_wecom_userid, assistant_wecom_userid)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [
      input.id ?? randomUUID(),
      input.label,
      input.secretCiphertext,
      input.secretIv,
      input.secretTag,
      input.secretVersion,
      input.enabled ?? true,
      input.createdBy,
      input.salespersonWecomUserId ?? null,
      input.assistantWecomUserId ?? null,
    ]);
    return accountFromRow(result.rows[0]);
  }

  async update(id: string, patch: PlatformAccountPatch): Promise<PlatformAccountRecord | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const add = (field: string, value: unknown) => {
      values.push(value);
      fields.push(`${field} = $${values.length}`);
    };
    if (patch.label !== undefined) add('label', patch.label);
    if (patch.enabled !== undefined) add('enabled', patch.enabled);
    if (patch.salespersonWecomUserId !== undefined) add('salesperson_wecom_userid', patch.salespersonWecomUserId);
    if (patch.assistantWecomUserId !== undefined) add('assistant_wecom_userid', patch.assistantWecomUserId);
    if (patch.secretCiphertext !== undefined) add('secret_ciphertext', patch.secretCiphertext);
    if (patch.secretIv !== undefined) add('secret_iv', patch.secretIv);
    if (patch.secretTag !== undefined) add('secret_tag', patch.secretTag);
    if (patch.secretVersion !== undefined) add('secret_version', patch.secretVersion);
    if (fields.length === 0) return this.findById(id);
    values.push(id);
    const result = await this.database.query(`
      UPDATE platform_accounts
      SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING *
    `, values);
    return result.rows[0] ? accountFromRow(result.rows[0]) : null;
  }

  async softDelete(id: string): Promise<PlatformAccountRecord | null> {
    const result = await this.database.query(`
      UPDATE platform_accounts
      SET enabled = FALSE, deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id]);
    return result.rows[0] ? accountFromRow(result.rows[0]) : null;
  }
}
