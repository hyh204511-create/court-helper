import type { Readable } from 'node:stream';

export interface StorageBackend {
  put(key: string, buffer: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Readable | null>;
  delete(key: string): Promise<void>;
  check(): Promise<boolean>;
  exists(key: string): Promise<boolean>;
}

export interface ObjectStorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId?: string;
  accessKeySecret?: string;
  localDir?: string;
}
