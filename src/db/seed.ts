import pg from 'pg';
import { withTransaction } from './transaction.js';
import type { AccountStatus, NormalizedIdentity, Role } from './types.js';

interface SeedIdentity {
  userId: string;
  employeeNo: string;
  name: string;
  department: string;
  accountStatus: AccountStatus;
  roles: Role[];
}

export const SEED_IDENTITIES: readonly SeedIdentity[] = [
  {
    userId: 'u-emp-001',
    employeeNo: 'E001',
    name: '测试员工',
    department: '研发部',
    accountStatus: 'ACTIVE',
    roles: ['EMPLOYEE'],
  },
  {
    userId: 'u-admin-001',
    employeeNo: 'A001',
    name: '测试管理员',
    department: '行政部',
    accountStatus: 'ACTIVE',
    roles: ['MENU_ADMIN'],
  },
  {
    userId: 'u-dual-001',
    employeeNo: 'D001',
    name: '测试双角色',
    department: '运营部',
    accountStatus: 'ACTIVE',
    roles: ['EMPLOYEE', 'MENU_ADMIN'],
  },
  {
    userId: 'u-disabled-001',
    employeeNo: 'X001',
    name: '测试停用用户',
    department: '研发部',
    accountStatus: 'DISABLED',
    roles: ['EMPLOYEE'],
  },
];

export async function runSeed(databaseUrl: string, appEnv: string): Promise<void> {
  if (appEnv !== 'dev' && appEnv !== 'test') {
    throw new Error('seed is only allowed when APP_ENV=dev or APP_ENV=test');
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await withTransaction(pool, async (client) => {
      for (const seed of SEED_IDENTITIES) {
        const identity: NormalizedIdentity = {
          userId: seed.userId,
          employeeNo: seed.employeeNo,
          name: seed.name,
          department: seed.department,
          accountStatus: seed.accountStatus,
          roles: [...seed.roles],
        };
        const existing = await client.query<{
          employee_no: string | null;
          name: string;
          department: string | null;
          account_status: AccountStatus;
        }>(
          `SELECT employee_no, name, department, account_status
             FROM app_user
            WHERE user_id = $1
            FOR UPDATE`,
          [identity.userId],
        );
        const roleRows = await client.query<{ role: Role }>(
          'SELECT role FROM user_role WHERE user_id = $1 ORDER BY role',
          [identity.userId],
        );
        const currentRoles = new Set(roleRows.rows.map((row) => row.role));
        const targetRoles = new Set(identity.roles);
        const rolesToDelete = [...currentRoles].filter((role) => !targetRoles.has(role));
        const rolesToInsert = [...targetRoles].filter((role) => !currentRoles.has(role));
        const rolesChanged = rolesToDelete.length > 0 || rolesToInsert.length > 0;

        if (existing.rows.length === 0) {
          await client.query(
            `INSERT INTO app_user (user_id, employee_no, name, department, account_status, synced_at)
             VALUES ($1, $2, $3, $4, $5, clock_timestamp())`,
            [identity.userId, identity.employeeNo, identity.name, identity.department, identity.accountStatus],
          );
        } else {
          const current = existing.rows[0]!;
          const changed =
            current.employee_no !== identity.employeeNo ||
            current.name !== identity.name ||
            current.department !== identity.department ||
            current.account_status !== identity.accountStatus ||
            rolesChanged;
          if (changed) {
            await client.query(
              `UPDATE app_user
                  SET employee_no = $2,
                      name = $3,
                      department = $4,
                      account_status = $5,
                      synced_at = clock_timestamp()
                WHERE user_id = $1`,
              [identity.userId, identity.employeeNo, identity.name, identity.department, identity.accountStatus],
            );
          }
        }

        if (rolesToDelete.length > 0) {
          await client.query('DELETE FROM user_role WHERE user_id = $1 AND role = ANY($2::varchar[])', [
            identity.userId,
            rolesToDelete,
          ]);
        }
        if (rolesToInsert.length > 0) {
          await client.query('INSERT INTO user_role (user_id, role) SELECT $1, unnest($2::varchar[])', [
            identity.userId,
            rolesToInsert,
          ]);
        }
      }
    });
  } finally {
    await pool.end();
  }
}
