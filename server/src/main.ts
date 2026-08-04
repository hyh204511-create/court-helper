import { Pool } from 'pg';

import { buildApp, loadConfig } from './app.ts';
import { PgAuthRepository } from './auth/repository.ts';
import { PgPlatformAccountRepository } from './platform-accounts/repository.ts';
import { PgCaseRepository } from './cases/repository.ts';
import {
  createObjectStorageHealthDependency,
  createPostgresHealthDependency,
} from './health.ts';

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const app = buildApp({
  config,
  authRepository: new PgAuthRepository(pool),
  platformAccountRepository: new PgPlatformAccountRepository(pool),
  caseRepository: new PgCaseRepository(pool),
  dependencies: {
    database: createPostgresHealthDependency(pool),
    objectStorage: createObjectStorageHealthDependency(config),
  },
});

const shutdown = async () => {
  await app.close();
  await pool.end();
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await app.listen({ host: '127.0.0.1', port: config.port });
