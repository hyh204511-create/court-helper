import { randomUUID } from 'node:crypto';

import {
  AppError,
  DependencyUnavailableError,
  NotFoundError,
  ValidationError,
} from '../errors.ts';
import { ownerIdFor, type CaseAccess, type CaseRepository } from '../cases/types.ts';
import { isBeforeRetentionCutoff, retentionCutoff, type Clock } from '../retention/policy.ts';
import type { StorageBackend } from '../storage/types.ts';
import type {
  NewScreenshot,
  ScreenshotContentType,
  ScreenshotRecord,
  ScreenshotRepository,
  ScreenshotType,
  ScreenshotUpdate,
} from './types.ts';

export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

export interface ScreenshotUploadInput {
  caseId: string;
  eventId: string;
  type: ScreenshotType;
  capturedAt: Date;
  sha256: string;
  contentType: ScreenshotContentType;
  buffer: Buffer;
}

export interface ScreenshotUploadResult {
  screenshot: ScreenshotRecord;
  created: boolean;
}

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function detectScreenshotContentType(buffer: Buffer): ScreenshotContentType | null {
  if (buffer.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return 'image/jpeg';
  if (buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'image/png';
  return null;
}

export function validateScreenshotContentType(
  buffer: Buffer,
  declaredContentType: ScreenshotContentType,
): ScreenshotContentType {
  const detectedContentType = detectScreenshotContentType(buffer);
  if (detectedContentType === null) {
    throw new ValidationError([{ field: 'file', code: 'magic_not_allowed' }]);
  }
  if (detectedContentType !== declaredContentType) {
    throw new ValidationError([{ field: 'file', code: 'mime_mismatch' }]);
  }
  return detectedContentType;
}

async function storageCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new DependencyUnavailableError();
  }
}

function extension(contentType: ScreenshotContentType): string {
  return contentType === 'image/png' ? 'png' : 'jpg';
}

function objectKey(caseId: string, contentType: ScreenshotContentType): string {
  return `screenshots/${caseId}/${randomUUID()}.${extension(contentType)}`;
}

export function publicScreenshot(value: ScreenshotRecord, prefix = '') {
  return {
    id: value.id,
    type: value.type,
    contentType: value.contentType,
    byteSize: value.byteSize,
    capturedAt: value.capturedAt.toISOString(),
    contentUrl: `${prefix}/screenshots/${value.id}/content`,
  };
}

export class ScreenshotService {
  public readonly repository: ScreenshotRepository;
  private readonly cases: CaseRepository;
  private readonly storage: StorageBackend;
  private readonly clock: Clock;

  constructor(
    repository: ScreenshotRepository,
    cases: CaseRepository,
    storage: StorageBackend,
    clock: Clock = () => new Date(),
  ) {
    this.repository = repository;
    this.cases = cases;
    this.storage = storage;
    this.clock = clock;
  }

  private async ensureCase(caseId: string, access: CaseAccess) {
    const caseValue = await this.cases.findById(caseId, ownerIdFor(access));
    if (!caseValue) {
      throw new NotFoundError('Case not found');
    }
    return caseValue;
  }

  async upload(input: ScreenshotUploadInput, access: CaseAccess): Promise<ScreenshotUploadResult> {
    const contentType = validateScreenshotContentType(input.buffer, input.contentType);
    const caseValue = await this.ensureCase(input.caseId, access);
    const cutoff = retentionCutoff(new Date(this.clock()));
    if (
      isBeforeRetentionCutoff(input.capturedAt, cutoff)
      || isBeforeRetentionCutoff(caseValue.queryTime, cutoff)
    ) {
      throw new ValidationError([{ field: 'capturedAt', code: 'retention_expired' }]);
    }
    const current = await this.repository.findByCaseIdAndType(input.caseId, input.type);
    const normalizedHash = input.sha256.toLowerCase();

    if (current && current.sha256.toLowerCase() === normalizedHash) {
      const objectStillExists = await storageCall(() => this.storage.exists(current.objectKey));
      if (objectStillExists) return { screenshot: current, created: false };
    }

    const newObjectKey = objectKey(input.caseId, contentType);
    await storageCall(() => this.storage.put(newObjectKey, input.buffer, contentType));

    let screenshot: ScreenshotRecord | null;
    try {
      if (current) {
        const update: ScreenshotUpdate = {
          objectKey: newObjectKey,
          contentType,
          byteSize: input.buffer.length,
          sha256: normalizedHash,
          capturedAt: input.capturedAt,
        };
        screenshot = await this.repository.update(current.id, update);
      } else {
        const create: NewScreenshot = {
          caseId: input.caseId,
          type: input.type,
          objectKey: newObjectKey,
          contentType,
          byteSize: input.buffer.length,
          sha256: normalizedHash,
          capturedAt: input.capturedAt,
        };
        screenshot = await this.repository.create(create);
      }
    } catch (error) {
      await storageCall(() => this.storage.delete(newObjectKey));
      throw error;
    }

    if (!screenshot) {
      await storageCall(() => this.storage.delete(newObjectKey));
      throw new NotFoundError('Screenshot not found');
    }

    if (current && current.objectKey !== screenshot.objectKey) {
      await storageCall(() => this.storage.delete(current.objectKey));
    }
    return { screenshot, created: current === null };
  }

  async listForCase(caseId: string, access: CaseAccess): Promise<ScreenshotRecord[]> {
    await this.ensureCase(caseId, access);
    return this.repository.listByCaseId(caseId);
  }

  async get(id: string, access: CaseAccess): Promise<ScreenshotRecord> {
    const screenshot = await this.repository.findById(id);
    if (!screenshot) throw new NotFoundError('Screenshot not found');
    await this.ensureCase(screenshot.caseId, access);
    return screenshot;
  }

  async content(id: string, access: CaseAccess): Promise<{ screenshot: ScreenshotRecord; stream: NodeJS.ReadableStream }> {
    const screenshot = await this.get(id, access);
    const stream = await storageCall(() => this.storage.get(screenshot.objectKey));
    if (!stream) throw new NotFoundError('Screenshot not found');
    return { screenshot, stream };
  }
}
