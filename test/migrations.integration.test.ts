import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';
import { runSeed } from '../src/db/seed.js';
import { createTestDatabase, execute, tableRows, type TestDatabase } from './helpers/database.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.close();
});

describe('migrations and seed idempotency', () => {
  it('serializes concurrent migrations against an empty schema', async (context) => {
    const concurrentDatabase = await createTestDatabase();
    try {
      if (concurrentDatabase.kind === 'pglite') {
        context.skip('PGlite fallback does not support concurrent wire-protocol sessions');
        return;
      }
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => runMigrations(concurrentDatabase.url)),
      );
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected).toEqual([]);

      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof runMigrations>>> =>
          result.status === 'fulfilled',
      );
      const applied = fulfilled.flatMap((result) => result.value.applied);
      expect(applied.sort()).toEqual(['001_identity', '002_login_attempt', '003_dish']);

      const versions = await tableRows<{ version: string; count: string }>(
        concurrentDatabase.url,
        'SELECT version, count(*)::text AS count FROM schema_migrations GROUP BY version ORDER BY version',
      );
      expect(versions).toEqual([
        { version: '001_identity', count: '1' },
        { version: '002_login_attempt', count: '1' },
        { version: '003_dish', count: '1' },
      ]);
    } finally {
      await concurrentDatabase.close();
    }
  });

  it('creates identity tables, applies versions once, and can repeat on empty and existing databases', async () => {
    const first = await runMigrations(database.url);
    expect(first.applied).toEqual(['001_identity', '002_login_attempt', '003_dish']);
    expect(first.skipped).toEqual([]);

    const second = await runMigrations(database.url);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['001_identity', '002_login_attempt', '003_dish']);

    const tables = await tableRows<{ table_name: string }>(
      database.url,
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() ORDER BY table_name`,
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      'app_user',
      'dish',
      'login_attempt',
      'schema_migrations',
      'user_role',
    ]);

    const versions = await tableRows<{ version: string; count: string }>(
      database.url,
      'SELECT version, count(*)::text AS count FROM schema_migrations GROUP BY version ORDER BY version',
    );
    expect(versions).toEqual([
      { version: '001_identity', count: '1' },
      { version: '002_login_attempt', count: '1' },
      { version: '003_dish', count: '1' },
    ]);

    await execute(
      database.url,
      `INSERT INTO app_user (user_id, employee_no, name, department, account_status, synced_at)
       VALUES ('u-existing', 'EX1', '既有用户', '研发部', 'ACTIVE', clock_timestamp())`,
    );
    await execute(database.url, "INSERT INTO user_role (user_id, role) VALUES ('u-existing', 'EMPLOYEE')");

    const third = await runMigrations(database.url);
    const fourth = await runMigrations(database.url);
    expect(third.applied).toEqual([]);
    expect(fourth.applied).toEqual([]);

    const existing = await tableRows<{ user_id: string; name: string; role: string }>(
      database.url,
      `SELECT u.user_id, u.name, r.role FROM app_user u JOIN user_role r ON r.user_id = u.user_id
        WHERE u.user_id = 'u-existing'`,
    );
    expect(existing).toEqual([{ user_id: 'u-existing', name: '既有用户', role: 'EMPLOYEE' }]);
  });

  it('keeps seed idempotent and enforces database constraints', async () => {
    await runMigrations(database.url);
    await runSeed(database.url, 'test');
    const firstSnapshot = await tableRows<{
      user_id: string;
      employee_no: string;
      name: string;
      department: string;
      account_status: string;
      synced_at: string;
      roles: string;
    }>(
      database.url,
      `SELECT u.user_id, u.employee_no, u.name, u.department, u.account_status,
              u.synced_at::text AS synced_at,
              coalesce(string_agg(r.role, ',' ORDER BY r.role), '') AS roles
         FROM app_user u LEFT JOIN user_role r ON r.user_id = u.user_id
        WHERE u.user_id IN ('u-emp-001', 'u-admin-001', 'u-dual-001', 'u-disabled-001')
        GROUP BY u.user_id ORDER BY u.user_id`,
    );
    await runSeed(database.url, 'test');
    const secondSnapshot = await tableRows<{
      user_id: string;
      employee_no: string;
      name: string;
      department: string;
      account_status: string;
      synced_at: string;
      roles: string;
    }>(
      database.url,
      `SELECT u.user_id, u.employee_no, u.name, u.department, u.account_status,
              u.synced_at::text AS synced_at,
              coalesce(string_agg(r.role, ',' ORDER BY r.role), '') AS roles
         FROM app_user u LEFT JOIN user_role r ON r.user_id = u.user_id
        WHERE u.user_id IN ('u-emp-001', 'u-admin-001', 'u-dual-001', 'u-disabled-001')
        GROUP BY u.user_id ORDER BY u.user_id`,
    );
    expect(secondSnapshot).toEqual(firstSnapshot);

    const users = await tableRows<{ user_id: string; role_count: string }>(
      database.url,
      `SELECT u.user_id, count(r.role)::text AS role_count
         FROM app_user u LEFT JOIN user_role r ON r.user_id = u.user_id
        WHERE u.user_id IN ('u-emp-001', 'u-admin-001', 'u-dual-001', 'u-disabled-001')
        GROUP BY u.user_id ORDER BY u.user_id`,
    );
    expect(users).toEqual([
      { user_id: 'u-admin-001', role_count: '1' },
      { user_id: 'u-disabled-001', role_count: '1' },
      { user_id: 'u-dual-001', role_count: '2' },
      { user_id: 'u-emp-001', role_count: '1' },
    ]);

    const roleRows = await tableRows<{ count: string }>(
      database.url,
      'SELECT count(*)::text AS count FROM user_role WHERE user_id = \'u-dual-001\'',
    );
    expect(roleRows[0]?.count).toBe('2');

    await expect(
      execute(
        database.url,
        `INSERT INTO app_user (user_id, employee_no, name, account_status, synced_at)
         VALUES ('u-duplicate-no', 'E001', '重复员工号', 'ACTIVE', clock_timestamp())`,
      ),
    ).rejects.toThrow(/duplicate key/i);

    await expect(
      execute(database.url, "INSERT INTO user_role (user_id, role) VALUES ('u-emp-001', 'SUPER_ADMIN')"),
    ).rejects.toThrow(/check constraint/i);

    await expect(
      execute(
        database.url,
        `INSERT INTO app_user (user_id, employee_no, name, account_status, synced_at)
         VALUES ('u-bad-status', NULL, '非法状态', 'LOCKED', clock_timestamp())`,
      ),
    ).rejects.toThrow(/check constraint/i);

    await expect(
      execute(database.url, "INSERT INTO user_role (user_id, role) VALUES ('u-emp-001', 'EMPLOYEE')"),
    ).rejects.toThrow(/duplicate key/i);

    await execute(
      database.url,
      `INSERT INTO app_user (user_id, employee_no, name, account_status, synced_at)
       VALUES ('u-null-1', NULL, '空员工号一', 'ACTIVE', clock_timestamp()),
              ('u-null-2', NULL, '空员工号二', 'ACTIVE', clock_timestamp())`,
    );
  });

  it('rejects seed in production without writing data', async () => {
    await expect(runSeed(database.url, 'prod')).rejects.toThrow(/APP_ENV=dev or APP_ENV=test/);
  });

  it('creates the dish table but does not create downstream menu, order or image tables', async () => {
    const names = await tableRows<{ table_name: string }>(
      database.url,
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()",
    );
    const tableNames = new Set(names.map((row) => row.table_name));
    expect(tableNames.has('dish')).toBe(true);
    for (const forbidden of ['daily_menu', 'daily_menu_item', 'orders', 'order_items', 'image']) {
      expect(tableNames.has(forbidden)).toBe(false);
    }
  });

  it('orders migrations by numeric version prefix and rejects invalid or duplicate prefixes', async () => {
    const migrationsDir = await mkdtemp(path.join(tmpdir(), 'loopforge-migrations-'));
    const numericOrderDatabase = await createTestDatabase();
    const invalidDatabase = await createTestDatabase();
    const duplicateDatabase = await createTestDatabase();
    try {
      await writeFile(path.join(migrationsDir, '010_tenth.sql'), "INSERT INTO migration_order (name) VALUES ('tenth');");
      await writeFile(path.join(migrationsDir, '002_second.sql'), 'CREATE TABLE migration_order (name TEXT NOT NULL);');
      const result = await runMigrations(numericOrderDatabase.url, migrationsDir);
      expect(result.applied).toEqual(['002_second', '010_tenth']);
      const markers = await tableRows<{ name: string }>(
        numericOrderDatabase.url,
        'SELECT name FROM migration_order',
      );
      expect(markers).toEqual([{ name: 'tenth' }]);

      const invalidDir = await mkdtemp(path.join(tmpdir(), 'loopforge-invalid-migration-'));
      try {
        await writeFile(path.join(invalidDir, '001_valid.sql'), 'SELECT 1;');
        await writeFile(path.join(invalidDir, '2_bad.sql'), 'SELECT 2;');
        await expect(runMigrations(invalidDatabase.url, invalidDir)).rejects.toThrow(/invalid migration filename/);
        const tables = await tableRows<{ table_name: string }>(
          invalidDatabase.url,
          "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'schema_migrations'",
        );
        expect(tables).toEqual([]);
      } finally {
        await rm(invalidDir, { recursive: true, force: true });
      }

      const duplicateDir = await mkdtemp(path.join(tmpdir(), 'loopforge-duplicate-migration-'));
      try {
        await writeFile(path.join(duplicateDir, '001_first.sql'), 'SELECT 1;');
        await writeFile(path.join(duplicateDir, '001_second.sql'), 'SELECT 2;');
        await expect(runMigrations(duplicateDatabase.url, duplicateDir)).rejects.toThrow(
          /duplicate migration sequence 001/,
        );
      } finally {
        await rm(duplicateDir, { recursive: true, force: true });
      }
    } finally {
      await rm(migrationsDir, { recursive: true, force: true });
      await numericOrderDatabase.close();
      await invalidDatabase.close();
      await duplicateDatabase.close();
    }
  });

  it('rolls back the failed migration, stops later versions, and releases the advisory lock', async () => {
    const migrationsDir = await mkdtemp(path.join(tmpdir(), 'loopforge-failing-migration-'));
    const failingDatabase = await createTestDatabase();
    try {
      await writeFile(path.join(migrationsDir, '001_ok.sql'), 'CREATE TABLE migration_first (id integer);');
      await writeFile(path.join(migrationsDir, '002_fail.sql'), 'CREATE TABLE broken (;');
      await writeFile(path.join(migrationsDir, '003_later.sql'), 'CREATE TABLE migration_later (id integer);');

      await expect(runMigrations(failingDatabase.url, migrationsDir)).rejects.toBeInstanceOf(Error);

      const versions = await tableRows<{ version: string }>(
        failingDatabase.url,
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      expect(versions).toEqual([{ version: '001_ok' }]);

      const tables = await tableRows<{ table_name: string }>(
        failingDatabase.url,
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name IN ('migration_first', 'migration_later')
          ORDER BY table_name`,
      );
      expect(tables).toEqual([{ table_name: 'migration_first' }]);

      const lock = await tableRows<{ locked: boolean }>(
        failingDatabase.url,
        'SELECT pg_try_advisory_lock(8102, 1) AS locked',
      );
      expect(lock).toEqual([{ locked: true }]);
      await execute(failingDatabase.url, 'SELECT pg_advisory_unlock(8102, 1)');
    } finally {
      await rm(migrationsDir, { recursive: true, force: true });
      await failingDatabase.close();
    }
  });

  it('refreshes synced_at when only the role set changes', async () => {
    await runMigrations(database.url);
    await runSeed(database.url, 'test');
    await execute(
      database.url,
      "DELETE FROM user_role WHERE user_id = 'u-dual-001' AND role = 'MENU_ADMIN'",
    );
    await execute(
      database.url,
      "UPDATE app_user SET synced_at = '2000-01-01T00:00:00Z' WHERE user_id = 'u-dual-001'",
    );

    await runSeed(database.url, 'test');

    const rows = await tableRows<{ synced_at: string; roles: string }>(
      database.url,
      `SELECT u.synced_at::text AS synced_at,
              coalesce(string_agg(r.role, ',' ORDER BY r.role), '') AS roles
         FROM app_user u LEFT JOIN user_role r ON r.user_id = u.user_id
        WHERE u.user_id = 'u-dual-001'
        GROUP BY u.user_id`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.roles).toBe('EMPLOYEE,MENU_ADMIN');
    expect(new Date(rows[0]!.synced_at).getTime()).toBeGreaterThan(
      new Date('2000-01-02T00:00:00Z').getTime(),
    );
  });
});
