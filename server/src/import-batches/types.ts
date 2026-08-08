export const IMPORT_BATCH_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;

export interface ImportBatchRecord {
  id: string;
  fileName: string;
  objectKey: string;
  contentType: typeof IMPORT_BATCH_CONTENT_TYPE;
  byteSize: number;
  sha256: string;
  liRows: number;
  qzRows: number;
  skippedRows: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface NewImportBatch {
  id: string;
  fileName: string;
  objectKey: string;
  contentType: typeof IMPORT_BATCH_CONTENT_TYPE;
  byteSize: number;
  sha256: string;
  liRows: number;
  qzRows: number;
  skippedRows: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface ImportBatchCursor {
  createdAt: Date;
  id: string;
}

export interface ImportBatchListOptions {
  limit: number;
  cursor?: ImportBatchCursor;
}

export interface ImportBatchPage {
  items: ImportBatchRecord[];
  nextCursor: ImportBatchCursor | null;
}

export interface ImportBatchRepository {
  findById(id: string): Promise<ImportBatchRecord | null>;
  list(options: ImportBatchListOptions): Promise<ImportBatchPage>;
  create(input: NewImportBatch): Promise<ImportBatchRecord>;
  delete(id: string): Promise<void>;
}

export interface ImportBatchAccess {
  userId: string;
  role: 'admin' | 'user' | 'extension';
}
