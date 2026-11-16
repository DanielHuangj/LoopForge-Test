import type { FastifyInstance } from 'fastify';
import { AppError } from '../../errors.js';

export function registerTestRoutes(app: FastifyInstance): void {
  app.get('/api/v1/test/business-error', async () => {
    throw new AppError('DEMO_CONFLICT');
  });
  app.get('/api/v1/test/uncaught-error', async () => {
    throw new Error('uncaught test failure');
  });
}
