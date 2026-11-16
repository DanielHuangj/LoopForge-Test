import { runMigrations } from './migrate.js';
import { createRedactor } from '../logger.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'migration_config_error',
      missing: ['DATABASE_URL'],
    }),
  );
  process.exit(1);
}

try {
  const result = await runMigrations(databaseUrl);
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', event: 'migration_complete', ...result }));
} catch (error) {
  const name = error instanceof Error ? error.name : 'Error';
  const message = createRedactor([databaseUrl]).redact(error instanceof Error ? error.message : 'migration failed');
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'migration_failed',
      errorType: name,
      message,
    }),
  );
  process.exit(1);
}
