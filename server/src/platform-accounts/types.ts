export interface PlatformAccountRecord {
  id: string;
  label: string;
  secretCiphertext: Buffer;
  secretIv: Buffer;
  secretTag: Buffer;
  secretVersion: number;
  enabled: boolean;
  deletedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  salespersonWecomUserId: string | null;
  assistantWecomUserId: string | null;
}

export interface EncryptedCredential {
  secretCiphertext: Buffer;
  secretIv: Buffer;
  secretTag: Buffer;
  secretVersion: number;
}

export interface NewPlatformAccount extends EncryptedCredential {
  id?: string;
  label: string;
  enabled?: boolean;
  salespersonWecomUserId?: string | null;
  assistantWecomUserId?: string | null;
  createdBy: string;
}

export interface PlatformAccountPatch extends Partial<EncryptedCredential> {
  label?: string;
  enabled?: boolean;
  salespersonWecomUserId?: string | null;
  assistantWecomUserId?: string | null;
}

export interface PlatformAccountListOptions {
  enabledOnly?: boolean;
  includeDeleted?: boolean;
}

export interface PlatformAccountRepository {
  findById(id: string): Promise<PlatformAccountRecord | null>;
  list(options?: PlatformAccountListOptions): Promise<PlatformAccountRecord[]>;
  create(input: NewPlatformAccount): Promise<PlatformAccountRecord>;
  update(id: string, patch: PlatformAccountPatch): Promise<PlatformAccountRecord | null>;
  softDelete(id: string): Promise<PlatformAccountRecord | null>;
}
