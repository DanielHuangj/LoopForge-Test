import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { AuthService } from '../../domain/auth-service.js';
import type { DishService } from '../../domain/dish-service.js';
import { serializeDish, serializeDishList } from '../serializers/dish-serializer.js';

function requireAdmin(auth: AuthService, config: AppConfig) {
  return async (request: FastifyRequest): Promise<void> => {
    request.authUser = await auth.authenticateFor(request.cookies[config.sessionCookieName], 'MENU_ADMIN');
  };
}

function sendDish(reply: FastifyReply, value: string, statusCode = 200) {
  return reply.code(statusCode).type('application/json; charset=utf-8').send(value);
}

function paramsOf(request: FastifyRequest): { dish_id: string } {
  return request.params as { dish_id: string };
}

export function registerDishRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  dishes: DishService,
): void {
  const onRequest = requireAdmin(auth, config);

  app.get('/api/v1/admin/dishes', { onRequest }, async (_request, reply) => {
    return sendDish(reply, serializeDishList(await dishes.list()));
  });

  app.post('/api/v1/admin/dishes', { onRequest }, async (request, reply) => {
    const user = request.authUser!;
    const dish = await dishes.create(request.body, user.userId);
    return sendDish(reply, serializeDish(dish), 201);
  });

  app.get('/api/v1/admin/dishes/:dish_id', { onRequest }, async (request, reply) => {
    const dish = await dishes.get(paramsOf(request).dish_id);
    return sendDish(reply, serializeDish(dish));
  });

  app.patch('/api/v1/admin/dishes/:dish_id', { onRequest }, async (request, reply) => {
    const user = request.authUser!;
    const dish = await dishes.update(paramsOf(request).dish_id, request.body, user.userId);
    return sendDish(reply, serializeDish(dish));
  });

  app.put('/api/v1/admin/dishes/:dish_id/sale_status', { onRequest }, async (request, reply) => {
    const user = request.authUser!;
    const dish = await dishes.setSaleStatus(paramsOf(request).dish_id, request.body, user.userId);
    return sendDish(reply, serializeDish(dish));
  });

  app.delete('/api/v1/admin/dishes/:dish_id', { onRequest }, async (request, reply) => {
    await dishes.delete(paramsOf(request).dish_id);
    return reply.code(204).send();
  });
}
