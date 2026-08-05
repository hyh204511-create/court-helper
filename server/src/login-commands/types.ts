export type LoginCommandStatus = 'pending' | 'executing' | 'success' | 'failed' | 'expired';

export interface LoginCommandRecord {
  id: string;
  platformAccountId: string;
  status: LoginCommandStatus;
  resultCode: string | null;
  resultMessage: string | null;
  claimedBy: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface NewLoginCommand {
  id?: string;
  platformAccountId: string;
  createdBy: string;
  expiresAt: Date;
}

export interface LoginCommandCompletion {
  ok: boolean;
  code?: string;
  message?: string;
}

export interface LoginCommandListItem {
  id: string;
  platformAccountId: string;
  accountLabel: string;
  status: LoginCommandStatus;
  resultCode: string | null;
  resultMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LoginCommandRepository {
  create(input: NewLoginCommand): Promise<LoginCommandRecord>;
  get(id: string): Promise<LoginCommandRecord | null>;
  listPending(now: Date): Promise<LoginCommandRecord[]>;
  findActiveForAccount(platformAccountId: string, now: Date): Promise<LoginCommandRecord | null>;
  claimNext(claimedBy: string, now: Date, leaseExpiresAt: Date): Promise<LoginCommandRecord | null>;
  complete(id: string, claimedBy: string, completion: Required<LoginCommandCompletion>): Promise<LoginCommandRecord | null>;
  expireStale(now: Date): Promise<number>;
  rollbackExpiredLeases(before: Date, pendingExpiresAt: Date): Promise<number>;
  listAdmin(limit: number): Promise<LoginCommandListItem[]>;
}
