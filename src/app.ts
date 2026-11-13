import { randomUUID } from 'node:crypto';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import cookie from '@fastify/cookie';
import type { Logger } from 'pino';
import { AppError } from './errors.js';
import type { AppConfig } from './config.js';
import { createLogger, createRedactor, type Redactor } from './logger.js';
import type { AppServices } from './composition/container.js';
import { registerTraceAndAccessLog } from './http/access-log.js';
import { registerErrorHandler } from './http/error-handler.js';
import {
  PROTECTED_PATHS,
  PUBLIC_PATHS,
  TEST_PATHS,
  isTestPrefix,
} from './http/known-paths.js';
import { registerAuthRoutes } from './http/routes/auth-routes.js';
import { registerProbeRoutes } from './http/routes/probe-routes.js';
import { registerHealthRoutes } from './http/routes/health-routes.js';
import { registerTestRoutes } from './http/routes/test-routes.js';

export interface BuildAppOptions extends AppServices {
  config: AppConfig;
  logger?: Logger;
  redactor?: Redactor;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, auth, sessions, healthCheck } = options;
  const redactor =
    options.redactor ??
    createRedactor([config.databaseUrl, config.sso.clientSecret, config.sessionSecret]);
  const logger = options.logger ?? createLogger(config.logLevel);

  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1_048_576,
  });

  await app.register(cookie);

  registerTraceAndAccessLog(app, logger);
  registerErrorHandler(app, logger, redactor);

  registerHealthRoutes(app, healthCheck);
  registerAuthRoutes(app, config, auth, sessions);
  registerProbeRoutes(app, config, auth);
  if (config.appEnv === 'test') registerTestRoutes(app);

  const authenticateForRouting = async (request: FastifyRequest): Promise<void> => {
    request.authUser = await auth.authenticate(request.cookies[config.sessionCookieName]);
  };

  const authorizeForRouting = async (request: FastifyRequest): Promise<void> => {
    request.authUser = await auth.authenticateFor(request.cookies[config.sessionCookieName], 'AUTHENTICATED');
  };

  app.setNotFoundHandler(async (request) => {
    const pathname = request.url.split('?')[0] ?? request.url;
    const isKnownPublic = PUBLIC_PATHS.has(pathname);
    const isKnownProtected = PROTECTED_PATHS.has(pathname);
    const isKnownTest = TEST_PATHS.has(pathname);

    if (isTestPrefix(pathname) && config.appEnv !== 'test') {
      throw new AppError('NOT_FOUND');
    }

    if (isKnownPublic || isKnownProtected || (isKnownTest && config.appEnv === 'test')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        if (isKnownProtected) await authenticateForRouting(request);
        throw new AppError('METHOD_NOT_ALLOWED');
      }
    }

    if (pathname.startsWith('/api/v1/')) {
      await authorizeForRouting(request);
    }

    throw new AppError('NOT_FOUND');
  });

  return app;
}
