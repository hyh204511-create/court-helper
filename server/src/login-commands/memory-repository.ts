import { randomUUID } from 'node:crypto';

import type { PlatformAccountRepository } from '../platform-accounts/types.ts';
import type {
  LoginCommandCompletion,
  LoginCommandListItem,
  LoginCommandRecord,
  LoginCommandRepository,
  NewLoginCommand,
} from './types.ts';

function copyCommand(command: LoginCommandRecord): LoginCommandRecord {
  return {
    ...command,
    createdAt: new Date(command.createdAt),
    updatedAt: new Date(command.updatedAt),
    expiresAt: new Date(command.expiresAt),
  };
}

function sortCreatedAsc(left: LoginCommandRecord, right: LoginCommandRecord): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id);
}

export class MemoryLoginCommandRepository implements LoginCommandRepository {
  private readonly commands = new Map<string, LoginCommandRecord>();
  private readonly platformAccounts: PlatformAccountRepository;

  constructor(platformAccounts: PlatformAccountRepository, commands: LoginCommandRecord[] = []) {
    this.platformAccounts = platformAccounts;
    for (const command of commands) this.commands.set(command.id, copyCommand(command));
  }

  async create(input: NewLoginCommand): Promise<LoginCommandRecord> {
    const now = new Date();
    const duplicate = [...this.commands.values()].find((candidate) => (
      candidate.platformAccountId === input.platformAccountId
      && ['pending', 'executing'].includes(candidate.status)
    ));
    if (duplicate) {
      const error = new Error('duplicate active login command') as Error & { code: string };
      error.code = '23505';
      throw error;
    }
    const command: LoginCommandRecord = {
      id: input.id ?? randomUUID(),
      platformAccountId: input.platformAccountId,
      status: 'pending',
      resultCode: null,
      resultMessage: null,
      claimedBy: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(input.expiresAt),
    };
    this.commands.set(command.id, command);
    return copyCommand(command);
  }

  async get(id: string): Promise<LoginCommandRecord | null> {
    const command = this.commands.get(id);
    return command ? copyCommand(command) : null;
  }

  async listPending(now: Date): Promise<LoginCommandRecord[]> {
    const nowTime = now.getTime();
    return [...this.commands.values()]
      .filter((command) => command.status === 'pending' && command.expiresAt.getTime() > nowTime)
      .sort(sortCreatedAsc)
      .map(copyCommand);
  }

  async findActiveForAccount(platformAccountId: string, now: Date): Promise<LoginCommandRecord | null> {
    const nowTime = now.getTime();
    const command = [...this.commands.values()]
      .filter((candidate) => candidate.platformAccountId === platformAccountId)
      .filter((candidate) => ['pending', 'executing'].includes(candidate.status))
      .filter((candidate) => candidate.expiresAt.getTime() > nowTime)
      .sort(sortCreatedAsc)[0];
    return command ? copyCommand(command) : null;
  }

  async claimNext(claimedBy: string, now: Date, leaseExpiresAt: Date): Promise<LoginCommandRecord | null> {
    const command = (await this.listPending(now))[0];
    if (!command) return null;
    const stored = this.commands.get(command.id);
    if (!stored || stored.status !== 'pending' || stored.expiresAt.getTime() <= now.getTime()) return null;
    stored.status = 'executing';
    stored.claimedBy = claimedBy;
    stored.updatedAt = new Date(now);
    stored.expiresAt = new Date(leaseExpiresAt);
    return copyCommand(stored);
  }

  async complete(
    id: string,
    claimedBy: string,
    completion: Required<LoginCommandCompletion>,
  ): Promise<LoginCommandRecord | null> {
    const command = this.commands.get(id);
    if (!command || command.status !== 'executing' || command.claimedBy !== claimedBy) return null;
    command.status = completion.ok ? 'success' : 'failed';
    command.resultCode = completion.ok ? null : completion.code;
    command.resultMessage = completion.ok ? null : completion.message;
    command.updatedAt = new Date();
    return copyCommand(command);
  }

  async expireStale(now: Date): Promise<number> {
    let count = 0;
    const nowTime = now.getTime();
    for (const command of this.commands.values()) {
      if (command.status === 'pending' && command.expiresAt.getTime() < nowTime) {
        command.status = 'expired';
        command.updatedAt = new Date(now);
        count += 1;
      }
    }
    return count;
  }

  async rollbackExpiredLeases(before: Date, now: Date): Promise<number> {
    let count = 0;
    const beforeTime = before.getTime();
    for (const command of this.commands.values()) {
      if (command.status === 'executing' && command.updatedAt.getTime() < beforeTime) {
        command.status = 'pending';
        command.claimedBy = null;
        command.updatedAt = new Date(now);
        count += 1;
      }
    }
    return count;
  }

  async listAdmin(limit: number): Promise<LoginCommandListItem[]> {
    const commands = [...this.commands.values()]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
      .slice(0, limit);
    const items: LoginCommandListItem[] = [];
    for (const command of commands) {
      const account = await this.platformAccounts.findById(command.platformAccountId);
      items.push({
        id: command.id,
        platformAccountId: command.platformAccountId,
        accountLabel: account?.label ?? 'unknown account',
        status: command.status,
        resultCode: command.resultCode,
        resultMessage: command.resultMessage,
        createdAt: new Date(command.createdAt),
        updatedAt: new Date(command.updatedAt),
      });
    }
    return items;
  }
}
