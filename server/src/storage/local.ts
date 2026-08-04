import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import type { Readable } from 'node:stream';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { StorageBackend } from './types.ts';

function isMissing(error: unknown): boolean {
  return (error as { code?: string })?.code === 'ENOENT';
}

export class LocalFileStorageBackend implements StorageBackend {
  public readonly publicRead = false;
  private readonly root: string;

  constructor(directory: string) {
    if (directory.trim() === '') throw new Error('Local storage directory is required');
    this.root = resolve(directory);
  }

  private pathFor(key: string): string {
    if (key.trim() === '' || key.includes('\0') || isAbsolute(key)) {
      throw new Error('Invalid storage key');
    }
    const candidate = resolve(this.root, key);
    const outside = relative(this.root, candidate);
    if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)) {
      throw new Error('Invalid storage key');
    }
    return candidate;
  }

  async put(key: string, buffer: Buffer, _contentType: string): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, buffer, { flag: 'wx' });
      await rename(temporary, target);
    } catch (error) {
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if (!isMissing(cleanupError)) throw cleanupError;
      }
      throw error;
    }
  }

  async get(key: string): Promise<Readable | null> {
    const target = this.pathFor(key);
    try {
      await access(target, constants.R_OK);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    return createReadStream(target);
  }

  async delete(key: string): Promise<void> {
    const target = this.pathFor(key);
    try {
      await unlink(target);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async check(): Promise<boolean> {
    try {
      await mkdir(this.root, { recursive: true });
      await access(this.root, constants.R_OK | constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  async exists(key: string): Promise<boolean> {
    const target = this.pathFor(key);
    try {
      await access(target, constants.F_OK);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
}

export { LocalFileStorageBackend as LocalStorageBackend };
export { LocalFileStorageBackend as FileStorageBackend };
