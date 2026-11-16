import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import type { ImageObjectStore } from '../ports/image-object-store.js';
import type { DishStore } from '../ports/dish-store.js';
import type { DishRecord } from './dish-models.js';
import { assertUuidV4, parseCreateDish, parseSaleStatus, parseUpdateDish } from './dish-validation.js';

export class DishService {
  constructor(
    private readonly dishes: DishStore,
    private readonly objects: ImageObjectStore,
  ) {}

  async create(body: unknown, actorUserId: string): Promise<DishRecord> {
    const input = parseCreateDish(body);
    return this.dishes.create(randomUUID(), input, actorUserId);
  }

  async list(): Promise<DishRecord[]> {
    return this.dishes.list();
  }

  async get(dishId: string): Promise<DishRecord> {
    assertUuidV4(dishId, 'dish_id');
    const dish = await this.dishes.findById(dishId);
    if (!dish) throw new AppError('NOT_FOUND');
    return dish;
  }

  async update(dishId: string, body: unknown, actorUserId: string): Promise<DishRecord> {
    assertUuidV4(dishId, 'dish_id');
    return this.dishes.update(dishId, parseUpdateDish(body), actorUserId);
  }

  async setSaleStatus(dishId: string, body: unknown, actorUserId: string): Promise<DishRecord> {
    assertUuidV4(dishId, 'dish_id');
    return this.dishes.setSaleStatus(dishId, parseSaleStatus(body), actorUserId);
  }

  async delete(dishId: string): Promise<void> {
    assertUuidV4(dishId, 'dish_id');
    const { deleted } = await this.dishes.delete(dishId);
    if (deleted.imageObjectKey) {
      await this.objects.delete(deleted.imageObjectKey).catch(() => undefined);
    }
  }
}

export class DishAvailability {
  constructor(private readonly dishes: DishStore) {}

  async assertCanJoinNewMenu(dishId: string): Promise<void> {
    const dish = await this.dishes.findById(dishId);
    if (!dish) throw new AppError('NOT_FOUND');
    if (dish.saleStatus !== 'ON_SALE') throw new AppError('DISH_OFF_SHELF');
  }
}
