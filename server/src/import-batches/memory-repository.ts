import type {
  ImportBatchListOptions,
  ImportBatchPage,
  ImportBatchRecord,
  ImportBatchRepository,
  NewImportBatch,
} from './types.ts';

function uniqueViolation(): Error & { code: string } {
  const error = new Error('unique constraint violation') as Error & { code: string };
  error.code = '23505';
  return error;
}

function copy(value: ImportBatchRecord): ImportBatchRecord {
  return {
    ...value,
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
    expiresAt: new Date(value.expiresAt),
  };
}

export class MemoryImportBatchRepository implements ImportBatchRepository {
  private readonly importBatches = new Map<string, ImportBatchRecord>();

  constructor(values: ImportBatchRecord[] = []) {
    for (const value of values) this.importBatches.set(value.id, copy(value));
  }

  async findById(id: string): Promise<ImportBatchRecord | null> {
    const value = this.importBatches.get(id);
    return value ? copy(value) : null;
  }

  async list(options: ImportBatchListOptions): Promise<ImportBatchPage> {
    const values = [...this.importBatches.values()]
      .filter((value) => {
        if (options.cursor === undefined) return true;
        const valueTime = value.createdAt.getTime();
        const cursorTime = options.cursor.createdAt.getTime();
        return valueTime < cursorTime
          || (valueTime === cursorTime && value.id.localeCompare(options.cursor.id) < 0);
      })
      .sort((left, right) => (
        right.createdAt.getTime() - left.createdAt.getTime()
        || right.id.localeCompare(left.id)
      ));
    const items = values.slice(0, options.limit);
    const last = items[items.length - 1];
    return {
      items: items.map(copy),
      nextCursor: values.length > options.limit && last
        ? { createdAt: new Date(last.createdAt), id: last.id }
        : null,
    };
  }

  async create(input: NewImportBatch): Promise<ImportBatchRecord> {
    if (this.importBatches.has(input.id)) throw uniqueViolation();
    if ([...this.importBatches.values()].some((value) => value.objectKey === input.objectKey)) {
      throw uniqueViolation();
    }
    const value: ImportBatchRecord = copy(input);
    this.importBatches.set(value.id, value);
    return copy(value);
  }

  async delete(id: string): Promise<void> {
    this.importBatches.delete(id);
  }
}
