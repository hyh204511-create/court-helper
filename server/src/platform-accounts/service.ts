import { randomUUID } from 'node:crypto';

import type { ServerConfig } from '../config.ts';
import { AppError, NotFoundError, ValidationError } from '../errors.ts';
import { decryptCredential, encryptCredential, type PlainCredential } from './crypto.ts';
import type {
  PlatformAccountPatch,
  PlatformAccountRecord,
  PlatformAccountRepository,
} from './types.ts';

export class CredentialUnavailableError extends AppError {
  constructor() {
    super('Credential unavailable', 'CREDENTIAL_UNAVAILABLE', 503, false);
  }
}

export function publicPlatformAccount(account: PlatformAccountRecord) {
  return {
    id: account.id,
    label: account.label,
    enabled: account.enabled,
    updatedAt: account.updatedAt.toISOString(),
  };
}

function assertCredential(value: PlainCredential): void {
  if (
    typeof value.account !== 'string' || value.account.trim() === ''
    || typeof value.password !== 'string' || value.password.trim() === ''
  ) {
    throw new ValidationError([
      { field: 'account', code: 'required' },
      { field: 'password', code: 'required' },
    ]);
  }
}

export class PlatformAccountService {
  public readonly repository: PlatformAccountRepository;
  private readonly config: ServerConfig;

  constructor(repository: PlatformAccountRepository, config: ServerConfig) {
    this.repository = repository;
    this.config = config;
  }

  async list(role: 'admin' | 'user'): Promise<PlatformAccountRecord[]> {
    return this.repository.list(role === 'admin' ? { includeDeleted: true } : { enabledOnly: true });
  }

  async get(id: string): Promise<PlatformAccountRecord> {
    const account = await this.repository.findById(id);
    if (!account) throw new NotFoundError('Platform account not found');
    return account;
  }

  async create(createdBy: string, label: string, credential: PlainCredential, enabled = true): Promise<PlatformAccountRecord> {
    if (label.trim() === '') {
      throw new ValidationError([{ field: 'label', code: 'required' }]);
    }
    assertCredential(credential);
    const id = randomUUID();
    return this.repository.create({
      id,
      label,
      ...encryptCredential(id, credential, this.config.credentialMasterKey),
      enabled,
      createdBy,
    });
  }

  async update(id: string, patch: PlatformAccountPatch, credential?: PlainCredential): Promise<PlatformAccountRecord> {
    const current = await this.get(id);
    if (patch.label !== undefined && patch.label.trim() === '') {
      throw new ValidationError([{ field: 'label', code: 'required' }]);
    }
    const encrypted = credential
      ? encryptCredential(id, credential, this.config.credentialMasterKey)
      : {};
    const updated = await this.repository.update(id, { ...patch, ...encrypted });
    if (!updated) throw new NotFoundError('Platform account not found');
    void current;
    return updated;
  }

  async delete(id: string): Promise<PlatformAccountRecord> {
    const account = await this.repository.softDelete(id);
    if (!account) throw new NotFoundError('Platform account not found');
    return account;
  }

  async credential(id: string): Promise<PlainCredential> {
    const account = await this.get(id);
    if (!account.enabled || account.deletedAt !== null) {
      throw new AppError('Platform account disabled', 'ACCOUNT_DISABLED', 409, false);
    }
    try {
      return decryptCredential(id, account, this.config.credentialMasterKey);
    } catch {
      throw new CredentialUnavailableError();
    }
  }
}
