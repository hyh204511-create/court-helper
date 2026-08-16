import { NotFoundError, ValidationError } from '../errors.ts';
import type { PlatformAccountRepository } from '../platform-accounts/types.ts';
import { isBeforeRetentionCutoff, retentionCutoff, type Clock } from '../retention/policy.ts';
import { ownerIdFor } from './types.ts';
import type {
  CaseAccess,
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

function writeInput(item: CaseSyncItem, id?: string, createdBy?: string | null): CaseWriteInput {
  return {
    id,
    createdBy,
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

function responseClientUid(item: CaseSyncItem): string {
  return item.responseClientUid ?? item.clientUid;
}

function accepted(item: CaseSyncItem, value: CaseRecord): AcceptedCase {
  return {
    id: value.id,
    clientUid: responseClientUid(item),
    eventId: item.eventId,
    revision: value.revision,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}

export class CaseService {
  public readonly repository: CaseRepository;
  private readonly platformAccounts: PlatformAccountRepository;

  private readonly clock: Clock;

  constructor(repository: CaseRepository, platformAccounts: PlatformAccountRepository, clock: Clock = () => new Date()) {
    this.repository = repository;
    this.platformAccounts = platformAccounts;
    this.clock = clock;
  }

  async sync(items: CaseSyncItem[], access: CaseAccess): Promise<SyncResult> {
    const acceptedItems: AcceptedCase[] = [];
    const conflicts: CaseConflict[] = [];
    const ownerId = ownerIdFor(access);

    const cutoff = retentionCutoff(new Date(this.clock()));
    for (const item of items) {
      const queryTime = item.queryTime === null ? null : new Date(item.queryTime);
      if (isBeforeRetentionCutoff(queryTime, cutoff)) {
        throw new ValidationError([{ field: 'queryTime', code: 'retention_expired' }]);
      }
    }

    for (const item of items) {
      const account = await this.platformAccounts.findById(item.platformAccountId);
      if (!account) {
        conflicts.push({ clientUid: responseClientUid(item), eventId: item.eventId, code: 'NOT_FOUND' });
        continue;
      }
      if (!account.enabled || account.deletedAt !== null) {
        conflicts.push({ clientUid: responseClientUid(item), eventId: item.eventId, code: 'ACCOUNT_DISABLED' });
        continue;
      }

      const current = await this.repository.findByClientUid(item.clientUid, ownerId);
      if (!current) {
        try {
          const created = await this.repository.create(writeInput(item, undefined, access.userId));
          acceptedItems.push(accepted(item, created));
        } catch (error) {
          if (ownerId !== undefined && isUniqueViolation(error)) {
            conflicts.push({ clientUid: responseClientUid(item), eventId: item.eventId, code: 'CONFLICT' });
            continue;
          }
          throw error;
        }
        continue;
      }

      if (item.eventId === current.sourceEventId) {
        if (sameContent(item, current)) {
          acceptedItems.push(accepted(item, current));
        } else {
          conflicts.push({ clientUid: responseClientUid(item), eventId: item.eventId, code: 'CONFLICT' });
        }
        continue;
      }

      const incomingTime = new Date(item.sourceUpdatedAt).getTime();
      const currentTime = current.sourceUpdatedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      if (incomingTime < currentTime) {
        conflicts.push({ clientUid: responseClientUid(item), eventId: item.eventId, code: 'CONFLICT' });
        continue;
      }
      if (incomingTime === currentTime) {
        if (sameContent(item, current)) {
          acceptedItems.push(accepted(item, current));
        } else {
          conflicts.push({ clientUid: responseClientUid(item), eventId: item.eventId, code: 'CONFLICT' });
        }
        continue;
      }

      const updated = await this.repository.update(
        current.id,
        writeInput(item, current.id, current.createdBy),
        ownerId,
      );
      if (!updated) throw new NotFoundError('Case not found');
      acceptedItems.push(accepted(item, updated));
    }

    return {
      accepted: acceptedItems,
      conflicts,
      cursor: await this.repository.currentRevision(),
    };
  }

  async list(options: Partial<CaseListOptions> = {}, access: CaseAccess): Promise<CaseRecord[]> {
    const ownerId = ownerIdFor(access);
    return this.repository.list(ownerId === undefined ? options : { ...options, createdBy: ownerId });
  }

  async changes(afterRevision: number, limit: number, access: CaseAccess): Promise<CaseRecord[]> {
    return this.repository.listChanges(afterRevision, limit, ownerIdFor(access));
  }

  async currentRevision(): Promise<number> {
    return this.repository.currentRevision();
  }

  async get(id: string, access: CaseAccess): Promise<CaseRecord> {
    const value = await this.repository.findById(id, ownerIdFor(access));
    if (!value) throw new NotFoundError('Case not found');
    return value;
  }
}
