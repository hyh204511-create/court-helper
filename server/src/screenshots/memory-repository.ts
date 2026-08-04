import { randomUUID } from 'node:crypto';

import type {
  NewScreenshot,
  ScreenshotRecord,
  ScreenshotRepository,
  ScreenshotType,
  ScreenshotUpdate,
} from './types.ts';

function uniqueViolation(): Error & { code: string } {
  const error = new Error('unique constraint violation') as Error & { code: string };
  error.code = '23505';
  return error;
}

function copy(value: ScreenshotRecord): ScreenshotRecord {
  return {
    ...value,
    capturedAt: new Date(value.capturedAt),
    createdAt: new Date(value.createdAt),
  };
}

export class MemoryScreenshotRepository implements ScreenshotRepository {
  private readonly screenshots = new Map<string, ScreenshotRecord>();

  constructor(values: ScreenshotRecord[] = []) {
    for (const value of values) this.screenshots.set(value.id, copy(value));
  }

  async findById(id: string): Promise<ScreenshotRecord | null> {
    const value = this.screenshots.get(id);
    return value ? copy(value) : null;
  }

  async findByCaseIdAndType(caseId: string, type: ScreenshotType): Promise<ScreenshotRecord | null> {
    const value = [...this.screenshots.values()].find(
      (candidate) => candidate.caseId === caseId && candidate.type === type,
    );
    return value ? copy(value) : null;
  }

  async listByCaseId(caseId: string): Promise<ScreenshotRecord[]> {
    return [...this.screenshots.values()]
      .filter((value) => value.caseId === caseId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
      .map(copy);
  }

  async create(input: NewScreenshot): Promise<ScreenshotRecord> {
    const id = input.id ?? randomUUID();
    if (this.screenshots.has(id)) throw uniqueViolation();
    if ([...this.screenshots.values()].some(
      (value) => value.caseId === input.caseId && value.type === input.type,
    )) throw uniqueViolation();
    if ([...this.screenshots.values()].some((value) => value.objectKey === input.objectKey)) {
      throw uniqueViolation();
    }
    const value: ScreenshotRecord = {
      id,
      caseId: input.caseId,
      type: input.type,
      objectKey: input.objectKey,
      contentType: input.contentType,
      byteSize: input.byteSize,
      sha256: input.sha256,
      capturedAt: new Date(input.capturedAt),
      createdAt: new Date(),
    };
    this.screenshots.set(id, value);
    return copy(value);
  }

  async update(id: string, input: ScreenshotUpdate): Promise<ScreenshotRecord | null> {
    const current = this.screenshots.get(id);
    if (!current) return null;
    const duplicateKey = [...this.screenshots.values()].some(
      (value) => value.id !== id && value.objectKey === input.objectKey,
    );
    if (duplicateKey) throw uniqueViolation();
    const value: ScreenshotRecord = {
      ...current,
      objectKey: input.objectKey,
      contentType: input.contentType,
      byteSize: input.byteSize,
      sha256: input.sha256,
      capturedAt: new Date(input.capturedAt),
    };
    this.screenshots.set(id, value);
    return copy(value);
  }

  async delete(id: string): Promise<void> {
    this.screenshots.delete(id);
  }
}
