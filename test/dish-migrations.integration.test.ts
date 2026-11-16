import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { createTestDatabase, execute, tableRows, type TestDatabase } from './helpers/database.js';

let database: TestDatabase;

const DISH_ID = '7a49d4a1-0f5c-4df0-9e2f-3f7ad6d68f43';

beforeAll(async () => {
  database = await createTestDatabase();
  await runMigrations(database.url);
  await execute(
    database.url,
    `INSERT INTO app_user (user_id, name, account_status, synced_at)
     VALUES ('u-admin-001', '管理员', 'ACTIVE', clock_timestamp())`,
  );
});

afterAll(async () => {
  await database?.close();
});

describe('003_dish migration contract', () => {
  it('creates the frozen column types, constraints and image indexes', async () => {
    const columns = await tableRows<{
      column_name: string;
      data_type: string;
      character_maximum_length: number | null;
      is_nullable: string;
    }>(
      database.url,
      `SELECT column_name, data_type, character_maximum_length, is_nullable
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'dish'
        ORDER BY ordinal_position`,
    );
    const byName = new Map(columns.map((column) => [column.column_name, column]));
    expect(byName.get('dish_id')).toMatchObject({ data_type: 'character varying', character_maximum_length: 64 });
    expect(byName.get('reference_price_cents')).toMatchObject({ data_type: 'bigint', is_nullable: 'NO' });
    expect(byName.get('image_url')).toMatchObject({ data_type: 'character varying', character_maximum_length: 2048 });
    expect(byName.get('sale_status')).toMatchObject({ is_nullable: 'NO' });

    const indexes = await tableRows<{ indexname: string }>(
      database.url,
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'dish'
        ORDER BY indexname`,
    );
    expect(indexes.map((row) => row.indexname)).toEqual([
      'dish_pkey',
      'idx_dish_admin_list',
      'uq_dish_image_object_key',
      'uq_dish_image_url',
    ]);

    await execute(
      database.url,
      `WITH t AS (SELECT clock_timestamp() AS now)
       INSERT INTO dish (
         dish_id, name, category, reference_price_cents, created_at, created_by, updated_at, updated_by
       ) SELECT $1, '宫保鸡丁', '热菜', $2::bigint, t.now, 'u-admin-001', t.now, 'u-admin-001' FROM t`,
      [DISH_ID, '9223372036854775807'],
    );
    const stored = await tableRows<{ price: string; status: string }>(
      database.url,
      `SELECT reference_price_cents::text AS price, sale_status AS status FROM dish WHERE dish_id = $1`,
      [DISH_ID],
    );
    expect(stored).toEqual([{ price: '9223372036854775807', status: 'OFF_SHELF' }]);
  });

  it('rejects zero price, partial image state and invalid UUID values', async () => {
    await expect(
      execute(
        database.url,
        `INSERT INTO dish (dish_id, name, category, reference_price_cents, created_at, created_by, updated_at, updated_by)
         VALUES ('8a49d4a1-0f5c-4df0-9e2f-3f7ad6d68f43', '零价', '热菜', 0,
                 clock_timestamp(), 'u-admin-001', clock_timestamp(), 'u-admin-001')`,
      ),
    ).rejects.toThrow(/check constraint/i);

    await expect(
      execute(
        database.url,
        `INSERT INTO dish (dish_id, name, category, reference_price_cents, created_at, created_by, updated_at, updated_by)
         VALUES ('not-a-uuid', '非法标识', '热菜', 1,
                 clock_timestamp(), 'u-admin-001', clock_timestamp(), 'u-admin-001')`,
      ),
    ).rejects.toThrow(/check constraint/i);

    await expect(
      execute(
        database.url,
        `UPDATE dish SET image_url = '/api/v1/dish-images/8c6c9162-5758-4db4-ab2e-87cc4cc31e73'
          WHERE dish_id = $1`,
        [DISH_ID],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it('allows VARCHAR(64) menu/order probe foreign keys and enforces ON DELETE RESTRICT', async () => {
    await execute(
      database.url,
      `CREATE TABLE daily_menu_item_contract_probe (
         menu_id VARCHAR(64) NOT NULL,
         dish_id VARCHAR(64) NOT NULL REFERENCES dish(dish_id) ON DELETE RESTRICT,
         PRIMARY KEY (menu_id, dish_id)
       );
       CREATE TABLE order_items_contract_probe (
         order_id VARCHAR(64) NOT NULL,
         dish_id VARCHAR(64) NOT NULL REFERENCES dish(dish_id) ON DELETE RESTRICT,
         PRIMARY KEY (order_id, dish_id)
       )`,
    );
    await execute(database.url, "INSERT INTO daily_menu_item_contract_probe VALUES ('menu-001', $1)", [DISH_ID]);
    await execute(database.url, "INSERT INTO order_items_contract_probe VALUES ('order-001', $1)", [DISH_ID]);

    await expect(execute(database.url, 'DELETE FROM dish WHERE dish_id = $1', [DISH_ID])).rejects.toThrow(
      /foreign key constraint|RESTRICT setting/i,
    );

    await execute(database.url, 'DELETE FROM daily_menu_item_contract_probe');
    await execute(database.url, 'DELETE FROM order_items_contract_probe');
    await execute(database.url, 'DELETE FROM dish WHERE dish_id = $1', [DISH_ID]);

    await execute(database.url, 'DROP TABLE daily_menu_item_contract_probe');
    await execute(database.url, 'DROP TABLE order_items_contract_probe');
  });
});
