import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const ADVISORY_LOCK_CLASS = 8102;
const ADVISORY_LOCK_ID = 1;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(
  databaseUrl: string,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'loopforge-migrator' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [ADVISORY_LOCK_CLASS, ADVISORY_LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version VARCHAR(64) PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
       )`,
    );

    const files = (await readdir(migrationsDir))
      .filter((name) => /^\d+_[A-Za-z0-9_-]+\.sql$/.test(name))
      .sort((a, b) => a.localeCompare(b));

    const appliedRows = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const appliedVersions = new Set(appliedRows.rows.map((row) => row.version));
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (appliedVersions.has(version)) {
        skipped.push(version);
        continue;
      }
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [version, file]);
        await client.query('COMMIT');
        applied.push(version);
        appliedVersions.add(version);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    return { applied, skipped };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [ADVISORY_LOCK_CLASS, ADVISORY_LOCK_ID]);
    } catch {
      // Unlock is best-effort when the connection is already broken.
    }
    await client.end();
  }
}
