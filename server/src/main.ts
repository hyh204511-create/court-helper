import { Pool } from 'pg';

import { buildApp, loadConfig } from './app.ts';
import { PgAuthRepository } from './auth/repository.ts';
import { PgPlatformAccountRepository } from './platform-accounts/repository.ts';
import { PgCaseRepository } from './cases/repository.ts';
import { PgScreenshotRepository } from './screenshots/repository.ts';
import { createStorageBackend } from './storage/index.ts';
import { createPostgresHealthDependency } from './health.ts';
import { runMigrations } from './db/migrator.ts';

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const storageBackend = createStorageBackend(config);
const app = buildApp({
  config,
  authRepository: new PgAuthRepository(pool),
  platformAccountRepository: new PgPlatformAccountRepository(pool),
  caseRepository: new PgCaseRepository(pool),
  screenshotRepository: new PgScreenshotRepository(pool),
  storageBackend,
  dependencies: {
    database: createPostgresHealthDependency(pool),
    objectStorage: storageBackend,
  },
});

const shutdown = async () => {
  await app.close();
  await pool.end();
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

let migrationsReady = false;
try {
  await runMigrations(pool);
  migrationsReady = true;
} catch {
  console.error(
    'Database migration failed before server startup. Check DATABASE_URL, database reachability, credentials, and migration permissions.',
  );
  try {
    await pool.end();
  } catch {
    // Preserve the actionable migration failure message.
  }
  process.exitCode = 1;
}

if (migrationsReady) {
  await app.listen({ host: '127.0.0.1', port: config.port });
}
