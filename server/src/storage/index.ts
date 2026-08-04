import type { ServerConfig } from '../config.ts';
import { CloudStorageBackend } from './cloud.ts';
import { LocalFileStorageBackend } from './local.ts';
import { MemoryStorageBackend } from './memory.ts';
import type { StorageBackend } from './types.ts';

export * from './types.ts';
export * from './memory.ts';
export * from './local.ts';
export * from './cloud.ts';

export function createStorageBackend(config: Pick<ServerConfig, 'objectStorage'>): StorageBackend {
  if (config.objectStorage.localDir) {
    return new LocalFileStorageBackend(config.objectStorage.localDir);
  }
  return new CloudStorageBackend(config.objectStorage);
}

export { MemoryStorageBackend };
