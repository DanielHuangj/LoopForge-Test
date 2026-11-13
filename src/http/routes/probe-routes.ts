import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { AuthService } from '../../domain/auth-service.js';
import type { Role } from '../../domain/models.js';

function requireRole(auth: AuthService, config: AppConfig, role: Role) {
  return async (request: FastifyRequest): Promise<void> => {
    request.authUser = await auth.authenticateFor(request.cookies[config.sessionCookieName], role);
  };
}

export function registerProbeRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
): void {
  app.get(
    '/api/v1/employee/auth-check',
    { preHandler: requireRole(auth, config, 'EMPLOYEE') },
    async (_request, reply: FastifyReply) => reply.send({ allowed: true }),
  );
  app.get(
    '/api/v1/admin/auth-check',
    { preHandler: requireRole(auth, config, 'MENU_ADMIN') },
    async (_request, reply: FastifyReply) => reply.send({ allowed: true }),
  );
}
