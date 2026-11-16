import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import type { DishVisibilityStore } from '../ports/dish-visibility-store.js';
import type { DishStore } from '../ports/dish-store.js';
import type { ImageDecoder } from '../ports/image-decoder.js';
import type { ImageObjectStore } from '../ports/image-object-store.js';
import { hasRole } from './dish-authorization.js';
import {
  MAX_IMAGE_BYTES,
  type DishRecord,
  type ImageMimeType,
  type StoredImage,
} from './dish-models.js';
import { assertUuidV4 } from './dish-validation.js';
import type { UserRecord } from './models.js';
import { ImageDecodeError } from './image-decoder-pool.js';

function extensionFor(mimeType: ImageMimeType): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  return 'webp';
}

function mapDecodeError(error: unknown): never {
  if (error instanceof ImageDecodeError) {
    if (error.kind === 'resource') {
      throw new AppError('SERVICE_UNAVAILABLE', { message: '图片处理服务暂不可用' });
    }
    if (error.kind === 'unsupported') {
      throw new AppError('INVALID_IMAGE', {
        message: '仅支持 JPEG、PNG、WebP 图片',
        details: [{ field: 'file', message: '仅支持 JPEG、PNG、WebP 图片' }],
      });
    }
    throw new AppError('INVALID_IMAGE', {
      message: '图片内容损坏',
      details: [{ field: 'file', message: '图片内容损坏' }],
    });
  }
  throw new AppError('SERVICE_UNAVAILABLE', { message: '图片处理服务暂不可用' });
}

export class DishImageService {
  constructor(
    private readonly dishes: DishStore,
    private readonly objects: ImageObjectStore,
    private readonly decoder: ImageDecoder,
    private readonly visibility: DishVisibilityStore,
  ) {}

  async replace(dishId: string, body: Buffer, actorUserId: string): Promise<DishRecord> {
    assertUuidV4(dishId, 'dish_id');
    if (body.length === 0) {
      throw new AppError('INVALID_IMAGE', {
        message: '图片文件不能为空',
        details: [{ field: 'file', message: '图片文件不能为空' }],
      });
    }
    if (body.length > MAX_IMAGE_BYTES) {
      throw new AppError('IMAGE_TOO_LARGE', {
        message: '图片不能超过 5 MB',
        details: [{ field: 'file', message: '图片不能超过 5 MB' }],
      });
    }

    let decoded;
    try {
      decoded = await this.decoder.decode(body);
    } catch (error) {
      mapDecodeError(error);
    }

    const imageId = randomUUID();
    const objectKey = `dish-images/${dishId}/${imageId}.${extensionFor(decoded.mimeType)}`;
    const image: StoredImage = {
      imageId,
      imageUrl: `/api/v1/dish-images/${imageId}`,
      objectKey,
      mimeType: decoded.mimeType,
      sizeBytes: body.length,
    };

    try {
      await this.objects.put(objectKey, body, decoded.mimeType);
    } catch {
      throw new AppError('SERVICE_UNAVAILABLE');
    }

    let result: { dish: DishRecord; oldObjectKey: string | null };
    try {
      result = await this.dishes.replaceImage(dishId, image, actorUserId);
    } catch (error) {
      await this.objects.delete(objectKey).catch(() => undefined);
      throw error;
    }

    if (result.oldObjectKey) {
      await this.objects.delete(result.oldObjectKey).catch(() => undefined);
    }
    return result.dish;
  }

  async remove(dishId: string, actorUserId: string): Promise<DishRecord> {
    assertUuidV4(dishId, 'dish_id');
    const result = await this.dishes.removeImage(dishId, actorUserId);
    if (result.oldObjectKey) {
      await this.objects.delete(result.oldObjectKey).catch(() => undefined);
    }
    return result.dish;
  }

  async read(imageId: string, user: UserRecord): Promise<{ body: Buffer; mimeType: ImageMimeType }> {
    assertUuidV4(imageId, 'image_id');
    const image = await this.dishes.findCurrentImage(imageId);
    if (!image) throw new AppError('NOT_FOUND');

    if (!hasRole(user, 'MENU_ADMIN')) {
      if (!hasRole(user, 'EMPLOYEE') || !(await this.visibility.isVisibleToEmployee(user.userId, image.dishId))) {
        throw new AppError('FORBIDDEN');
      }
    }

    try {
      const stored = await this.objects.get(image.objectKey, image.mimeType);
      return { body: stored.body, mimeType: stored.mimeType };
    } catch {
      throw new AppError('SERVICE_UNAVAILABLE');
    }
  }
}
