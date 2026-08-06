export const BROWSER_COMMAND_TYPES = [
  'LOGIN',
  'QUERY_LI',
  'QUERY_QZ',
  'EXPORT_REPORT',
] as const;

export type BrowserCommandType = (typeof BROWSER_COMMAND_TYPES)[number];

export const BROWSER_COMMAND_STATUSES = [
  'pending',
  'executing',
  'succeeded',
  'failed',
  'expired',
  'manual_required',
  'cancelled',
] as const;

export type BrowserCommandStatus = (typeof BROWSER_COMMAND_STATUSES)[number];

export const BROWSER_COMMAND_RESULT_STATUSES = [
  'succeeded',
  'failed',
  'manual_required',
] as const;

export type BrowserCommandResultStatus = (typeof BROWSER_COMMAND_RESULT_STATUSES)[number];

export type BrowserCommandJsonObject = Record<string, unknown>;
export type BrowserCommandProgress = number | BrowserCommandJsonObject | null;

export interface BrowserCommandCursor {
  createdAt: Date;
  id: string;
}

export interface BrowserCommandRecord {
  id: string;
  type: BrowserCommandType;
  status: BrowserCommandStatus;
  platformAccountId: string | null;
  clientBatchId: string | null;
  requestedBy: string;
  claimedBy: string | null;
  claimTokenHash: string | null;
  payload: BrowserCommandJsonObject;
  resultCode: string | null;
  resultSummary: string | null;
  progress: BrowserCommandProgress;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface NewBrowserCommand {
  id?: string;
  type: BrowserCommandType;
  platformAccountId: string | null;
  clientBatchId: string | null;
  requestedBy: string;
  payload: BrowserCommandJsonObject;
  expiresAt: Date;
}

export interface BrowserCommandResultInput {
  status: BrowserCommandResultStatus;
  resultCode: string;
  resultSummary: string;
  progress: BrowserCommandProgress;
}

export interface BrowserCommandListOptions {
  requestedBy?: string;
  status?: BrowserCommandStatus;
  type?: BrowserCommandType;
  limit: number;
  cursor?: BrowserCommandCursor;
}

export interface BrowserCommandPage {
  items: BrowserCommandRecord[];
  nextCursor: BrowserCommandCursor | null;
}

export interface BrowserCommandRepository {
  create(input: NewBrowserCommand): Promise<BrowserCommandRecord>;
  get(id: string): Promise<BrowserCommandRecord | null>;
  list(options: BrowserCommandListOptions): Promise<BrowserCommandPage>;
  findActiveForAccount(platformAccountId: string, now: Date): Promise<BrowserCommandRecord | null>;
  claim(
    id: string,
    claimedBy: string,
    claimTokenHash: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<BrowserCommandRecord | null>;
  writeResult(
    id: string,
    claimedBy: string,
    claimTokenHash: string,
    result: BrowserCommandResultInput,
    now: Date,
  ): Promise<BrowserCommandRecord | null>;
  cancel(id: string, requestedBy: string, now: Date): Promise<BrowserCommandRecord | null>;
  expireStale(now: Date): Promise<number>;
}
