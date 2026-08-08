import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type {
  AuthRepository,
  ExtensionDeviceRecord,
  ExtensionPairingRecord,
  ExtensionPairingStatus,
  NewExtensionDevice,
  ExtensionPairingExchangeInput,
  ExtensionPairingExchangeResult,
  NewExtensionPairing,
  NewSession,
  NewUser,
  SessionRecord,
  UserPatch,
  UserRecord,
} from './types.ts';

type Queryable = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

const PAIRING_CREATE_MAX_ATTEMPTS = 5;

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}

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
    extensionDeviceId: row.extension_device_id ? String(row.extension_device_id) : null,
    expiresAt: dateValue(row.expires_at),
    revokedAt: row.revoked_at ? dateValue(row.revoked_at) : null,
    createdAt: dateValue(row.created_at),
  };
}

function extensionDeviceFromRow(row: Record<string, unknown>): ExtensionDeviceRecord {
  return {
    id: String(row.id),
    deviceId: String(row.device_id),
    label: row.label ? String(row.label) : null,
    pairedBy: String(row.paired_by),
    enabled: Boolean(row.enabled),
    revokedAt: row.revoked_at ? dateValue(row.revoked_at) : null,
    lastSeenAt: row.last_seen_at ? dateValue(row.last_seen_at) : null,
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

function extensionPairingFromRow(row: Record<string, unknown>): ExtensionPairingRecord {
  return {
    id: String(row.id),
    deviceId: String(row.device_id),
    label: row.label ? String(row.label) : null,
    exchangeSecretHash: String(row.exchange_secret_hash),
    verificationCodeHash: String(row.verification_code_hash),
    status: row.status as ExtensionPairingStatus,
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    approvedAt: row.approved_at ? dateValue(row.approved_at) : null,
    consumedAt: row.consumed_at ? dateValue(row.consumed_at) : null,
    expiresAt: dateValue(row.expires_at),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
  };
}

export class PgAuthRepository implements AuthRepository {
  private readonly database: Queryable;
  private readonly connectionPool: Pick<Pool, 'connect'>;

  constructor(database: Pick<Pool, 'query' | 'connect'>) {
    this.database = database as unknown as Queryable;
    this.connectionPool = database;
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
      INSERT INTO sessions (id, user_id, token_hash, client_type, extension_device_id, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [input.id, input.userId, input.tokenHash, input.clientType, input.extensionDeviceId ?? null, input.expiresAt]);
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

  async createExtensionPairing(input: NewExtensionPairing): Promise<ExtensionPairingRecord> {
    let lastUniqueViolation: unknown = null;
    for (let attempt = 0; attempt < PAIRING_CREATE_MAX_ATTEMPTS; attempt += 1) {
      const client = await this.connectionPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`
          UPDATE extension_pairings
          SET status = 'cancelled', updated_at = NOW()
          WHERE device_id = $1 AND status IN ('pending', 'approved')
        `, [input.deviceId]);
        const result = await client.query(`
          INSERT INTO extension_pairings
            (id, device_id, label, exchange_secret_hash, verification_code_hash, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *
        `, [
          input.id,
          input.deviceId,
          input.label ?? null,
          input.exchangeSecretHash,
          input.verificationCodeHash,
          input.expiresAt,
        ]);
        await client.query('COMMIT');
        return extensionPairingFromRow(result.rows[0]);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (!isUniqueViolation(error)) throw error;
        lastUniqueViolation = error;
      } finally {
        client.release();
      }
    }
    throw lastUniqueViolation;
  }

  async getExtensionPairing(id: string): Promise<ExtensionPairingRecord | null> {
    const result = await this.database.query('SELECT * FROM extension_pairings WHERE id = $1 LIMIT 1', [id]);
    return result.rows[0] ? extensionPairingFromRow(result.rows[0]) : null;
  }

  async listExtensionPairings(status?: ExtensionPairingStatus): Promise<ExtensionPairingRecord[]> {
    const result = status
      ? await this.database.query('SELECT * FROM extension_pairings WHERE status = $1 ORDER BY created_at DESC, id DESC', [status])
      : await this.database.query('SELECT * FROM extension_pairings ORDER BY created_at DESC, id DESC');
    return result.rows.map(extensionPairingFromRow);
  }

  async approveExtensionPairing(
    id: string,
    verificationCodeHash: string,
    approvedBy: string,
    now: Date,
  ): Promise<ExtensionPairingRecord | null> {
    const result = await this.database.query(`
      UPDATE extension_pairings
      SET status = 'approved', approved_by = $3, approved_at = $4, updated_at = $4
      WHERE id = $1 AND status = 'pending' AND verification_code_hash = $2 AND expires_at > $4
      RETURNING *
    `, [id, verificationCodeHash, approvedBy, now]);
    return result.rows[0] ? extensionPairingFromRow(result.rows[0]) : null;
  }

  async consumeExtensionPairing(id: string, exchangeSecretHash: string, now: Date): Promise<ExtensionPairingRecord | null> {
    const result = await this.database.query(`
      UPDATE extension_pairings
      SET status = 'consumed', consumed_at = $3, updated_at = $3
      WHERE id = $1 AND status = 'approved' AND exchange_secret_hash = $2 AND expires_at > $3
      RETURNING *
    `, [id, exchangeSecretHash, now]);
    return result.rows[0] ? extensionPairingFromRow(result.rows[0]) : null;
  }

  async exchangeExtensionPairing(input: ExtensionPairingExchangeInput): Promise<ExtensionPairingExchangeResult | null> {
    const result = await this.database.query(`
      WITH consumed AS (
        UPDATE extension_pairings
        SET status = 'consumed', consumed_at = $3, updated_at = $3
        WHERE id = $1
          AND status = 'approved'
          AND exchange_secret_hash = $2
          AND expires_at > $3
          AND NOT EXISTS (
            SELECT 1
            FROM extension_devices existing_device
            WHERE existing_device.device_id = (
              SELECT candidate.device_id FROM extension_pairings candidate WHERE candidate.id = $1
            )
              AND (existing_device.enabled = FALSE OR existing_device.revoked_at IS NOT NULL)
          )
        RETURNING *
      ), device AS (
        INSERT INTO extension_devices (id, device_id, label, paired_by)
        SELECT $4, consumed.device_id, consumed.label, consumed.approved_by
        FROM consumed
        ON CONFLICT (device_id) DO UPDATE
        SET updated_at = $3
        WHERE extension_devices.enabled = TRUE AND extension_devices.revoked_at IS NULL
        RETURNING *
      ), created_session AS (
        INSERT INTO sessions (id, user_id, token_hash, client_type, extension_device_id, expires_at)
        SELECT $5, consumed.approved_by, $6, 'extension', device.id, $7::timestamptz
          FROM consumed, device
        RETURNING *
      )
      SELECT
        created_session.id AS session_id,
        created_session.user_id AS session_user_id,
        created_session.token_hash AS session_token_hash,
        created_session.client_type AS session_client_type,
        created_session.extension_device_id AS session_extension_device_id,
        created_session.expires_at AS session_expires_at,
        created_session.revoked_at AS session_revoked_at,
        created_session.created_at AS session_created_at,
        device.id AS device_id,
        device.device_id AS device_device_id,
        device.label AS device_label,
        device.paired_by AS device_paired_by,
        device.enabled AS device_enabled,
        device.revoked_at AS device_revoked_at,
        device.last_seen_at AS device_last_seen_at,
        device.created_at AS device_created_at,
        device.updated_at AS device_updated_at
      FROM created_session, device
    `, [
      input.pairingId,
      input.exchangeSecretHash,
      input.now,
      input.device.id,
      input.session.id,
      input.session.tokenHash,
      input.session.expiresAt,
    ]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      session: {
        id: String(row.session_id),
        userId: String(row.session_user_id),
        tokenHash: String(row.session_token_hash),
        clientType: row.session_client_type as SessionRecord['clientType'],
        extensionDeviceId: String(row.session_extension_device_id),
        expiresAt: dateValue(row.session_expires_at),
        revokedAt: row.session_revoked_at ? dateValue(row.session_revoked_at) : null,
        createdAt: dateValue(row.session_created_at),
      },
      device: {
        id: String(row.device_id),
        deviceId: String(row.device_device_id),
        label: row.device_label ? String(row.device_label) : null,
        pairedBy: String(row.device_paired_by),
        enabled: Boolean(row.device_enabled),
        revokedAt: row.device_revoked_at ? dateValue(row.device_revoked_at) : null,
        lastSeenAt: row.device_last_seen_at ? dateValue(row.device_last_seen_at) : null,
        createdAt: dateValue(row.device_created_at),
        updatedAt: dateValue(row.device_updated_at),
      },
    };
  }

  async getExtensionDevice(id: string): Promise<ExtensionDeviceRecord | null> {
    const result = await this.database.query('SELECT * FROM extension_devices WHERE id = $1 LIMIT 1', [id]);
    return result.rows[0] ? extensionDeviceFromRow(result.rows[0]) : null;
  }

  async getExtensionDeviceByDeviceId(deviceId: string): Promise<ExtensionDeviceRecord | null> {
    const result = await this.database.query('SELECT * FROM extension_devices WHERE device_id = $1 LIMIT 1', [deviceId]);
    return result.rows[0] ? extensionDeviceFromRow(result.rows[0]) : null;
  }

  async createExtensionDevice(input: NewExtensionDevice): Promise<ExtensionDeviceRecord> {
    const result = await this.database.query(`
      INSERT INTO extension_devices (id, device_id, label, paired_by)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [input.id, input.deviceId, input.label ?? null, input.pairedBy]);
    return extensionDeviceFromRow(result.rows[0]);
  }

  async listExtensionDevices(): Promise<ExtensionDeviceRecord[]> {
    const result = await this.database.query('SELECT * FROM extension_devices ORDER BY created_at DESC, id DESC');
    return result.rows.map(extensionDeviceFromRow);
  }

  async revokeExtensionDevice(id: string): Promise<ExtensionDeviceRecord | null> {
    const result = await this.database.query(`
      UPDATE extension_devices
      SET enabled = FALSE, revoked_at = COALESCE(revoked_at, NOW()), updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id]);
    if (!result.rows[0]) return null;
    await this.database.query('UPDATE sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE extension_device_id = $1', [id]);
    return extensionDeviceFromRow(result.rows[0]);
  }

  async deleteExtensionDevice(id: string): Promise<ExtensionDeviceRecord | null> {
    const client = await this.connectionPool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT * FROM extension_devices WHERE id = $1 FOR UPDATE', [id]);
      if (!existing.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const deviceId = String(existing.rows[0].device_id);
      await client.query('UPDATE sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE extension_device_id = $1', [id]);
      await client.query(`
        UPDATE extension_pairings
        SET status = 'cancelled', updated_at = NOW()
        WHERE device_id = $1 AND status IN ('pending', 'approved')
      `, [deviceId]);
      const result = await client.query('DELETE FROM extension_devices WHERE id = $1 RETURNING *', [id]);
      await client.query('COMMIT');
      return result.rows[0] ? extensionDeviceFromRow(result.rows[0]) : null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteExtensionDevices(): Promise<number> {
    const client = await this.connectionPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE extension_device_id IS NOT NULL');
      await client.query(`
        UPDATE extension_pairings
        SET status = 'cancelled', updated_at = NOW()
        WHERE status IN ('pending', 'approved')
      `);
      const result = await client.query('DELETE FROM extension_devices RETURNING id');
      await client.query('COMMIT');
      return result.rows.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async touchExtensionDevice(id: string, now: Date): Promise<void> {
    await this.database.query('UPDATE extension_devices SET last_seen_at = $2, updated_at = $2 WHERE id = $1', [id, now]);
  }
}
