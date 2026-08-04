import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type {
  AuthRepository,
  NewSession,
  NewUser,
  SessionRecord,
  UserPatch,
  UserRecord,
} from './types.ts';

type Queryable = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

function dateValue(value: unknown): Date {
  return value instanceof Date ? new Date(value) : new Date(String(value));
}

function userFromRow(row: Record<string, unknown>): UserRecord {
  return {
    id: String(row.id),
    username: String(row.username),
    passwordHash: String(row.password_hash),
    role: row.role as UserRecord['role'],
    enabled: Boolean(row.enabled),
    deletedAt: row.deleted_at ? dateValue(row.deleted_at) : null,
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function sessionFromRow(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tokenHash: String(row.token_hash),
    clientType: row.client_type as SessionRecord['clientType'],
    expiresAt: dateValue(row.expires_at),
    revokedAt: row.revoked_at ? dateValue(row.revoked_at) : null,
    createdAt: dateValue(row.created_at),
  };
}

export class PgAuthRepository implements AuthRepository {
  private readonly database: Queryable;

  constructor(database: Pick<Pool, 'query'>) {
    this.database = database as unknown as Queryable;
  }

  async findUserByUsername(username: string): Promise<UserRecord | null> {
    const result = await this.database.query('SELECT * FROM users WHERE username = $1 LIMIT 1', [username]);
    return result.rows[0] ? userFromRow(result.rows[0]) : null;
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const result = await this.database.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
    return result.rows[0] ? userFromRow(result.rows[0]) : null;
  }

  async listUsers(): Promise<UserRecord[]> {
    const result = await this.database.query('SELECT * FROM users ORDER BY username ASC');
    return result.rows.map(userFromRow);
  }

  async createUser(input: NewUser): Promise<UserRecord> {
    const result = await this.database.query(`
      INSERT INTO users (id, username, password_hash, role, enabled)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [input.id ?? randomUUID(), input.username, input.passwordHash, input.role, input.enabled ?? true]);
    return userFromRow(result.rows[0]);
  }

  async updateUser(id: string, patch: UserPatch): Promise<UserRecord | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (patch.username !== undefined) {
      values.push(patch.username);
      fields.push(`username = $${values.length}`);
    }
    if (patch.role !== undefined) {
      values.push(patch.role);
      fields.push(`role = $${values.length}`);
    }
    if (patch.enabled !== undefined) {
      values.push(patch.enabled);
      fields.push(`enabled = $${values.length}`);
    }
    if (fields.length === 0) return this.findUserById(id);
    values.push(id);
    const result = await this.database.query(`
      UPDATE users
      SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING *
    `, values);
    return result.rows[0] ? userFromRow(result.rows[0]) : null;
  }

  async softDeleteUser(id: string): Promise<UserRecord | null> {
    const result = await this.database.query(`
      UPDATE users
      SET enabled = FALSE, deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id]);
    return result.rows[0] ? userFromRow(result.rows[0]) : null;
  }

  async updatePassword(id: string, passwordHash: string): Promise<UserRecord | null> {
    const result = await this.database.query(`
      UPDATE users
      SET password_hash = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [passwordHash, id]);
    return result.rows[0] ? userFromRow(result.rows[0]) : null;
  }

  async countEnabledAdmins(): Promise<number> {
    const result = await this.database.query(`
      SELECT COUNT(*) AS count
      FROM users
      WHERE role = 'admin' AND enabled = TRUE AND deleted_at IS NULL
    `);
    return Number(result.rows[0]?.count ?? 0);
  }

  async createSession(input: NewSession): Promise<SessionRecord> {
    const result = await this.database.query(`
      INSERT INTO sessions (id, user_id, token_hash, client_type, expires_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [input.id, input.userId, input.tokenHash, input.clientType, input.expiresAt]);
    return sessionFromRow(result.rows[0]);
  }

  async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const result = await this.database.query('SELECT * FROM sessions WHERE token_hash = $1 LIMIT 1', [tokenHash]);
    return result.rows[0] ? sessionFromRow(result.rows[0]) : null;
  }

  async revokeSession(id: string): Promise<void> {
    await this.database.query('UPDATE sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1', [id]);
  }

  async revokeUserSessions(userId: string): Promise<void> {
    await this.database.query('UPDATE sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE user_id = $1', [userId]);
  }

  async deleteExpiredOrRevokedSessions(now: Date): Promise<number> {
    const result = await this.database.query(
      'DELETE FROM sessions WHERE expires_at <= $1 OR revoked_at IS NOT NULL RETURNING id',
      [now],
    );
    return result.rows.length;
  }
}
