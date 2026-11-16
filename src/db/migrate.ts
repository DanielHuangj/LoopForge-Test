import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const ADVISORY_LOCK_CLASS = 8102;
const ADVISORY_LOCK_ID = 1;
const MIGRATION_FILE = /^(\d{3})_[A-Za-z0-9_-]+\.sql$/;

interface MigrationFile {
  version: string;
  sequence: number;
  file: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

async function discoverMigrations(migrationsDir: string): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const migrations: MigrationFile[] = [];
  const seenSequences = new Map<number, string>();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = MIGRATION_FILE.exec(entry.name);
    if (!match) {
      throw new Error(`invalid migration filename: ${entry.name}`);
    }
    const sequence = Number(match[1]);
    const duplicate = seenSequences.get(sequence);
    if (duplicate) {
      throw new Error(`duplicate migration sequence ${match[1]}: ${duplicate}, ${entry.name}`);
    }
    seenSequences.set(sequence, entry.name);
    migrations.push({
      version: entry.name.slice(0, -'.sql'.length),
      sequence,
      file: entry.name,
    });
  }

  return migrations.sort((left, right) => left.sequence - right.sequence || left.file.localeCompare(right.file));
}

export async function runMigrations(
  databaseUrl: string,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const files = await discoverMigrations(migrationsDir);
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

    const appliedRows = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const appliedVersions = new Set(appliedRows.rows.map((row) => row.version));
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const migration of files) {
      if (appliedVersions.has(migration.version)) {
        skipped.push(migration.version);
        continue;
      }
      const sql = await readFile(path.join(migrationsDir, migration.file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
          migration.version,
          migration.file,
        ]);
        await client.query('COMMIT');
        applied.push(migration.version);
        appliedVersions.add(migration.version);
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
