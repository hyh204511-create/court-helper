export const CASE_KINDS = ['li', 'qz'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

export const CASE_STATUSES = ['立案成功', '强执成功', '已驳回', '审核中', 'UNKNOWN'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export type CaseDateTimeInput = Date | string | null;

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
  kind?: CaseKind;
  status?: CaseStatus;
  platformAccountId?: string;
  needsHuman?: boolean;
  from?: string;
  to?: string;
  afterRevision?: number;
  limit: number;
}

export interface CaseRepository {
  findById(id: string): Promise<CaseRecord | null>;
  findByClientUid(clientUid: string): Promise<CaseRecord | null>;
  list(options?: Partial<CaseListOptions>): Promise<CaseRecord[]>;
  listChanges(afterRevision: number, limit: number): Promise<CaseRecord[]>;
  currentRevision(): Promise<number>;
  create(input: CaseWriteInput): Promise<CaseRecord>;
  update(id: string, input: CaseWriteInput): Promise<CaseRecord | null>;
}
