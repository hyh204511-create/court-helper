import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { newDb } from 'pg-mem';

import { runMigrations, rollbackLastMigration } from '../src/db/migrator.ts';

async function database() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();
  return { db, pool };
}

async function close(pool) {
  await pool.end();
}

async function tableNames(pool) {
  const result = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
  `);
  return new Set(result.rows.map((row) => row.table_name));
}

async function columnNames(pool, tableName) {
  const result = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
  `, [tableName]);
  return new Set(result.rows.map((row) => row.column_name));
}

test('versioned migrations create the required tables and constraints', async () => {
  const { pool } = await database();

  try {
    await runMigrations(pool);

    const names = await tableNames(pool);
    for (const name of ['users', 'sessions', 'platform_accounts', 'cases', 'screenshots', 'login_commands', 'report_exports', 'import_batches', 'extension_devices', 'extension_pairings']) {
      assert.equal(names.has(name), true, `missing table ${name}`);
    }

    const expectedColumns = {
      users: ['id', 'username', 'password_hash', 'role', 'enabled', 'deleted_at', 'created_at', 'updated_at'],
      sessions: ['id', 'user_id', 'token_hash', 'client_type', 'extension_device_id', 'expires_at', 'revoked_at', 'created_at'],
      extension_devices: ['id', 'device_id', 'label', 'paired_by', 'enabled', 'revoked_at', 'last_seen_at', 'created_at', 'updated_at'],
      extension_pairings: ['id', 'device_id', 'label', 'exchange_secret_hash', 'verification_code_hash', 'status', 'approved_by', 'approved_at', 'consumed_at', 'expires_at', 'created_at', 'updated_at'],
      platform_accounts: ['id', 'label', 'secret_ciphertext', 'secret_iv', 'secret_tag', 'secret_version', 'enabled', 'deleted_at', 'created_by', 'created_at', 'updated_at', 'salesperson_wecom_userid', 'assistant_wecom_userid'],
      cases: ['id', 'client_uid', 'platform_account_id', 'created_by', 'kind', 'plaintiff', 'defendant', 'status', 'filed_time', 'case_number', 'reject_time', 'reject_reason', 'query_time', 'needs_human', 'error_code', 'source_event_id', 'source_updated_at', 'revision', 'created_at', 'updated_at'],
      screenshots: ['id', 'case_id', 'type', 'object_key', 'content_type', 'byte_size', 'sha256', 'captured_at', 'created_at'],
      login_commands: ['id', 'platform_account_id', 'status', 'result_code', 'result_message', 'claimed_by', 'created_by', 'created_at', 'updated_at', 'expires_at'],
      report_exports: ['id', 'file_name', 'object_key', 'content_type', 'byte_size', 'sha256', 'platform_account_id', 'created_by', 'created_at', 'updated_at'],
      import_batches: ['id', 'file_name', 'object_key', 'content_type', 'byte_size', 'sha256', 'li_rows', 'qz_rows', 'skipped_rows', 'created_by', 'created_at', 'updated_at', 'expires_at'],
    };

    for (const [table, columns] of Object.entries(expectedColumns)) {
      const actual = await columnNames(pool, table);
      for (const column of columns) {
        assert.equal(actual.has(column), true, `missing ${table}.${column}`);
      }
    }

  } finally {
    await close(pool);
  }
});

test('cases.revision is globally monotonic for inserts and updates', async () => {
  const { pool } = await database();

  try {
    await runMigrations(pool);
    await pool.query(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES ($1, 'admin', 'hash', 'admin')
    `, ['00000000-0000-0000-0000-000000000001']);
    await pool.query(`
      INSERT INTO platform_accounts
        (id, label, secret_ciphertext, secret_iv, secret_tag, created_by)
      VALUES ($1, 'primary', $2, $3, $4, $5)
    `, [
      '00000000-0000-0000-0000-000000000010',
      Buffer.from('cipher'),
      Buffer.alloc(12, 1),
      Buffer.alloc(16, 2),
      '00000000-0000-0000-0000-000000000001',
    ]);

    const first = await pool.query(`
      INSERT INTO cases (id, client_uid, platform_account_id, kind, status)
      VALUES ($1, 'client-1', $2, 'li', '审核中')
      RETURNING revision
    `, ['00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000000010']);
    const second = await pool.query(`
      INSERT INTO cases (id, client_uid, platform_account_id, kind, status)
      VALUES ($1, 'client-2', $2, 'qz', '审核中')
      RETURNING revision
    `, ['00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000010']);
    const updated = await pool.query(`
      UPDATE cases SET status = 'UNKNOWN', revision = nextval('cases_revision_seq')
      WHERE id = $1
      RETURNING revision
    `, ['00000000-0000-0000-0000-000000000100']);

    assert.equal(Number(first.rows[0].revision) < Number(second.rows[0].revision), true);
    assert.equal(Number(second.rows[0].revision) < Number(updated.rows[0].revision), true);
  } finally {
    await close(pool);
  }
});

test('foreign keys, enum checks, and unique screenshot identity are enforced', async () => {
  const { pool } = await database();

  try {
    await runMigrations(pool);
    await pool.query(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES ('00000000-0000-0000-0000-000000000001', 'admin', 'hash', 'admin')
    `);
    await pool.query(`
      INSERT INTO platform_accounts
        (id, label, secret_ciphertext, secret_iv, secret_tag, created_by)
      VALUES ('00000000-0000-0000-0000-000000000010', 'primary', 'cipher', 'iv', 'tag', '00000000-0000-0000-0000-000000000001')
    `);
    await pool.query(`
      INSERT INTO cases (id, client_uid, platform_account_id, kind, status)
      VALUES ('00000000-0000-0000-0000-000000000100', 'client-1', '00000000-0000-0000-0000-000000000010', 'li', '立案成功')
    `);

    await assert.rejects(
      pool.query(`
        INSERT INTO cases (id, client_uid, platform_account_id, kind, status)
        VALUES ('00000000-0000-0000-0000-000000000101', 'client-1', '00000000-0000-0000-0000-000000000010', 'li', '立案成功')
      `),
    );
    await assert.rejects(
      pool.query(`
        INSERT INTO cases (id, client_uid, platform_account_id, kind, status)
        VALUES ('00000000-0000-0000-0000-000000000102', 'client-2', '00000000-0000-0000-0000-000000000010', 'li', '强执成功')
      `),
    );

    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);
    await pool.query(`
      INSERT INTO screenshots (id, case_id, type, object_key, content_type, byte_size, sha256, captured_at)
      VALUES ('00000000-0000-0000-0000-000000000200', '00000000-0000-0000-0000-000000000100', 'success', 'private/key-1', 'image/png', 10, $1, now())
    `, [hashA]);
    await assert.rejects(
      pool.query(`
        INSERT INTO screenshots (id, case_id, type, object_key, content_type, byte_size, sha256, captured_at)
        VALUES ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000100', 'success', 'private/key-2', 'image/png', 10, $1, now())
      `, [hashB]),
    );
  } finally {
    await close(pool);
  }
});

test('import batch migration enforces private object identity, bounds, and creator retention', async () => {
  const { pool } = await database();

  try {
    await runMigrations(pool);
    await pool.query(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES ('00000000-0000-0000-0000-000000000001', 'admin', 'hash', 'admin')
    `);
    const valid = [
      '00000000-0000-0000-0000-000000000301',
      'fixture.xlsx',
      'import-batches/00000000-0000-0000-0000-000000000301.xlsx',
      'a'.repeat(64),
      '00000000-0000-0000-0000-000000000001',
    ];
    await pool.query(`
      INSERT INTO import_batches (
        id, file_name, object_key, content_type, byte_size, sha256,
        li_rows, qz_rows, skipped_rows, created_by, expires_at
      )
      VALUES ($1, $2, $3,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        1, $4, 0, 0, 0, $5, NOW() + INTERVAL '30 days')
    `, valid);

    await assert.rejects(pool.query(`
      INSERT INTO import_batches (
        id, file_name, object_key, content_type, byte_size, sha256,
        li_rows, qz_rows, skipped_rows, created_by, expires_at
      )
      VALUES (
        '00000000-0000-0000-0000-000000000302', 'fixture.xlsx', $1,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        1, $2, 0, 0, 0, $3, NOW() + INTERVAL '30 days'
      )
    `, [valid[2], valid[3], valid[4]]));
    await assert.rejects(pool.query(`
      INSERT INTO import_batches (
        id, file_name, object_key, content_type, byte_size, sha256,
        li_rows, qz_rows, skipped_rows, created_by, expires_at
      )
      VALUES (
        '00000000-0000-0000-0000-000000000303', 'fixture.xlsx',
        'import-batches/invalid.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        0, $1, 0, 0, 0, $2, NOW() + INTERVAL '30 days'
      )
    `, [valid[3], valid[4]]));
    await assert.rejects(pool.query(`
      INSERT INTO import_batches (
        id, file_name, object_key, content_type, byte_size, sha256,
        li_rows, qz_rows, skipped_rows, created_by, expires_at
      )
      VALUES (
        '00000000-0000-0000-0000-000000000304', 'fixture.xlsx',
        'import-batches/invalid-content-type.xlsx', 'application/octet-stream',
        1, $1, 0, 0, 0, $2, NOW() + INTERVAL '30 days'
      )
    `, [valid[3], valid[4]]));
    await assert.rejects(pool.query(`
      INSERT INTO import_batches (
        id, file_name, object_key, content_type, byte_size, sha256,
        li_rows, qz_rows, skipped_rows, created_by, expires_at
      )
      VALUES (
        '00000000-0000-0000-0000-000000000305', 'fixture.xlsx',
        'import-batches/invalid-summary.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        1, $1, -1, 0, 0, $2, NOW() + INTERVAL '30 days'
      )
    `, [valid[3], valid[4]]));
    await assert.rejects(pool.query(`
      DELETE FROM users WHERE id = '00000000-0000-0000-0000-000000000001'
    `));
  } finally {
    await close(pool);
  }
});

test('running migrations twice is harmless and explicit rollback restores a clean state', async () => {
  const { pool } = await database();

  try {
    await runMigrations(pool);
    await runMigrations(pool);
    await pool.query(`
      INSERT INTO users (id, username, password_hash, role)
      VALUES ('00000000-0000-0000-0000-000000000001', 'admin', 'hash', 'admin')
    `);
    await pool.query(`
      INSERT INTO extension_devices (id, device_id, paired_by)
      VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001')
    `);
    await pool.query(`
      INSERT INTO sessions (id, user_id, token_hash, client_type, extension_device_id, expires_at)
      VALUES ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', $1, 'extension', '00000000-0000-0000-0000-000000000002', NOW() + INTERVAL '30 days')
    `, ['a'.repeat(64)]);
    const applied = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(applied.rows.map((row) => row.version), ['001_initial', '002_add_cases_created_by', '003_login_commands', '004_report_exports', '005_browser_commands', '006_import_batches', '007_extension_devices', '008_query_all_export', '009_report_exports_platform_account', '010_platform_account_label_reuse', '011_wecom_automatic_notifications', '012_wecom_userid_mentions']);

    assert.equal(await rollbackLastMigration(pool), '012_wecom_userid_mentions');
    await rollbackLastMigration(pool);
    await rollbackLastMigration(pool);
    await rollbackLastMigration(pool);
    await rollbackLastMigration(pool);
    await rollbackLastMigration(pool);
    const afterRollback = await tableNames(pool);
    assert.equal(afterRollback.has('users'), true);
    assert.equal(afterRollback.has('screenshots'), true);
    assert.equal(afterRollback.has('login_commands'), true);
    assert.equal(afterRollback.has('report_exports'), true);
    assert.equal(afterRollback.has('import_batches'), true);
    assert.equal(afterRollback.has('extension_devices'), false);
    assert.equal((await pool.query("SELECT COUNT(*) AS count FROM sessions WHERE client_type = 'extension'")).rows[0].count, 0);
    assert.equal((await columnNames(pool, 'cases')).has('created_by'), true);
    const appliedAfterRollback = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(appliedAfterRollback.rows.map((row) => row.version), ['001_initial', '002_add_cases_created_by', '003_login_commands', '004_report_exports', '005_browser_commands', '006_import_batches']);

    // pg-mem retains this primary-key relation after DROP TABLE; PostgreSQL removes it.
    await pool.query('DROP INDEX IF EXISTS wecom_notifications_pkey');
    await pool.query('DROP INDEX IF EXISTS wecom_notifications_case_id_result_status_key');
    await pool.query('DROP INDEX IF EXISTS wecom_notifications_status_idx');
    await pool.query('DROP INDEX IF EXISTS browser_commands_pkey');
    await pool.query('DROP INDEX IF EXISTS extension_devices_pkey');
    await pool.query('DROP INDEX IF EXISTS extension_devices_device_id_key');
    await pool.query('DROP INDEX IF EXISTS extension_pairings_pkey');
    await runMigrations(pool);
    const afterReapply = await tableNames(pool);
    assert.equal(afterReapply.has('users'), true);
    assert.equal(afterReapply.has('screenshots'), true);
    assert.equal(afterReapply.has('login_commands'), true);
    assert.equal(afterReapply.has('report_exports'), true);
    assert.equal(afterReapply.has('import_batches'), true);
    assert.equal((await columnNames(pool, 'cases')).has('created_by'), true);
  } finally {
    await close(pool);
  }
});

test('startup delegates migration and listening to the bound backend bootstrap and exposes an offline migration command', async () => {
  const mainSource = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.scripts['server:migrate'], 'npm run server:build && node server/dist/migrate.js');
  const migrationCall = mainSource.indexOf('await runMigrations(pool);');
  const listenCall = mainSource.indexOf('await app.listen');
  assert.ok(migrationCall >= 0, 'main must run migrations');
  assert.ok(listenCall > migrationCall, 'main must migrate before listening');
  assert.match(mainSource, /await startBoundBackend\(/);
  assert.match(mainSource, /Backend startup failed/);
  assert.match(mainSource, /database configuration/);
});
