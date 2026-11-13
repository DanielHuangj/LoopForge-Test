import type pg from 'pg';
import type { AccountStatus, NormalizedIdentity, Role, UserRecord } from '../../domain/models.js';
import type { Pool } from 'pg';
import type { IdentityStore } from '../../ports/identity-store.js';
import { withTransaction } from '../transaction.js';

interface UserRow {
  user_id: string;
  name: string;
  department: string | null;
  employee_no: string | null;
  account_status: AccountStatus;
  synced_at: Date;
  roles: Role[];
}

function mapRow(row: UserRow): UserRecord {
  return {
    userId: row.user_id,
    name: row.name,
    department: row.department,
    employeeNo: row.employee_no,
    accountStatus: row.account_status,
    syncedAt: row.synced_at,
    roles: row.roles ?? [],
  };
}

export class UserRepository implements IdentityStore {
  constructor(private readonly pool: Pool) {}

  async findById(userId: string): Promise<UserRecord | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT u.user_id, u.name, u.department, u.employee_no, u.account_status, u.synced_at,
              COALESCE(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
         FROM app_user u
         LEFT JOIN user_role r ON r.user_id = u.user_id
        WHERE u.user_id = $1
        GROUP BY u.user_id`,
      [userId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async synchronize(identity: NormalizedIdentity): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO app_user (user_id, employee_no, name, department, account_status, synced_at)
         VALUES ($1, $2, $3, $4, $5, clock_timestamp())
         ON CONFLICT (user_id) DO UPDATE
           SET employee_no = EXCLUDED.employee_no,
               name = EXCLUDED.name,
               department = EXCLUDED.department,
               account_status = EXCLUDED.account_status,
               synced_at = clock_timestamp()`,
        [identity.userId, identity.employeeNo, identity.name, identity.department, identity.accountStatus],
      );
      await client.query('DELETE FROM user_role WHERE user_id = $1', [identity.userId]);
      if (identity.roles.length > 0) {
        await client.query(
          `INSERT INTO user_role (user_id, role)
           SELECT $1, unnest($2::varchar[])`,
          [identity.userId, identity.roles],
        );
      }
    });
  }

  async revokeRolesForExisting(identity: NormalizedIdentity): Promise<void> {
    await withTransaction(this.pool, async (client) => {
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
      await client.query('DELETE FROM user_role WHERE user_id = $1', [identity.userId]);
    });
  }
}
