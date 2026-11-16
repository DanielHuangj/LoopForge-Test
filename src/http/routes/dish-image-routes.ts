import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import type { AuthService } from '../../domain/auth-service.js';
import { assertCanReadDishImage, assertCanWriteDishImage } from '../../domain/dish-authorization.js';
import type { DishImageService } from '../../domain/dish-image-service.js';
import type { ImageDecoder } from '../../ports/image-decoder.js';
import { serializeDish } from '../serializers/dish-serializer.js';

function imageWriteAuthorizer(auth: AuthService, config: AppConfig, decoder: ImageDecoder) {
  return async (request: FastifyRequest): Promise<void> => {
    const user = await auth.authenticate(request.cookies[config.sessionCookieName]);
    request.authUser = user;
    assertCanWriteDishImage(user);
    if (!decoder.hasCapacity()) {
      throw new AppError('SERVICE_UNAVAILABLE', { message: '图片处理服务暂不可用' });
    }
  };
}

function imageWriteAuth(auth: AuthService, config: AppConfig) {
  return async (request: FastifyRequest): Promise<void> => {
    const user = await auth.authenticate(request.cookies[config.sessionCookieName]);
    request.authUser = user;
    assertCanWriteDishImage(user);
  };
}

function imageReadAuth(auth: AuthService, config: AppConfig) {
  return async (request: FastifyRequest): Promise<void> => {
    const user = await auth.authenticateFor(request.cookies[config.sessionCookieName], 'AUTHENTICATED');
    request.authUser = user;
    assertCanReadDishImage(user);
  };
}

function invalidImage(message: string): AppError {
  return new AppError('INVALID_IMAGE', { message, details: [{ field: 'file', message }] });
}

function tooLarge(): AppError {
  return new AppError('IMAGE_TOO_LARGE', {
    message: '图片不能超过 5 MB',
    details: [{ field: 'file', message: '图片不能超过 5 MB' }],
  });
}

function mapMultipartError(error: unknown): never {
  if (error instanceof AppError) throw error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_ERR_CTP_BODY_TOO_LARGE') throw tooLarge();
  if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') throw invalidImage('文件数量必须为 1');
  if (code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
    throw invalidImage('图片上传必须使用 multipart/form-data 且包含一个文件');
  }
  if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') throw invalidImage('图片上传必须使用 multipart/form-data 且包含一个文件');
  if (code === 'FST_PREMATURE_CLOSE') throw invalidImage('图片内容损坏');
  throw invalidImage('图片上传必须使用 multipart/form-data 且包含一个文件');
}

function paramsOf(request: FastifyRequest): { dish_id: string; image_id?: string } {
  return request.params as { dish_id: string; image_id?: string };
}

export function registerDishImageRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  images: DishImageService,
  decoder: ImageDecoder,
): void {
  app.put(
    '/api/v1/admin/dishes/:dish_id/image',
    {
      bodyLimit: 16_777_216,
      onRequest: imageWriteAuthorizer(auth, config, decoder),
    },
    async (request, reply) => {
      if (!request.isMultipart()) {
        throw invalidImage('图片上传必须使用 multipart/form-data 且包含一个文件');
      }

      let fileBody: Buffer | null = null;
      let fileCount = 0;
      try {
        for await (const part of request.parts()) {
          if (part.type !== 'file') continue;
          if (part.fieldname !== 'file') throw invalidImage('文件数量必须为 1');
          fileCount += 1;
          if (fileCount > 1) throw invalidImage('文件数量必须为 1');
          fileBody = await part.toBuffer();
        }
      } catch (error) {
        mapMultipartError(error);
      }

      if (fileCount !== 1 || !fileBody) throw invalidImage('文件数量必须为 1');
      if (fileBody.length === 0) throw invalidImage('图片文件不能为空');
      if (fileBody.length > 5_242_880) throw tooLarge();

      const user = request.authUser!;
      const dish = await images.replace(paramsOf(request).dish_id, fileBody, user.userId);
      return sendDish(reply, serializeDish(dish));
    },
  );

  app.delete(
    '/api/v1/admin/dishes/:dish_id/image',
    { onRequest: imageWriteAuth(auth, config) },
    async (request, reply) => {
      const user = request.authUser!;
      const dish = await images.remove(paramsOf(request).dish_id, user.userId);
      return sendDish(reply, serializeDish(dish));
    },
  );

  app.get(
    '/api/v1/dish-images/:image_id',
    { onRequest: imageReadAuth(auth, config) },
    async (request, reply) => {
      const user = request.authUser!;
      const image = await images.read(paramsOf(request).image_id!, user);
      return reply
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Length', String(image.body.length))
        .type(image.mimeType)
        .send(image.body);
    },
  );
}

function sendDish(reply: FastifyReply, value: string) {
  return reply.type('application/json; charset=utf-8').send(value);
}
