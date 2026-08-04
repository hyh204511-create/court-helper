import { Readable } from 'node:stream';

import type { StorageBackend } from './types.ts';

interface MemoryObject {
  buffer: Buffer;
  contentType: string;
}

export class MemoryStorageBackend implements StorageBackend {
  private readonly objects = new Map<string, MemoryObject>();

  async put(key: string, buffer: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, {
      buffer: Buffer.from(buffer),
      contentType,
    });
  }

  async get(key: string): Promise<Readable | null> {
    const value = this.objects.get(key);
    return value ? Readable.from(Buffer.from(value.buffer)) : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async check(): Promise<boolean> {
    return true;
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}
