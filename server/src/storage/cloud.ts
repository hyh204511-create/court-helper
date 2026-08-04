import { DependencyUnavailableError } from '../errors.ts';
import type { ObjectStorageConfig, StorageBackend } from './types.ts';

function unavailable(): never {
  throw new DependencyUnavailableError('Object storage unavailable');
}

/**
 * Deployment-time COS/OSS adapter seam. The provider SDK and signing policy
 * intentionally remain outside this phase; production must not fall back to
 * public URLs or an unauthenticated bucket.
 */
export class CloudStorageBackend implements StorageBackend {
  public readonly config: ObjectStorageConfig;

  constructor(config: ObjectStorageConfig) {
    this.config = config;
  }

  async put(_key: string, _buffer: Buffer, _contentType: string): Promise<void> {
    return unavailable();
  }

  async get(_key: string) {
    return unavailable();
  }

  async delete(_key: string): Promise<void> {
    return unavailable();
  }

  async check(): Promise<boolean> {
    return false;
  }

  async exists(_key: string): Promise<boolean> {
    return unavailable();
  }
}
