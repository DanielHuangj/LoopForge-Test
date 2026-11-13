import { runSeed } from './seed.js';
import { createRedactor } from '../logger.js';

const appEnv = process.env.APP_ENV;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'seed_config_error',
      missing: ['DATABASE_URL'],
    }),
  );
  process.exit(1);
}
if (appEnv !== 'dev' && appEnv !== 'test') {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'seed_rejected',
      reason: 'APP_ENV must be dev or test',
    }),
  );
  process.exit(1);
}

try {
  await runSeed(databaseUrl, appEnv);
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', event: 'seed_complete', users: 4 }));
} catch (error) {
  const name = error instanceof Error ? error.name : 'Error';
  const message = createRedactor([databaseUrl]).redact(error instanceof Error ? error.message : 'seed failed');
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'seed_failed',
      errorType: name,
      message,
    }),
  );
  process.exit(1);
}
