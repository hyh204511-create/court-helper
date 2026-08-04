import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { ServerConfig } from './config.ts';

export interface HealthDependency {
  check(): Promise<boolean>;
}

export interface HealthDependencies {
  database: HealthDependency;
  objectStorage: HealthDependency;
}

export const unavailableDependency: HealthDependency = {
  async check() {
    return false;
  },
};

async function isAvailable(dependency: HealthDependency): Promise<boolean> {
  try {
    return await dependency.check();
  } catch {
    return false;
  }
}

export function createPostgresHealthDependency(pool: Pick<Pool, 'query'>): HealthDependency {
  return {
    async check() {
      await pool.query('SELECT 1');
      return true;
    },
  };
}

export function createObjectStorageHealthDependency(config: ServerConfig): HealthDependency {
  return {
    async check() {
      try {
        const response = await fetch(
          `${config.objectStorage.endpoint}/${encodeURIComponent(config.objectStorage.bucket)}`,
          { method: 'HEAD' },
        );
        // A private bucket commonly answers 401/403 without credentials. That still
        // proves the object-storage service is reachable; 5xx and transport errors do not.
        return response.status < 500;
      } catch {
        return false;
      }
    },
  };
}

export function registerHealthRoutes(
  app: FastifyInstance,
  prefix: string,
  dependencies: HealthDependencies,
): void {
  app.get(`${prefix}/health`, async (_request, reply) => {
    const [database, objectStorage] = await Promise.all([
      isAvailable(dependencies.database),
      isAvailable(dependencies.objectStorage),
    ]);

    if (database && objectStorage) {
      return { ok: true };
    }

    reply.code(503);
    return { ok: false };
  });
}
