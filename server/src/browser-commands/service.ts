import { hashToken, newOpaqueToken } from '../auth/token.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../errors.ts';
import {
  BROWSER_COMMAND_RESULT_STATUSES,
  BROWSER_COMMAND_STATUSES,
  BROWSER_COMMAND_TYPES,
  type BrowserCommandJsonObject,
  type BrowserCommandListOptions,
  type BrowserCommandProgress,
  type BrowserCommandRecord,
  type BrowserCommandRepository,
  type BrowserCommandResultInput,
  type BrowserCommandResultStatus,
  type BrowserCommandStatus,
  type BrowserCommandType,
  type NewBrowserCommand,
} from './types.ts';

export const BROWSER_COMMAND_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BROWSER_COMMAND_PENDING_TTL_MS = 5 * 60 * 1000;
export const BROWSER_COMMAND_LEASE_TTL_MS = 60 * 1000;
export const BROWSER_COMMAND_RESULT_SUMMARY_LIMIT = 200;
export const BROWSER_COMMAND_PAYLOAD_BYTES_LIMIT = 16 * 1024;
export const BROWSER_COMMAND_PROGRESS_BYTES_LIMIT = 2 * 1024;

const SENSITIVE_NAME = /(?:^|[_-])(password|passwd|pwd|captcha|verification(?:[_-]?code)?|secret|credential|access[_-]?token|refresh[_-]?token|case[_-]?number|plaintiff|defendant|party|person|id[_-]?card|screenshot|image|photo|reject[_-]?reason|raw|response(?:[_-]?body)?)(?:$|[_-])/i;
const SENSITIVE_TEXT = /password|passwd|captcha|verification\s*code|secret|credential|access\s*token|refresh\s*token|case\s*number|plaintiff|defendant|id\s*card|screenshot|image\s*data|raw\s*response|response\s*body|案号|原告|被告|身份证|验证码|截图/i;
const SAFE_RESULT_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TERMINAL_STATUSES = new Set<BrowserCommandStatus>([
  'succeeded',
  'failed',
  'expired',
  'manual_required',
  'cancelled',
]);

export interface BrowserCommandServiceOptions {
  now?: () => Date;
}

export interface BrowserCommandCreateInput {
  id?: string;
  type: BrowserCommandType;
  platformAccountId?: string | null;
  clientBatchId?: string | null;
  requestedBy: string;
  payload?: BrowserCommandJsonObject;
  expiresAt?: Date;
}

export interface BrowserCommandClaimResult {
  command: BrowserCommandRecord;
  claimToken: string | null;
}

export interface BrowserCommandResultRequest {
  deviceId: unknown;
  claimToken: unknown;
  status: unknown;
  resultCode?: unknown;
  resultSummary?: unknown;
  progress?: unknown;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonObject(value: BrowserCommandJsonObject): BrowserCommandJsonObject {
  return JSON.parse(JSON.stringify(value)) as BrowserCommandJsonObject;
}

function cloneProgress(value: BrowserCommandProgress): BrowserCommandProgress {
  if (value === null || typeof value === 'number') return value;
  return cloneJsonObject(value);
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !BROWSER_COMMAND_UUID_PATTERN.test(value)) {
    throw new ValidationError([{ field, code: 'uuid_required' }]);
  }
}

export function isBrowserCommandUuid(value: unknown): value is string {
  return typeof value === 'string' && BROWSER_COMMAND_UUID_PATTERN.test(value);
}

function assertNonEmptyString(value: unknown, field: string, maxLength?: number): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError([{ field, code: 'required' }]);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new ValidationError([{ field, code: 'maximum_exceeded' }]);
  }
}

function assertSafeName(name: string, field: string): void {
  if (SENSITIVE_NAME.test(name)) {
    throw new ValidationError([{ field, code: 'sensitive_field' }]);
  }
}

function assertSafeTree(value: unknown, field: string, depth = 0): void {
  if (depth > 5) throw new ValidationError([{ field, code: 'maximum_depth' }]);
  if (typeof value === 'string') {
    if (value.length > BROWSER_COMMAND_PAYLOAD_BYTES_LIMIT) {
      throw new ValidationError([{ field, code: 'maximum_exceeded' }]);
    }
    if (SENSITIVE_TEXT.test(value)) {
      throw new ValidationError([{ field, code: 'sensitive_value' }]);
    }
    return;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    if (value.length > 100) throw new ValidationError([{ field, code: 'maximum_exceeded' }]);
    value.forEach((item, index) => assertSafeTree(item, `${field}[${index}]`, depth + 1));
    return;
  }
  if (!isObject(value)) throw new ValidationError([{ field, code: 'json_required' }]);
  for (const [name, child] of Object.entries(value)) {
    assertSafeName(name, `${field}.${name}`);
    assertSafeTree(child, `${field}.${name}`, depth + 1);
  }
}

function safePayload(value: unknown, type: BrowserCommandType): BrowserCommandJsonObject {
  if (value === undefined) return {};
  if (!isObject(value)) throw new ValidationError([{ field: 'payload', code: 'object_required' }]);
  assertSafeTree(value, 'payload');
  if (type === 'LOGIN' && Object.keys(value).length > 0) {
    throw new ValidationError([{ field: 'payload', code: 'not_allowed_for_type' }]);
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > BROWSER_COMMAND_PAYLOAD_BYTES_LIMIT) {
    throw new ValidationError([{ field: 'payload', code: 'maximum_exceeded' }]);
  }
  return cloneJsonObject(value);
}

function normalizeCreate(input: BrowserCommandCreateInput): NewBrowserCommand {
  if (!BROWSER_COMMAND_TYPES.includes(input.type)) {
    throw new ValidationError([{ field: 'type', code: 'invalid_enum' }]);
  }
  assertUuid(input.requestedBy, 'requestedBy');
  if (input.id !== undefined) assertUuid(input.id, 'id');

  const platformAccountId = input.platformAccountId ?? null;
  if (platformAccountId !== null) assertUuid(platformAccountId, 'platformAccountId');
  if (input.type !== 'EXPORT_REPORT' && platformAccountId === null) {
    throw new ValidationError([{ field: 'platformAccountId', code: 'required' }]);
  }

  const clientBatchId = input.clientBatchId ?? null;
  if (clientBatchId !== null) assertNonEmptyString(clientBatchId, 'clientBatchId', 200);
  const payload = safePayload(input.payload, input.type);
  const expiresAt = input.expiresAt ?? new Date(Date.now() + BROWSER_COMMAND_PENDING_TTL_MS);
  if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())) {
    throw new ValidationError([{ field: 'expiresAt', code: 'datetime_required' }]);
  }

  return {
    id: input.id,
    type: input.type,
    platformAccountId,
    clientBatchId,
    requestedBy: input.requestedBy,
    payload,
    expiresAt: new Date(expiresAt),
  };
}

function resultStatus(value: unknown): BrowserCommandResultStatus {
  if (typeof value !== 'string' || !BROWSER_COMMAND_RESULT_STATUSES.includes(value as BrowserCommandResultStatus)) {
    throw new ValidationError([{ field: 'status', code: 'invalid_enum' }]);
  }
  return value as BrowserCommandResultStatus;
}

function resultCode(value: unknown, status: BrowserCommandResultStatus): string {
  if (value === undefined || value === null || value === '') {
    if (status === 'succeeded') return 'SUCCESS';
    throw new ValidationError([{ field: 'resultCode', code: 'required' }]);
  }
  if (typeof value !== 'string' || !SAFE_RESULT_CODE.test(value)) {
    throw new ValidationError([{ field: 'resultCode', code: 'invalid' }]);
  }
  return value;
}

function resultSummary(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ValidationError([{ field: 'resultSummary', code: 'string_required' }]);
  if (value.length > BROWSER_COMMAND_RESULT_SUMMARY_LIMIT) {
    throw new ValidationError([{ field: 'resultSummary', code: 'maximum_exceeded' }]);
  }
  if (SENSITIVE_TEXT.test(value)) {
    throw new ValidationError([{ field: 'resultSummary', code: 'sensitive_value' }]);
  }
  return value;
}

function resultProgress(value: unknown): BrowserCommandProgress {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
      throw new ValidationError([{ field: 'progress', code: 'range_invalid' }]);
    }
    return value;
  }
  if (!isObject(value)) throw new ValidationError([{ field: 'progress', code: 'object_required' }]);
  assertSafeTree(value, 'progress');
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > BROWSER_COMMAND_PROGRESS_BYTES_LIMIT) {
    throw new ValidationError([{ field: 'progress', code: 'maximum_exceeded' }]);
  }
  return cloneJsonObject(value);
}

function normalizeResult(input: BrowserCommandResultRequest): BrowserCommandResultInput & {
  deviceId: string;
  claimToken: string;
} {
  assertNonEmptyString(input.deviceId, 'deviceId', 200);
  assertNonEmptyString(input.claimToken, 'claimToken', 512);
  const status = resultStatus(input.status);
  return {
    deviceId: input.deviceId,
    claimToken: input.claimToken,
    status,
    resultCode: resultCode(input.resultCode, status),
    resultSummary: resultSummary(input.resultSummary),
    progress: resultProgress(input.progress),
  };
}

function isTerminalStatus(status: BrowserCommandStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function publicBrowserCommand(command: BrowserCommandRecord) {
  return {
    id: command.id,
    type: command.type,
    status: command.status,
    platformAccountId: command.platformAccountId,
    clientBatchId: command.clientBatchId,
    requestedBy: command.requestedBy,
    payload: cloneJsonObject(command.payload),
    resultCode: command.resultCode,
    resultSummary: command.resultSummary,
    progress: cloneProgress(command.progress),
    createdAt: command.createdAt.toISOString(),
    updatedAt: command.updatedAt.toISOString(),
    expiresAt: command.expiresAt.toISOString(),
  };
}

export function encodeBrowserCommandCursor(cursor: { createdAt: Date; id: string }): string {
  assertUuid(cursor.id, 'cursor.id');
  if (!(cursor.createdAt instanceof Date) || !Number.isFinite(cursor.createdAt.getTime())) {
    throw new ValidationError([{ field: 'cursor', code: 'invalid' }]);
  }
  return Buffer.from(JSON.stringify({
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  }), 'utf8').toString('base64url');
}

export function decodeBrowserCommandCursor(value: string): { createdAt: Date; id: string } {
  try {
    if (typeof value !== 'string' || value.trim() === '') throw new Error('empty cursor');
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== 'string' || !isBrowserCommandUuid(parsed.id)) throw new Error('invalid cursor');
    const createdAt = new Date(parsed.createdAt);
    if (!Number.isFinite(createdAt.getTime())) throw new Error('invalid cursor');
    return { createdAt, id: parsed.id };
  } catch {
    throw new ValidationError([{ field: 'cursor', code: 'invalid' }]);
  }
}

export class BrowserCommandService {
  public readonly repository: BrowserCommandRepository;
  private readonly now: () => Date;

  constructor(repository: BrowserCommandRepository, options: BrowserCommandServiceOptions = {}) {
    this.repository = repository;
    this.now = options.now ?? (() => new Date());
  }

  async create(input: BrowserCommandCreateInput): Promise<BrowserCommandRecord> {
    const now = this.now();
    const normalized = normalizeCreate({
      ...input,
      expiresAt: input.expiresAt ?? new Date(now.getTime() + BROWSER_COMMAND_PENDING_TTL_MS),
    });
    await this.repository.expireStale(now);
    if (normalized.platformAccountId !== null) {
      const duplicate = await this.repository.findActiveForAccount(normalized.platformAccountId, now);
      if (duplicate) throw new ConflictError('Browser command already pending', 'DUPLICATE_PENDING');
    }
    try {
      return await this.repository.create(normalized);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('Browser command already pending', 'DUPLICATE_PENDING');
      }
      throw error;
    }
  }

  async get(id: string, requestedBy?: string): Promise<BrowserCommandRecord> {
    assertUuid(id, 'id');
    if (requestedBy !== undefined) assertUuid(requestedBy, 'requestedBy');
    await this.repository.expireStale(this.now());
    const command = await this.repository.get(id);
    if (!command || (requestedBy !== undefined && command.requestedBy !== requestedBy)) {
      throw new NotFoundError('Browser command not found');
    }
    return command;
  }

  async list(options: BrowserCommandListOptions): Promise<{
    items: BrowserCommandRecord[];
    nextCursor: { createdAt: Date; id: string } | null;
  }> {
    await this.repository.expireStale(this.now());
    return this.repository.list(options);
  }

  async claim(id: string, deviceId: string): Promise<BrowserCommandClaimResult> {
    assertUuid(id, 'id');
    assertNonEmptyString(deviceId, 'deviceId', 200);
    const now = this.now();
    await this.repository.expireStale(now);
    const current = await this.repository.get(id);
    if (!current) throw new NotFoundError('Browser command not found');
    if (current.status === 'executing') {
      if (current.claimedBy === deviceId) return { command: current, claimToken: null };
      throw new ConflictError('Browser command already claimed', 'ALREADY_CLAIMED');
    }
    if (isTerminalStatus(current.status)) return { command: current, claimToken: null };

    const claimToken = newOpaqueToken();
    const claimed = await this.repository.claim(
      id,
      deviceId,
      hashToken(claimToken),
      now,
      new Date(now.getTime() + BROWSER_COMMAND_LEASE_TTL_MS),
    );
    if (claimed) return { command: claimed, claimToken };

    const afterRace = await this.repository.get(id);
    if (!afterRace) throw new NotFoundError('Browser command not found');
    if (afterRace.status === 'executing' && afterRace.claimedBy === deviceId) {
      return { command: afterRace, claimToken: null };
    }
    if (afterRace.status === 'executing') {
      throw new ConflictError('Browser command already claimed', 'ALREADY_CLAIMED');
    }
    return { command: afterRace, claimToken: null };
  }

  async writeResult(id: string, input: BrowserCommandResultRequest): Promise<BrowserCommandRecord> {
    assertUuid(id, 'id');
    const normalized = normalizeResult(input);
    const now = this.now();
    await this.repository.expireStale(now);
    const current = await this.repository.get(id);
    if (!current) throw new NotFoundError('Browser command not found');
    const claimHash = hashToken(normalized.claimToken);

    if (isTerminalStatus(current.status)) {
      if (current.claimedBy !== normalized.deviceId || current.claimTokenHash !== claimHash) {
        throw new ForbiddenError('Browser command claimed by another session');
      }
      return current;
    }
    if (current.status !== 'executing') {
      throw new ConflictError('Browser command is not claimed', 'NOT_CLAIMED');
    }
    if (current.claimedBy !== normalized.deviceId || current.claimTokenHash !== claimHash) {
      throw new ForbiddenError('Browser command claimed by another session');
    }

    const completed = await this.repository.writeResult(id, normalized.deviceId, claimHash, {
      status: normalized.status,
      resultCode: normalized.resultCode,
      resultSummary: normalized.resultSummary,
      progress: normalized.progress,
    }, now);
    if (completed) return completed;
    const afterRace = await this.repository.get(id);
    if (!afterRace) throw new NotFoundError('Browser command not found');
    if (isTerminalStatus(afterRace.status)
      && afterRace.claimedBy === normalized.deviceId
      && afterRace.claimTokenHash === claimHash) return afterRace;
    throw new ForbiddenError('Browser command claimed by another session');
  }

  async complete(id: string, input: BrowserCommandResultRequest): Promise<BrowserCommandRecord> {
    return this.writeResult(id, input);
  }

  async cancel(id: string, requestedBy: string): Promise<BrowserCommandRecord> {
    assertUuid(id, 'id');
    assertUuid(requestedBy, 'requestedBy');
    const now = this.now();
    await this.repository.expireStale(now);
    const current = await this.repository.get(id);
    if (!current || current.requestedBy !== requestedBy) {
      throw new NotFoundError('Browser command not found');
    }
    if (isTerminalStatus(current.status)) return current;
    const cancelled = await this.repository.cancel(id, requestedBy, now);
    if (cancelled) return cancelled;
    const afterRace = await this.repository.get(id);
    if (!afterRace || afterRace.requestedBy !== requestedBy) {
      throw new NotFoundError('Browser command not found');
    }
    return afterRace;
  }
}
