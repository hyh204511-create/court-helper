import { NotFoundError } from '../errors.ts';
import type { PlatformAccountRepository } from '../platform-accounts/types.ts';
import type {
  CaseListOptions,
  CaseRecord,
  CaseRepository,
  CaseSyncItem,
  CaseWriteInput,
} from './types.ts';

export interface AcceptedCase {
  id: string;
  clientUid: string;
  eventId: string;
  revision: number;
}

export interface CaseConflict {
  clientUid: string;
  eventId: string;
  code: 'CONFLICT' | 'ACCOUNT_DISABLED' | 'NOT_FOUND';
}

export interface SyncResult {
  accepted: AcceptedCase[];
  conflicts: CaseConflict[];
  cursor: number;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function publicCase(value: CaseRecord) {
  return {
    id: value.id,
    clientUid: value.clientUid,
    platformAccountId: value.platformAccountId,
    kind: value.kind,
    plaintiff: value.plaintiff,
    defendant: value.defendant,
    status: value.status,
    filedTime: value.filedTime,
    caseNumber: value.caseNumber,
    rejectTime: value.rejectTime,
    rejectReason: value.rejectReason,
    queryTime: iso(value.queryTime),
    needsHuman: value.needsHuman,
    errorCode: value.errorCode,
    sourceEventId: value.sourceEventId,
    sourceUpdatedAt: iso(value.sourceUpdatedAt),
    revision: value.revision,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

function dateTime(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function writeInput(item: CaseSyncItem, id?: string): CaseWriteInput {
  return {
    id,
    clientUid: item.clientUid,
    platformAccountId: item.platformAccountId,
    kind: item.kind,
    plaintiff: item.plaintiff,
    defendant: item.defendant,
    status: item.status,
    filedTime: item.filedTime,
    caseNumber: item.caseNumber,
    rejectTime: item.rejectTime,
    rejectReason: item.rejectReason,
    queryTime: dateTime(item.queryTime),
    needsHuman: item.needsHuman,
    errorCode: item.errorCode,
    sourceEventId: item.eventId,
    sourceUpdatedAt: new Date(item.sourceUpdatedAt),
  };
}

function contentOfItem(item: CaseSyncItem) {
  return {
    clientUid: item.clientUid,
    platformAccountId: item.platformAccountId,
    kind: item.kind,
    plaintiff: item.plaintiff,
    defendant: item.defendant,
    status: item.status,
    filedTime: item.filedTime,
    caseNumber: item.caseNumber,
    rejectTime: item.rejectTime,
    rejectReason: item.rejectReason,
    queryTime: item.queryTime,
    needsHuman: item.needsHuman,
    errorCode: item.errorCode,
    sourceUpdatedAt: item.sourceUpdatedAt,
  };
}

function contentOfRecord(value: CaseRecord) {
  return {
    clientUid: value.clientUid,
    platformAccountId: value.platformAccountId,
    kind: value.kind,
    plaintiff: value.plaintiff,
    defendant: value.defendant,
    status: value.status,
    filedTime: value.filedTime,
    caseNumber: value.caseNumber,
    rejectTime: value.rejectTime,
    rejectReason: value.rejectReason,
    queryTime: iso(value.queryTime),
    needsHuman: value.needsHuman,
    errorCode: value.errorCode,
    sourceUpdatedAt: iso(value.sourceUpdatedAt),
  };
}

function sameContent(item: CaseSyncItem, current: CaseRecord): boolean {
  return JSON.stringify(contentOfItem(item)) === JSON.stringify(contentOfRecord(current));
}

function accepted(item: CaseSyncItem, value: CaseRecord): AcceptedCase {
  return {
    id: value.id,
    clientUid: item.clientUid,
    eventId: item.eventId,
    revision: value.revision,
  };
}

export class CaseService {
  public readonly repository: CaseRepository;
  private readonly platformAccounts: PlatformAccountRepository;

  constructor(repository: CaseRepository, platformAccounts: PlatformAccountRepository) {
    this.repository = repository;
    this.platformAccounts = platformAccounts;
  }

  async sync(items: CaseSyncItem[]): Promise<SyncResult> {
    const acceptedItems: AcceptedCase[] = [];
    const conflicts: CaseConflict[] = [];

    for (const item of items) {
      const account = await this.platformAccounts.findById(item.platformAccountId);
      if (!account) {
        conflicts.push({ clientUid: item.clientUid, eventId: item.eventId, code: 'NOT_FOUND' });
        continue;
      }
      if (!account.enabled || account.deletedAt !== null) {
        conflicts.push({ clientUid: item.clientUid, eventId: item.eventId, code: 'ACCOUNT_DISABLED' });
        continue;
      }

      const current = await this.repository.findByClientUid(item.clientUid);
      if (!current) {
        const created = await this.repository.create(writeInput(item));
        acceptedItems.push(accepted(item, created));
        continue;
      }

      if (item.eventId === current.sourceEventId) {
        if (sameContent(item, current)) {
          acceptedItems.push(accepted(item, current));
        } else {
          conflicts.push({ clientUid: item.clientUid, eventId: item.eventId, code: 'CONFLICT' });
        }
        continue;
      }

      const incomingTime = new Date(item.sourceUpdatedAt).getTime();
      const currentTime = current.sourceUpdatedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      if (incomingTime < currentTime) {
        conflicts.push({ clientUid: item.clientUid, eventId: item.eventId, code: 'CONFLICT' });
        continue;
      }
      if (incomingTime === currentTime) {
        if (sameContent(item, current)) {
          acceptedItems.push(accepted(item, current));
        } else {
          conflicts.push({ clientUid: item.clientUid, eventId: item.eventId, code: 'CONFLICT' });
        }
        continue;
      }

      const updated = await this.repository.update(current.id, writeInput(item, current.id));
      if (!updated) throw new NotFoundError('Case not found');
      acceptedItems.push(accepted(item, updated));
    }

    return {
      accepted: acceptedItems,
      conflicts,
      cursor: await this.repository.currentRevision(),
    };
  }

  async list(options: Partial<CaseListOptions> = {}): Promise<CaseRecord[]> {
    return this.repository.list(options);
  }

  async changes(afterRevision: number, limit: number): Promise<CaseRecord[]> {
    return this.repository.listChanges(afterRevision, limit);
  }

  async currentRevision(): Promise<number> {
    return this.repository.currentRevision();
  }

  async get(id: string): Promise<CaseRecord> {
    const value = await this.repository.findById(id);
    if (!value) throw new NotFoundError('Case not found');
    return value;
  }
}
