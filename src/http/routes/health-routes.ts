import type { FastifyInstance } from 'fastify';
import { AppError } from '../../errors.js';

export function registerHealthRoutes(app: FastifyInstance, healthCheck: () => Promise<void>): void {
  app.get('/healthz', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      await healthCheck();
      return reply.send({ status: 'UP' });
    } catch {
      throw new AppError('SERVICE_UNAVAILABLE', { extra: { status: 'DOWN' } });
    }
  });
}
