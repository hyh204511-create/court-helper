import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MigrationQueryResult {
  rows: Array<Record<string, unknown>>;
}

export interface MigrationExecutor {
  query(sql: string, values?: unknown[]): Promise<MigrationQueryResult>;
}

export interface MigrationFile {
  version: string;
  upPath: string;
  downPath: string;
}

const defaultMigrationsDirectory = fileURLToPath(
  new URL('../../migrations/', import.meta.url),
);

export async function listMigrations(
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const versions = new Map<string, { upPath?: string; downPath?: string }>();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^(\d+_[a-z0-9_-]+)\.(up|down)\.sql$/.exec(entry.name);
    if (!match) continue;
    const [, version, direction] = match;
    const current = versions.get(version) ?? {};
    current[direction === 'up' ? 'upPath' : 'downPath'] = join(migrationsDirectory, entry.name);
    versions.set(version, current);
  }

  const migrations: MigrationFile[] = [];
  for (const [version, paths] of [...versions.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!paths.upPath || !paths.downPath) {
      throw new Error(`Migration ${version} must have both up and down SQL`);
    }
    migrations.push({ version, upPath: paths.upPath, downPath: paths.downPath });
  }
  return migrations;
}

async function migrationSql(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

async function ensureMigrationTable(database: MigrationExecutor): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT,
      applied_at TIMESTAMPTZ
    )
  `);
}

async function rollbackTransaction(database: MigrationExecutor): Promise<void> {
  try {
    await database.query('ROLLBACK');
  } catch {
    // Preserve the original migration error; a failed rollback is still surfaced by it.
  }
}

export async function runMigrations(
  database: MigrationExecutor,
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<string[]> {
  await ensureMigrationTable(database);
  const migrations = await listMigrations(migrationsDirectory);
  const appliedResult = await database.query('SELECT version FROM schema_migrations');
  const applied = new Set(appliedResult.rows.map((row) => String(row.version)));
  const newlyApplied: string[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    await database.query('BEGIN');
    try {
      await database.query(await migrationSql(migration.upPath));
      await database.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW())',
        [migration.version],
      );
      await database.query('COMMIT');
      newlyApplied.push(migration.version);
    } catch (error) {
      await rollbackTransaction(database);
      throw error;
    }
  }
  return newlyApplied;
}

export async function rollbackLastMigration(
  database: MigrationExecutor,
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<string | null> {
  await ensureMigrationTable(database);
  const result = await database.query(
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
  );
  if (result.rows.length === 0) return null;

  const version = String(result.rows[0].version);
  const migration = (await listMigrations(migrationsDirectory))
    .find((candidate) => candidate.version === version);
  if (!migration) {
    throw new Error(`Migration ${version} is not available locally`);
  }

  await database.query('BEGIN');
  try {
    await database.query(await migrationSql(migration.downPath));
    await database.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
    await database.query('COMMIT');
    return version;
  } catch (error) {
    await rollbackTransaction(database);
    throw error;
  }
}

export function migrationVersionFromPath(path: string): string {
  return basename(path).replace(/\.(up|down)\.sql$/, '');
}
