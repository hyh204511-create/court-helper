import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { WecomNotificationRecord, WecomNotificationRepository, WecomTerminalStatus } from './types.ts';

type Queryable = { query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>; };
function date(value: unknown): Date { return value instanceof Date ? new Date(value) : new Date(String(value)); }
function notificationId(caseId: string, resultStatus: string, triggerId: string): string {
  const bytes = createHash('sha256').update(`${caseId}:${resultStatus}:${triggerId}`, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function fromRow(row: Record<string, unknown>): WecomNotificationRecord { return { id: String(row.id), caseId: String(row.case_id), platformAccountId: String(row.platform_account_id), resultStatus: row.result_status as WecomTerminalStatus, screenshotId: String(row.screenshot_id), triggerId: String(row.trigger_id), status: row.status as WecomNotificationRecord['status'], errorCode: row.error_code ? String(row.error_code) : null, attemptCount: Number(row.attempt_count), createdAt: date(row.created_at), updatedAt: date(row.updated_at), sentAt: row.sent_at ? date(row.sent_at) : null }; }
export class PgWecomNotificationRepository implements WecomNotificationRepository {
  private readonly database: Queryable;
  constructor(database: Pick<Pool, 'query'>) { this.database = database as unknown as Queryable; }
  async createPending(input: Omit<WecomNotificationRecord, 'id' | 'status' | 'errorCode' | 'attemptCount' | 'createdAt' | 'updatedAt' | 'sentAt'>) { const existing = await this.database.query('SELECT * FROM wecom_notifications WHERE case_id = $1 AND result_status = $2 AND trigger_id = $3', [input.caseId, input.resultStatus, input.triggerId]); if (existing.rows[0]) return { record: fromRow(existing.rows[0]), created: false }; const id = notificationId(input.caseId, input.resultStatus, input.triggerId); const result = await this.database.query(`INSERT INTO wecom_notifications (id, case_id, platform_account_id, result_status, screenshot_id, trigger_id, status) VALUES ($1,$2,$3,$4,$5,$6,'pending') ON CONFLICT (id) DO NOTHING RETURNING *`, [id, input.caseId, input.platformAccountId, input.resultStatus, input.screenshotId, input.triggerId]); if (result.rows[0]) return { record: fromRow(result.rows[0]), created: true }; const raced = await this.database.query('SELECT * FROM wecom_notifications WHERE id = $1', [id]); return { record: fromRow(raced.rows[0]), created: false }; }
  async markSending(id: string) { const result = await this.database.query(`UPDATE wecom_notifications SET status='sending', attempt_count=attempt_count+1, updated_at=NOW() WHERE id=$1 AND status IN ('pending','failed') AND attempt_count < 2 RETURNING *`, [id]); return result.rows[0] ? fromRow(result.rows[0]) : null; }
  async markSent(id: string) { const result = await this.database.query(`UPDATE wecom_notifications SET status='sent', error_code=NULL, sent_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`, [id]); return result.rows[0] ? fromRow(result.rows[0]) : null; }
  async markFailed(id: string, errorCode: string) { const result = await this.database.query(`UPDATE wecom_notifications SET status='failed', error_code=$2, updated_at=NOW() WHERE id=$1 RETURNING *`, [id, errorCode]); return result.rows[0] ? fromRow(result.rows[0]) : null; }
  async findById(id: string) { const result = await this.database.query('SELECT * FROM wecom_notifications WHERE id=$1', [id]); return result.rows[0] ? fromRow(result.rows[0]) : null; }
  async listByCaseId(caseId: string) { const result = await this.database.query('SELECT * FROM wecom_notifications WHERE case_id=$1 ORDER BY created_at', [caseId]); return result.rows.map(fromRow); }
}
