import type { Pool } from 'pg';
import type { LoginAttemptStore } from '../../ports/login-attempt-store.js';

export class LoginAttemptRepository implements LoginAttemptStore {
  constructor(private readonly pool: Pool) {}

  async create(stateHash: string, nonceHash: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO login_attempt (state_hash, nonce_hash, created_at, expires_at)
       VALUES ($1, $2, clock_timestamp(), clock_timestamp() + interval '600 seconds')`,
      [stateHash, nonceHash],
    );
  }

  async removeExpired(): Promise<void> {
    await this.pool.query('DELETE FROM login_attempt WHERE expires_at <= clock_timestamp()');
  }

  async consume(stateHash: string): Promise<string | null> {
    const result = await this.pool.query<{ nonce_hash: string }>(
      `DELETE FROM login_attempt
        WHERE state_hash = $1 AND expires_at > clock_timestamp()
        RETURNING nonce_hash`,
      [stateHash],
    );
    return result.rows[0]?.nonce_hash ?? null;
  }
}
