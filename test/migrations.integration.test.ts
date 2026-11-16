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
      expect(applied.sort()).toEqual(['001_identity', '002_login_attempt']);

      const versions = await tableRows<{ version: string; count: string }>(
        concurrentDatabase.url,
        'SELECT version, count(*)::text AS count FROM schema_migrations GROUP BY version ORDER BY version',
      );
      expect(versions).toEqual([
        { version: '001_identity', count: '1' },
        { version: '002_login_attempt', count: '1' },
      ]);
    } finally {
      await concurrentDatabase.close();
    }
  });

  it('creates identity tables, applies versions once, and can repeat on empty and existing databases', async () => {
    const first = await runMigrations(database.url);
    expect(first.applied).toEqual(['001_identity', '002_login_attempt']);
    expect(first.skipped).toEqual([]);

    const second = await runMigrations(database.url);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['001_identity', '002_login_attempt']);

    const tables = await tableRows<{ table_name: string }>(
      database.url,
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() ORDER BY table_name`,
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      'app_user',
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
    await runSeed(database.url, 'test');

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

  it('does not create dish, menu, order or image business tables', async () => {
    const names = await tableRows<{ table_name: string }>(
      database.url,
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()",
    );
    const tableNames = new Set(names.map((row) => row.table_name));
    for (const forbidden of ['dish', 'daily_menu', 'daily_menu_item', 'orders', 'order_items', 'image']) {
      expect(tableNames.has(forbidden)).toBe(false);
    }
  });
});
