import { loadConfig, ConfigError } from './config.js';
import { buildApp } from './app.js';
import { checkDatabase, closePool, createPool } from './db/pool.js';
import { createLogger, createRedactor } from './logger.js';
import { createMockIdp, type MockIdp } from './sso/mock-idp.js';
import { createAppServices } from './composition/container.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          event: 'startup_config_error',
          variables: error.variableNames,
        }),
      );
      process.exit(1);
    }
    throw error;
  }

  const redactor = createRedactor([
    config.databaseUrl,
    config.sso.clientSecret,
    config.sessionSecret,
    config.objectStorage.accessKeyId,
    config.objectStorage.secretAccessKey,
  ]);
  const logger = createLogger(config.logLevel);
  const pool = createPool(config.databaseUrl, {
    connectionTimeoutMillis: config.healthDbTimeoutMs,
    statementTimeoutMs: config.healthDbTimeoutMs,
    queryTimeoutMs: config.healthDbTimeoutMs,
    onError: (error) => {
      logger.warn({
        event: 'database_pool_error',
        errorType: error.name,
        message: redactor.redact(error.message),
      });
    },
  });
  let mockIdp: MockIdp | null = null;
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  try {
    await checkDatabase(pool, config.healthDbTimeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'database connectivity check failed';
    logger.error({
      event: 'startup_database_error',
      errorType: error instanceof Error ? error.name : 'Error',
      message: redactor.redact(message),
    });
    await closePool(pool);
    process.exit(1);
  }

  try {
    if (config.ssoMode === 'mock') {
      mockIdp = await createMockIdp(config.mockSsoIssuer, config.mockSsoPort, config.mockSsoHost);
      await mockIdp.listen();
    }

    const services = createAppServices({ config, pool });
    app = await buildApp({ config, ...services, logger, redactor });
    await app.listen({ port: config.port, host: '0.0.0.0' });
    logger.info({
      event: 'startup_complete',
      appEnv: config.appEnv,
      port: config.port,
      ssoMode: config.ssoMode,
      mockSsoIssuer: config.ssoMode === 'mock' ? config.mockSsoIssuer : undefined,
    });
  } catch (error) {
    logger.error({
      event: 'startup_error',
      errorType: error instanceof Error ? error.name : 'Error',
      message: redactor.redact(error instanceof Error ? error.message : 'startup failed'),
    });
    if (app) await app.close();
    if (mockIdp) await mockIdp.close();
    await closePool(pool);
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ event: 'shutdown_start', signal });
    if (app) await app.close();
    if (mockIdp) await mockIdp.close();
    await closePool(pool);
    logger.info({ event: 'shutdown_complete', signal });
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

await main();
