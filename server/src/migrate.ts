import { Pool } from 'pg';

import { runMigrations } from './db/migrator.ts';

function databaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error('DATABASE_URL is required');
  return value;
}

async function main(): Promise<void> {
  let pool: Pool | undefined;
  try {
    pool = new Pool({ connectionString: databaseUrl() });
    const applied = await runMigrations(pool);
    console.log(applied.length > 0 ? `Applied migrations: ${applied.join(', ')}` : 'No pending migrations.');
  } catch {
    console.error(
      'Database migration failed. Check DATABASE_URL, database reachability, credentials, and migration permissions.',
    );
    process.exitCode = 1;
  } finally {
    try {
      await pool?.end();
    } catch {
      // Preserve the migration failure status.
    }
  }
}

await main();
