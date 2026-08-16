import type { Pool } from 'pg';

import type { EncryptedUserWecomWebhook, UserWecomWebhookRepository } from './types.ts';

type Database = Pick<Pool, 'query'>;

export class PgUserWecomWebhookRepository implements UserWecomWebhookRepository {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  async findByUserId(userId: string): Promise<EncryptedUserWecomWebhook | null> {
    const result = await this.database.query(`
      SELECT wecom_webhook_ciphertext, wecom_webhook_iv, wecom_webhook_tag, wecom_webhook_version
      FROM users WHERE id = $1
    `, [userId]);
    const row = result.rows[0];
    if (!row || row.wecom_webhook_ciphertext === null) return null;
    return {
      ciphertext: Buffer.from(row.wecom_webhook_ciphertext),
      iv: Buffer.from(row.wecom_webhook_iv),
      tag: Buffer.from(row.wecom_webhook_tag),
      version: Number(row.wecom_webhook_version) as 1,
    };
  }

  async save(userId: string, value: EncryptedUserWecomWebhook): Promise<boolean> {
    const result = await this.database.query(`
      UPDATE users SET
        wecom_webhook_ciphertext = $2,
        wecom_webhook_iv = $3,
        wecom_webhook_tag = $4,
        wecom_webhook_version = $5,
        updated_at = NOW()
      WHERE id = $1 RETURNING id
    `, [userId, value.ciphertext, value.iv, value.tag, value.version]);
    return result.rows.length === 1;
  }

  async clear(userId: string): Promise<boolean> {
    const result = await this.database.query(`
      UPDATE users SET
        wecom_webhook_ciphertext = NULL,
        wecom_webhook_iv = NULL,
        wecom_webhook_tag = NULL,
        wecom_webhook_version = NULL,
        updated_at = NOW()
      WHERE id = $1 RETURNING id
    `, [userId]);
    return result.rows.length === 1;
  }

  async configuredUserIds(userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const result = await this.database.query(`
      SELECT id FROM users
      WHERE id IN (${userIds.map((_, index) => `$${index + 1}`).join(', ')})
        AND wecom_webhook_ciphertext IS NOT NULL
    `, userIds);
    return new Set(result.rows.map((row) => String(row.id)));
  }
}
