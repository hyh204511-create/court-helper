import { randomUUID } from 'node:crypto';

import type {
  NewPlatformAccount,
  PlatformAccountListOptions,
  PlatformAccountPatch,
  PlatformAccountRecord,
  PlatformAccountRepository,
} from './types.ts';

function duplicateError(): Error & { code: string } {
  const error = new Error('unique constraint violation') as Error & { code: string };
  error.code = '23505';
  return error;
}

function copyAccount(account: PlatformAccountRecord): PlatformAccountRecord {
  return {
    ...account,
    secretCiphertext: Buffer.from(account.secretCiphertext),
    secretIv: Buffer.from(account.secretIv),
    secretTag: Buffer.from(account.secretTag),
    deletedAt: account.deletedAt ? new Date(account.deletedAt) : null,
    createdAt: new Date(account.createdAt),
    updatedAt: new Date(account.updatedAt),
    salespersonMobile: account.salespersonMobile ?? null,
    assistantMobile: account.assistantMobile ?? null,
  };
}

export class MemoryPlatformAccountRepository implements PlatformAccountRepository {
  private readonly accounts = new Map<string, PlatformAccountRecord>();

  constructor(accounts: PlatformAccountRecord[] = []) {
    for (const account of accounts) this.accounts.set(account.id, copyAccount(account));
  }

  async findById(id: string): Promise<PlatformAccountRecord | null> {
    const account = this.accounts.get(id);
    return account ? copyAccount(account) : null;
  }

  async list(options: PlatformAccountListOptions = {}): Promise<PlatformAccountRecord[]> {
    return [...this.accounts.values()]
      .filter((account) => options.includeDeleted === true || account.deletedAt === null)
      .filter((account) => options.enabledOnly !== true || (account.enabled && account.deletedAt === null))
      .sort((left, right) => left.label.localeCompare(right.label))
      .map(copyAccount);
  }

  async create(input: NewPlatformAccount): Promise<PlatformAccountRecord> {
    if ([...this.accounts.values()].some((account) => account.deletedAt === null && account.label === input.label)) {
      throw duplicateError();
    }
    const now = new Date();
    const account: PlatformAccountRecord = {
      id: input.id ?? randomUUID(),
      label: input.label,
      secretCiphertext: Buffer.from(input.secretCiphertext),
      secretIv: Buffer.from(input.secretIv),
      secretTag: Buffer.from(input.secretTag),
      secretVersion: input.secretVersion,
      enabled: input.enabled ?? true,
      deletedAt: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      salespersonMobile: input.salespersonMobile ?? null,
      assistantMobile: input.assistantMobile ?? null,
    };
    this.accounts.set(account.id, account);
    return copyAccount(account);
  }

  async update(id: string, patch: PlatformAccountPatch): Promise<PlatformAccountRecord | null> {
    const account = this.accounts.get(id);
    if (!account) return null;
    if (patch.label !== undefined && [...this.accounts.values()].some((candidate) => candidate.id !== id && candidate.deletedAt === null && candidate.label === patch.label)) {
      throw duplicateError();
    }
    if (patch.label !== undefined) account.label = patch.label;
    if (patch.enabled !== undefined) account.enabled = patch.enabled;
    if (patch.salespersonMobile !== undefined) account.salespersonMobile = patch.salespersonMobile;
    if (patch.assistantMobile !== undefined) account.assistantMobile = patch.assistantMobile;
    if (patch.secretCiphertext !== undefined) account.secretCiphertext = Buffer.from(patch.secretCiphertext);
    if (patch.secretIv !== undefined) account.secretIv = Buffer.from(patch.secretIv);
    if (patch.secretTag !== undefined) account.secretTag = Buffer.from(patch.secretTag);
    if (patch.secretVersion !== undefined) account.secretVersion = patch.secretVersion;
    account.updatedAt = new Date();
    return copyAccount(account);
  }

  async softDelete(id: string): Promise<PlatformAccountRecord | null> {
    const account = this.accounts.get(id);
    if (!account) return null;
    account.enabled = false;
    account.deletedAt = new Date();
    account.updatedAt = new Date();
    return copyAccount(account);
  }
}
