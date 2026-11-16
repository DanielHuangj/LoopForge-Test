import type {
  CreateDishInput,
  CurrentImage,
  DishRecord,
  SaleStatus,
  StoredImage,
  UpdateDishInput,
} from '../domain/dish-models.js';

export interface DishStore {
  create(dishId: string, input: CreateDishInput, actorUserId: string): Promise<DishRecord>;
  list(): Promise<DishRecord[]>;
  findById(dishId: string): Promise<DishRecord | null>;
  update(dishId: string, input: UpdateDishInput, actorUserId: string): Promise<DishRecord>;
  setSaleStatus(dishId: string, status: SaleStatus, actorUserId: string): Promise<DishRecord>;
  delete(dishId: string): Promise<{ deleted: DishRecord }>;
  replaceImage(dishId: string, image: StoredImage, actorUserId: string): Promise<{ dish: DishRecord; oldObjectKey: string | null }>;
  removeImage(dishId: string, actorUserId: string): Promise<{ dish: DishRecord; oldObjectKey: string | null }>;
  findCurrentImage(imageId: string): Promise<CurrentImage | null>;
}
