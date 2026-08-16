import { Pool } from 'pg';

import { buildApp, loadConfig } from './app.ts';
import { PgAuthRepository } from './auth/repository.ts';
import { PgPlatformAccountRepository } from './platform-accounts/repository.ts';
import { PgLoginCommandRepository } from './login-commands/repository.ts';
import { PgBrowserCommandRepository } from './browser-commands/repository.ts';
import { PgCaseRepository } from './cases/repository.ts';
import { PgScreenshotRepository } from './screenshots/repository.ts';
import { PgReportExportRepository } from './report-exports/repository.ts';
import { PgImportBatchRepository } from './import-batches/repository.ts';
import { createStorageBackend } from './storage/index.ts';
import { createPostgresHealthDependency } from './health.ts';
import { runMigrations } from './db/migrator.ts';
import { createLocalLoginHelper } from './local-login-helper.ts';
import { startBoundBackend } from './backend-startup.ts';
import { PgWecomNotificationRepository } from './wecom-notifications/repository.ts';
import { PgUserWecomWebhookRepository } from './user-wecom-webhooks/repository.ts';

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const storageBackend = createStorageBackend(config);
const localLoginHelper = config.localLoginHelper.autoStart
  ? createLocalLoginHelper(config.localLoginHelper.command ? { command: config.localLoginHelper.command } : {})
  : undefined;
const app = buildApp({
  config,
  unexpectedErrorLogger: {
    error(details) {
      console.error(JSON.stringify(details));
    },
  },
  authRepository: new PgAuthRepository(pool),
  platformAccountRepository: new PgPlatformAccountRepository(pool),
  loginCommandRepository: new PgLoginCommandRepository(pool),
  browserCommandRepository: new PgBrowserCommandRepository(pool),
  caseRepository: new PgCaseRepository(pool),
  screenshotRepository: new PgScreenshotRepository(pool),
  reportExportRepository: new PgReportExportRepository(pool),
  importBatchRepository: new PgImportBatchRepository(pool),
  storageBackend,
  localLoginHelper,
  wecomNotificationRepository: new PgWecomNotificationRepository(pool),
  userWecomWebhookRepository: new PgUserWecomWebhookRepository(pool),
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

try {
  await startBoundBackend({
    migrate: async () => {
      await runMigrations(pool);
    },
    listen: async () => {
      await app.listen({ host: '127.0.0.1', port: config.port });
    },
    helper: localLoginHelper,
  });
} catch {
  console.error(
    'Backend startup failed. Check database configuration, reachability, migration permissions, and port availability.',
  );
  try {
    await pool.end();
  } catch {
    // Preserve the actionable startup failure message.
  }
  process.exitCode = 1;
}
