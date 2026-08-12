import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { WecomNotificationRecord, WecomNotificationRepository, WecomTerminalStatus } from './types.ts';

type Queryable = { query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>; };
function date(value: unknown): Date { return value instanceof Date ? new Date(value) : new Date(String(value)); }
function fromRow(row: Record<string, unknown>): WecomNotificationRecord { return { id: String(row.id), caseId: String(row.case_id), platformAccountId: String(row.platform_account_id), resultStatus: row.result_status as WecomTerminalStatus, screenshotId: String(row.screenshot_id), status: row.status as WecomNotificationRecord['status'], errorCode: row.error_code ? String(row.error_code) : null, attemptCount: Number(row.attempt_count), createdAt: date(row.created_at), updatedAt: date(row.updated_at), sentAt: row.sent_at ? date(row.sent_at) : null }; }
export class PgWecomNotificationRepository implements WecomNotificationRepository {
  private readonly database: Queryable;
  constructor(database: Pick<Pool, 'query'>) { this.database = database as unknown as Queryable; }
  async createPending(input: Omit<WecomNotificationRecord, 'id' | 'status' | 'errorCode' | 'attemptCount' | 'createdAt' | 'updatedAt' | 'sentAt'>) { const result = await this.database.query(`INSERT INTO wecom_notifications (id, case_id, platform_account_id, result_status, screenshot_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (case_id,result_status) DO NOTHING RETURNING *`, [randomUUID(), input.caseId, input.platformAccountId, input.resultStatus, input.screenshotId]); if (result.rows[0]) return { record: fromRow(result.rows[0]), created: true }; const existing = await this.database.query('SELECT * FROM wecom_notifications WHERE case_id = $1 AND result_status = $2', [input.caseId, input.resultStatus]); return { record: fromRow(existing.rows[0]), created: false }; }
  async markSending(id: string) { const result = await this.database.query(`UPDATE wecom_notifications SET status='sending', attempt_count=attempt_count+1, updated_at=NOW() WHERE id=$1 AND status IN ('pending','failed') AND attempt_count < 2 RETURNING *`, [id]); return result.rows[0] ? fromRow(result.rows[0]) : null; }
  async markSent(id: string) { const result = await this.database.query(`UPDATE wecom_notifications SET status='sent', error_code=NULL, sent_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`, [id]); return result.rows[0] ? fromRow(result.rows[0]) : null; }
  async markFailed(id: string, errorCode: string) { const result = await this.database.query(`UPDATE wecom_notifications SET status='failed', error_code=$2, updated_at=NOW() WHERE id=$1 RETURNING *`, [id, errorCode]); return result.rows[0] ? fromRow(result.rows[0]) : null; }
  async findById(id: string) { const result = await this.database.query('SELECT * FROM wecom_notifications WHERE id=$1', [id]); return result.rows[0] ? fromRow(result.rows[0]) : null; }
  async listByCaseId(caseId: string) { const result = await this.database.query('SELECT * FROM wecom_notifications WHERE case_id=$1 ORDER BY created_at', [caseId]); return result.rows.map(fromRow); }
}
