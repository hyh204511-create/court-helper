export const WECOM_NOTIFICATION_STATUSES = ['pending', 'sending', 'sent', 'failed'] as const;
export type WecomNotificationStatus = (typeof WECOM_NOTIFICATION_STATUSES)[number];
export type WecomTerminalStatus = '立案成功' | '强执成功' | '已驳回';

export interface WecomNotificationRecord {
  id: string;
  caseId: string;
  platformAccountId: string;
  resultStatus: WecomTerminalStatus;
  screenshotId: string;
  status: WecomNotificationStatus;
  errorCode: string | null;
  attemptCount: number;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
}

export interface WecomNotificationRepository {
  createPending(input: Omit<WecomNotificationRecord, 'id' | 'status' | 'errorCode' | 'attemptCount' | 'createdAt' | 'updatedAt' | 'sentAt'>): Promise<{ record: WecomNotificationRecord; created: boolean }>;
  markSending(id: string): Promise<WecomNotificationRecord | null>;
  markSent(id: string): Promise<WecomNotificationRecord | null>;
  markFailed(id: string, errorCode: string): Promise<WecomNotificationRecord | null>;
  findById(id: string): Promise<WecomNotificationRecord | null>;
  listByCaseId(caseId: string): Promise<WecomNotificationRecord[]>;
}
