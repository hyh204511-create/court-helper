import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../errors.ts';
import type {
  LoginCommandCompletion,
  LoginCommandListItem,
  LoginCommandRecord,
  LoginCommandRepository,
} from './types.ts';

const PENDING_TTL_MS = 5 * 60 * 1000;
const LEASE_TTL_MS = 60 * 1000;
const RESULT_MESSAGE_LIMIT = 200;

export interface LoginCommandServiceOptions {
  now?: () => Date;
}

export function publicLoginCommand(command: LoginCommandRecord) {
  return {
    id: command.id,
    status: command.status,
    createdAt: command.createdAt.toISOString(),
  };
}

export function publicLoginCommandResult(command: LoginCommandRecord) {
  return {
    id: command.id,
    status: command.status,
    resultCode: command.resultCode,
    updatedAt: command.updatedAt.toISOString(),
  };
}

export function publicLoginCommandListItem(command: LoginCommandListItem) {
  return {
    id: command.id,
    platformAccountId: command.platformAccountId,
    accountLabel: command.accountLabel,
    status: command.status,
    resultCode: command.resultCode,
    resultMessage: command.resultMessage,
    createdAt: command.createdAt.toISOString(),
    updatedAt: command.updatedAt.toISOString(),
  };
}

function assertUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ValidationError([{ field, code: 'uuid_required' }]);
  }
}

function normalizeCompletion(input: LoginCommandCompletion): Required<LoginCommandCompletion> {
  if (typeof input.ok !== 'boolean') {
    throw new ValidationError([{ field: 'ok', code: 'boolean_required' }]);
  }
  if (input.ok) return { ok: true, code: '', message: '' };
  const code = typeof input.code === 'string' && input.code.trim() !== ''
    ? input.code.trim().slice(0, RESULT_MESSAGE_LIMIT)
    : 'UNKNOWN';
  const message = typeof input.message === 'string'
    ? input.message.slice(0, RESULT_MESSAGE_LIMIT)
    : '';
  return { ok: false, code, message };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}

function isTerminalStatus(status: LoginCommandRecord['status']): boolean {
  return status === 'success' || status === 'failed';
}

export class LoginCommandService {
  public readonly repository: LoginCommandRepository;
  private readonly now: () => Date;

  constructor(repository: LoginCommandRepository, options: LoginCommandServiceOptions = {}) {
    this.repository = repository;
    this.now = options.now ?? (() => new Date());
  }

  async get(id: string): Promise<LoginCommandRecord> {
    const command = await this.repository.get(id);
    if (!command) throw new NotFoundError('Login command not found');
    return command;
  }

  async create(platformAccountId: string, createdBy: string): Promise<LoginCommandRecord> {
    assertUuid(platformAccountId, 'platformAccountId');
    const now = this.now();
    await this.repository.rollbackExpiredLeases(
      new Date(now.getTime() - LEASE_TTL_MS),
      now,
    );
    await this.repository.expireStale(now);
    const duplicate = await this.repository.findActiveForAccount(platformAccountId, now);
    if (duplicate) {
      throw new ConflictError('Login command already pending', 'DUPLICATE_PENDING');
    }
    try {
      return await this.repository.create({
        platformAccountId,
        createdBy,
        expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('Login command already pending', 'DUPLICATE_PENDING');
      }
      throw error;
    }
  }

  async claimNext(claimedBy: string): Promise<LoginCommandRecord | null> {
    if (claimedBy.trim() === '') throw new ValidationError([{ field: 'claimedBy', code: 'required' }]);
    const now = this.now();
    await this.repository.rollbackExpiredLeases(
      new Date(now.getTime() - LEASE_TTL_MS),
      now,
    );
    await this.repository.expireStale(now);
    return this.repository.claimNext(claimedBy, now, new Date(now.getTime() + LEASE_TTL_MS));
  }

  async complete(
    id: string,
    claimedBy: string,
    completion: LoginCommandCompletion,
  ): Promise<LoginCommandRecord> {
    assertUuid(id, 'id');
    const normalized = normalizeCompletion(completion);
    const completed = await this.repository.complete(id, claimedBy, normalized);
    if (completed) return completed;
    const current = await this.repository.get(id);
    if (!current) throw new NotFoundError('Login command not found');
    if (current.claimedBy === claimedBy && isTerminalStatus(current.status)) return current;
    throw new ForbiddenError('Login command claimed by another session');
  }

  async listAdmin(limit: number): Promise<LoginCommandListItem[]> {
    const safeLimit = Math.max(1, Math.min(100, Number.isFinite(limit) ? Math.trunc(limit) : 100));
    return this.repository.listAdmin(safeLimit);
  }
}
