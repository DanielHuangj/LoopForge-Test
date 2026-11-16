import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { safePath } from '../logger.js';

export function registerTraceAndAccessLog(app: FastifyInstance, logger: Logger): void {
  app.addHook('onRequest', async (request, reply) => {
    request.startTimeNs = process.hrtime.bigint();
    reply.header('X-Trace-Id', request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    const durationMs = request.startTimeNs
      ? Number(process.hrtime.bigint() - request.startTimeNs) / 1_000_000
      : 0;
    const entry: Record<string, unknown> = {
      event: 'http_access',
      traceId: request.id,
      method: request.method,
      path: safePath(request.url),
      status: reply.statusCode,
      durationMs: Math.round(durationMs * 1000) / 1000,
    };
    if (request.authUser) entry.userId = request.authUser.userId;
    logger.info(entry);
  });
}
