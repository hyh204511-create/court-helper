import { randomUUID } from 'node:crypto';

import type {
  CaseListOptions,
  CaseRecord,
  CaseRepository,
  CaseWriteInput,
} from './types.ts';

function constraintError(): Error & { code: string } {
  const error = new Error('unique constraint violation') as Error & { code: string };
  error.code = '23505';
  return error;
}

function dateTimeValue(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? new Date(value) : new Date(value);
}

function writeValue(input: CaseWriteInput) {
  return {
    clientUid: input.clientUid,
    platformAccountId: input.platformAccountId,
    kind: input.kind,
    plaintiff: input.plaintiff,
    defendant: input.defendant,
    status: input.status,
    filedTime: input.filedTime,
    caseNumber: input.caseNumber,
    rejectTime: input.rejectTime,
    rejectReason: input.rejectReason,
    queryTime: dateTimeValue(input.queryTime),
    needsHuman: input.needsHuman,
    errorCode: input.errorCode,
    sourceEventId: input.sourceEventId,
    sourceUpdatedAt: dateTimeValue(input.sourceUpdatedAt),
  };
}

function copyCase(value: CaseRecord): CaseRecord {
  return {
    ...value,
    queryTime: value.queryTime ? new Date(value.queryTime) : null,
    sourceUpdatedAt: value.sourceUpdatedAt ? new Date(value.sourceUpdatedAt) : null,
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
  };
}

function matchesDate(value: string | null, from: string | undefined, to: string | undefined): boolean {
  if (from !== undefined && (value === null || value < from)) return false;
  if (to !== undefined && (value === null || value > to)) return false;
  return true;
}

export class MemoryCaseRepository implements CaseRepository {
  private readonly cases = new Map<string, CaseRecord>();
  private nextRevision: number;

  constructor(cases: CaseRecord[] = []) {
    let maxRevision = 0;
    for (const value of cases) {
      this.cases.set(value.id, copyCase(value));
      maxRevision = Math.max(maxRevision, value.revision);
    }
    this.nextRevision = maxRevision + 1;
  }

  async findById(id: string): Promise<CaseRecord | null> {
    const value = this.cases.get(id);
    return value ? copyCase(value) : null;
  }

  async findByClientUid(clientUid: string): Promise<CaseRecord | null> {
    const value = [...this.cases.values()].find((candidate) => candidate.clientUid === clientUid);
    return value ? copyCase(value) : null;
  }

  async list(options: Partial<CaseListOptions> = {}): Promise<CaseRecord[]> {
    const values = [...this.cases.values()]
      .filter((value) => options.kind === undefined || value.kind === options.kind)
      .filter((value) => options.status === undefined || value.status === options.status)
      .filter((value) => options.platformAccountId === undefined || value.platformAccountId === options.platformAccountId)
      .filter((value) => options.needsHuman === undefined || value.needsHuman === options.needsHuman)
      .filter((value) => options.afterRevision === undefined || value.revision > options.afterRevision)
      .filter((value) => matchesDate(value.filedTime, options.from, options.to))
      .sort((left, right) => left.revision - right.revision || left.id.localeCompare(right.id));
    return values.slice(0, options.limit ?? Number.MAX_SAFE_INTEGER).map(copyCase);
  }

  async listChanges(afterRevision: number, limit: number): Promise<CaseRecord[]> {
    return this.list({ afterRevision, limit });
  }

  async currentRevision(): Promise<number> {
    return this.nextRevision - 1;
  }

  async create(input: CaseWriteInput): Promise<CaseRecord> {
    if (this.cases.has(input.id ?? '')) throw constraintError();
    if ([...this.cases.values()].some((value) => value.clientUid === input.clientUid)) {
      throw constraintError();
    }
    const now = new Date();
    const value: CaseRecord = {
      id: input.id ?? randomUUID(),
      ...writeValue(input),
      revision: this.nextRevision++,
      createdAt: now,
      updatedAt: now,
    };
    this.cases.set(value.id, value);
    return copyCase(value);
  }

  async update(id: string, input: CaseWriteInput): Promise<CaseRecord | null> {
    const current = this.cases.get(id);
    if (!current) return null;
    const value: CaseRecord = {
      id: current.id,
      ...writeValue(input),
      revision: this.nextRevision++,
      createdAt: current.createdAt,
      updatedAt: new Date(),
    };
    this.cases.set(id, value);
    return copyCase(value);
  }
}
