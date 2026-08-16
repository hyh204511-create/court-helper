import { randomUUID } from 'node:crypto';
import type { WecomNotificationRecord, WecomNotificationRepository } from './types.ts';

function copy(value: WecomNotificationRecord): WecomNotificationRecord {
  return { ...value, createdAt: new Date(value.createdAt), updatedAt: new Date(value.updatedAt), sentAt: value.sentAt ? new Date(value.sentAt) : null };
}

export class MemoryWecomNotificationRepository implements WecomNotificationRepository {
  private readonly values = new Map<string, WecomNotificationRecord>();
  async createPending(input: Omit<WecomNotificationRecord, 'id' | 'status' | 'errorCode' | 'attemptCount' | 'createdAt' | 'updatedAt' | 'sentAt'>) {
    const existing = [...this.values.values()].find((value) => value.caseId === input.caseId && value.resultStatus === input.resultStatus && value.triggerId === input.triggerId);
    if (existing) return { record: copy(existing), created: false };
    const now = new Date();
    const record: WecomNotificationRecord = { ...input, id: randomUUID(), status: 'pending', errorCode: null, attemptCount: 0, createdAt: now, updatedAt: now, sentAt: null };
    this.values.set(record.id, record);
    return { record: copy(record), created: true };
  }
  async markSending(id: string) { const value = this.values.get(id); if (!value || value.status === 'sent' || value.attemptCount >= 2) return null; value.status = 'sending'; value.attemptCount += 1; value.updatedAt = new Date(); return copy(value); }
  async markSent(id: string) { const value = this.values.get(id); if (!value) return null; value.status = 'sent'; value.errorCode = null; value.sentAt = new Date(); value.updatedAt = new Date(); return copy(value); }
  async markFailed(id: string, errorCode: string) { const value = this.values.get(id); if (!value) return null; value.status = 'failed'; value.errorCode = errorCode; value.updatedAt = new Date(); return copy(value); }
  async findById(id: string) { const value = this.values.get(id); return value ? copy(value) : null; }
  async listByCaseId(caseId: string) { return [...this.values.values()].filter((value) => value.caseId === caseId).map(copy); }
}
