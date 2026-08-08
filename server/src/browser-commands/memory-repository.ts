import { randomUUID } from 'node:crypto';

import type {
  BrowserCommandJsonObject,
  BrowserCommandListOptions,
  BrowserCommandPage,
  BrowserCommandRecord,
  BrowserCommandRepository,
  BrowserCommandResultInput,
  BrowserCommandType,
  NewBrowserCommand,
} from './types.ts';

function uniqueViolation(): Error & { code: string } {
  const error = new Error('unique constraint violation') as Error & { code: string };
  error.code = '23505';
  return error;
}

function cloneJsonObject(value: BrowserCommandJsonObject): BrowserCommandJsonObject {
  return JSON.parse(JSON.stringify(value)) as BrowserCommandJsonObject;
}

function cloneProgress(value: BrowserCommandRecord['progress']): BrowserCommandRecord['progress'] {
  return value === null || typeof value === 'number'
    ? value
    : cloneJsonObject(value);
}

function copyCommand(command: BrowserCommandRecord): BrowserCommandRecord {
  return {
    ...command,
    payload: cloneJsonObject(command.payload),
    progress: cloneProgress(command.progress),
    createdAt: new Date(command.createdAt),
    updatedAt: new Date(command.updatedAt),
    expiresAt: new Date(command.expiresAt),
  };
}

function sortNewest(left: BrowserCommandRecord, right: BrowserCommandRecord): number {
  return right.createdAt.getTime() - left.createdAt.getTime()
    || right.id.localeCompare(left.id);
}

function sortOldest(left: BrowserCommandRecord, right: BrowserCommandRecord): number {
  return left.createdAt.getTime() - right.createdAt.getTime()
    || left.id.localeCompare(right.id);
}

function active(command: BrowserCommandRecord): boolean {
  return command.status === 'pending' || command.status === 'executing';
}

function terminal(command: BrowserCommandRecord): boolean {
  return ['succeeded', 'failed', 'expired', 'manual_required', 'cancelled'].includes(command.status);
}

export class MemoryBrowserCommandRepository implements BrowserCommandRepository {
  private readonly commands = new Map<string, BrowserCommandRecord>();

  constructor(commands: BrowserCommandRecord[] = []) {
    for (const command of commands) this.commands.set(command.id, copyCommand(command));
  }

  async create(input: NewBrowserCommand): Promise<BrowserCommandRecord> {
    const duplicate = [...this.commands.values()].find((candidate) => (
      input.platformAccountId !== null
      && candidate.platformAccountId === input.platformAccountId
      && active(candidate)
    ));
    if (duplicate || this.commands.has(input.id ?? '')) throw uniqueViolation();

    const now = new Date();
    const command: BrowserCommandRecord = {
      id: input.id ?? randomUUID(),
      type: input.type,
      status: 'pending',
      platformAccountId: input.platformAccountId,
      clientBatchId: input.clientBatchId,
      requestedBy: input.requestedBy,
      claimedBy: null,
      claimTokenHash: null,
      payload: cloneJsonObject(input.payload),
      resultCode: null,
      resultSummary: null,
      progress: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(input.expiresAt),
    };
    this.commands.set(command.id, command);
    return copyCommand(command);
  }

  async get(id: string): Promise<BrowserCommandRecord | null> {
    const command = this.commands.get(id);
    return command ? copyCommand(command) : null;
  }

  async list(options: BrowserCommandListOptions): Promise<BrowserCommandPage> {
    const values = [...this.commands.values()]
      .filter((command) => options.requestedBy === undefined || command.requestedBy === options.requestedBy)
      .filter((command) => options.status === undefined || command.status === options.status)
      .filter((command) => options.type === undefined || command.type === options.type)
      .filter((command) => {
        if (!options.cursor) return true;
        const createdAt = command.createdAt.getTime();
        const cursorCreatedAt = options.cursor.createdAt.getTime();
        return createdAt < cursorCreatedAt
          || (createdAt === cursorCreatedAt && command.id.localeCompare(options.cursor.id) < 0);
      })
      .sort(sortNewest);
    const rows = values.slice(0, options.limit + 1);
    const items = rows.slice(0, options.limit);
    const last = items[items.length - 1];
    return {
      items: items.map(copyCommand),
      nextCursor: rows.length > options.limit && last
        ? { createdAt: new Date(last.createdAt), id: last.id }
        : null,
    };
  }

  async findActiveForAccount(platformAccountId: string, now: Date): Promise<BrowserCommandRecord | null> {
    const value = [...this.commands.values()]
      .filter((command) => command.platformAccountId === platformAccountId && active(command))
      .filter((command) => command.expiresAt.getTime() > now.getTime())
      .sort(sortOldest)[0];
    return value ? copyCommand(value) : null;
  }

  async claim(
    id: string,
    claimedBy: string,
    claimTokenHash: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<BrowserCommandRecord | null> {
    const command = this.commands.get(id);
    if (!command || command.status !== 'pending' || command.expiresAt.getTime() <= now.getTime()) return null;
    command.status = 'executing';
    command.claimedBy = claimedBy;
    command.claimTokenHash = claimTokenHash;
    command.updatedAt = new Date(now);
    command.expiresAt = new Date(leaseExpiresAt);
    return copyCommand(command);
  }

  async writeResult(
    id: string,
    claimedBy: string,
    claimTokenHash: string,
    result: BrowserCommandResultInput,
    now: Date,
  ): Promise<BrowserCommandRecord | null> {
    const command = this.commands.get(id);
    if (
      !command
      || command.status !== 'executing'
      || command.claimedBy !== claimedBy
      || command.claimTokenHash !== claimTokenHash
    ) return null;
    command.status = result.status;
    command.resultCode = result.resultCode;
    command.resultSummary = result.resultSummary;
    command.progress = cloneProgress(result.progress);
    command.updatedAt = new Date(now);
    return copyCommand(command);
  }

  async cancel(id: string, requestedBy: string, now: Date): Promise<BrowserCommandRecord | null> {
    const command = this.commands.get(id);
    if (!command || command.requestedBy !== requestedBy) return null;
    if (!active(command)) return copyCommand(command);
    command.status = 'cancelled';
    command.updatedAt = new Date(now);
    return copyCommand(command);
  }

  async deleteTerminal(requestedBy?: string, type?: BrowserCommandType): Promise<number> {
    let count = 0;
    for (const [id, command] of this.commands) {
      if (terminal(command)
        && (requestedBy === undefined || command.requestedBy === requestedBy)
        && (type === undefined || command.type === type)) {
        this.commands.delete(id);
        count += 1;
      }
    }
    return count;
  }

  async deleteTerminalById(id: string, requestedBy?: string): Promise<BrowserCommandRecord | null> {
    const command = this.commands.get(id);
    if (!command || (requestedBy !== undefined && command.requestedBy !== requestedBy) || !terminal(command)) return null;
    this.commands.delete(id);
    return copyCommand(command);
  }

  async expireStale(now: Date): Promise<number> {
    let count = 0;
    for (const command of this.commands.values()) {
      if (active(command) && command.expiresAt.getTime() <= now.getTime()) {
        command.status = 'expired';
        command.updatedAt = new Date(now);
        count += 1;
      }
    }
    return count;
  }
}
