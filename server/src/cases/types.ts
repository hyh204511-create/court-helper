export const CASE_KINDS = ['li', 'qz'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

export const CASE_STATUSES = ['立案成功', '强执成功', '已驳回', '审核中', 'UNKNOWN'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export type CaseDateTimeInput = Date | string | null;

export interface CaseAccess {
  userId: string;
  role: 'admin' | 'user';
}

export function ownerIdFor(access: CaseAccess): string | undefined {
  return access.role === 'admin' ? undefined : access.userId;
}

export interface CaseSyncItem {
  eventId: string;
  clientUid: string;
  platformAccountId: string;
  kind: CaseKind;
  plaintiff: string | null;
  defendant: string | null;
  status: CaseStatus;
  filedTime: string | null;
  caseNumber: string | null;
  rejectTime: string | null;
  rejectReason: string | null;
  queryTime: string | null;
  needsHuman: boolean;
  errorCode: string | null;
  sourceUpdatedAt: string;
}

export interface CaseWriteInput {
  id?: string;
  createdBy?: string | null;
  clientUid: string;
  platformAccountId: string;
  kind: CaseKind;
  plaintiff: string | null;
  defendant: string | null;
  status: CaseStatus;
  filedTime: string | null;
  caseNumber: string | null;
  rejectTime: string | null;
  rejectReason: string | null;
  queryTime: CaseDateTimeInput;
  needsHuman: boolean;
  errorCode: string | null;
  sourceEventId: string;
  sourceUpdatedAt: CaseDateTimeInput;
}

export interface CaseRecord {
  id: string;
  createdBy: string | null;
  clientUid: string;
  platformAccountId: string;
  kind: CaseKind;
  plaintiff: string | null;
  defendant: string | null;
  status: CaseStatus;
  filedTime: string | null;
  caseNumber: string | null;
  rejectTime: string | null;
  rejectReason: string | null;
  queryTime: Date | null;
  needsHuman: boolean;
  errorCode: string | null;
  sourceEventId: string;
  sourceUpdatedAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CaseListOptions {
  createdBy?: string;
  kind?: CaseKind;
  status?: CaseStatus;
  platformAccountId?: string;
  keyword?: string;
  needsHuman?: boolean;
  from?: string;
  to?: string;
  afterRevision?: number;
  limit: number;
}

export interface ExpiredCaseCursor {
  queryTime: Date;
  id: string;
}

export interface ExpiredCasePage {
  items: CaseRecord[];
  nextCursor: ExpiredCaseCursor | null;
}

export interface CaseRepository {
  findById(id: string, createdBy?: string): Promise<CaseRecord | null>;
  findByClientUid(clientUid: string, createdBy?: string): Promise<CaseRecord | null>;
  list(options?: Partial<CaseListOptions>): Promise<CaseRecord[]>;
  listChanges(afterRevision: number, limit: number, createdBy?: string): Promise<CaseRecord[]>;
  currentRevision(): Promise<number>;
  create(input: CaseWriteInput): Promise<CaseRecord>;
  update(id: string, input: CaseWriteInput, createdBy?: string): Promise<CaseRecord | null>;
  listExpired(before: Date, limit?: number, cursor?: ExpiredCaseCursor): Promise<ExpiredCasePage>;
  delete(id: string): Promise<void>;
}
