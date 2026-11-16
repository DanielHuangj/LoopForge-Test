import type pg from 'pg';
import type { Pool } from 'pg';
import { AppError } from '../../errors.js';
import type {
  CreateDishInput,
  CurrentImage,
  DishRecord,
  ImageMimeType,
  SaleStatus,
  StoredImage,
  UpdateDishInput,
} from '../../domain/dish-models.js';
import type { DishStore } from '../../ports/dish-store.js';
import { withTransaction } from '../transaction.js';

interface DishRow {
  dish_id: string;
  name: string;
  category: string;
  description: string | null;
  reference_price_cents: string;
  sale_status: SaleStatus;
  image_url: string | null;
  image_object_key: string | null;
  image_mime_type: ImageMimeType | null;
  image_size_bytes: number | null;
  image_updated_at: Date | null;
  image_updated_by: string | null;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
}

interface CurrentImageRow {
  dish_id: string;
  image_object_key: string;
  image_mime_type: ImageMimeType;
  image_size_bytes: number;
}

const DISH_COLUMNS = `
  dish_id, name, category, description, reference_price_cents::text AS reference_price_cents,
  sale_status, image_url, image_object_key, image_mime_type, image_size_bytes,
  image_updated_at, image_updated_by, created_at, created_by, updated_at, updated_by`;

function mapRow(row: DishRow): DishRecord {
  return {
    dishId: row.dish_id,
    name: row.name,
    category: row.category,
    description: row.description,
    referencePriceCents: row.reference_price_cents,
    saleStatus: row.sale_status,
    imageUrl: row.image_url,
    imageObjectKey: row.image_object_key,
    imageMimeType: row.image_mime_type,
    imageSizeBytes: row.image_size_bytes,
    imageUpdatedAt: row.image_updated_at,
    imageUpdatedBy: row.image_updated_by,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

async function lockDish(client: pg.PoolClient, dishId: string): Promise<DishRecord | null> {
  const result = await client.query<DishRow>(
    `SELECT ${DISH_COLUMNS} FROM dish WHERE dish_id = $1 FOR UPDATE`,
    [dishId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

function isForeignKeyViolation(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23503') {
    return true;
  }
  return error instanceof Error && /foreign key constraint|violates RESTRICT setting/i.test(error.message);
}

export class PostgresDishRepository implements DishStore {
  constructor(private readonly pool: Pool) {}

  async create(dishId: string, input: CreateDishInput, actorUserId: string): Promise<DishRecord> {
    const result = await this.pool.query<DishRow>(
      `WITH t AS (SELECT clock_timestamp() AS now)
       INSERT INTO dish (
         dish_id, name, category, description, reference_price_cents,
         sale_status, created_at, created_by, updated_at, updated_by
       )
       SELECT $1, $2, $3, $4, $5::bigint,
              'OFF_SHELF', t.now, $6, t.now, $6
         FROM t
       RETURNING ${DISH_COLUMNS}`,
      [dishId, input.name, input.category, input.description, input.referencePriceCents, actorUserId],
    );
    return mapRow(result.rows[0]!);
  }

  async list(): Promise<DishRecord[]> {
    const result = await this.pool.query<DishRow>(
      `SELECT ${DISH_COLUMNS} FROM dish ORDER BY created_at DESC, dish_id DESC`,
    );
    return result.rows.map(mapRow);
  }

  async findById(dishId: string): Promise<DishRecord | null> {
    const result = await this.pool.query<DishRow>(
      `SELECT ${DISH_COLUMNS} FROM dish WHERE dish_id = $1`,
      [dishId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async update(dishId: string, input: UpdateDishInput, actorUserId: string): Promise<DishRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await lockDish(client, dishId);
      if (!current) throw new AppError('NOT_FOUND');

      const sets: string[] = [];
      const params: unknown[] = [];
      if (input.name !== undefined) {
        params.push(input.name);
        sets.push(`name = $${params.length}`);
      }
      if (input.category !== undefined) {
        params.push(input.category);
        sets.push(`category = $${params.length}`);
      }
      if (input.description !== undefined) {
        params.push(input.description);
        sets.push(`description = $${params.length}`);
      }
      if (input.referencePriceCents !== undefined) {
        params.push(input.referencePriceCents);
        sets.push(`reference_price_cents = $${params.length}::bigint`);
      }
      params.push(actorUserId);
      sets.push('updated_at = t.now', `updated_by = $${params.length}`);
      params.push(dishId);

      const result = await client.query<DishRow>(
        `WITH t AS (SELECT clock_timestamp() AS now)
         UPDATE dish SET ${sets.join(', ')} FROM t
          WHERE dish_id = $${params.length}
         RETURNING ${DISH_COLUMNS}`,
        params,
      );
      return mapRow(result.rows[0]!);
    });
  }

  async setSaleStatus(dishId: string, status: SaleStatus, actorUserId: string): Promise<DishRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await lockDish(client, dishId);
      if (!current) throw new AppError('NOT_FOUND');
      const result = await client.query<DishRow>(
        `WITH t AS (SELECT clock_timestamp() AS now)
         UPDATE dish SET sale_status = $2, updated_at = t.now, updated_by = $3 FROM t
          WHERE dish_id = $1
         RETURNING ${DISH_COLUMNS}`,
        [dishId, status, actorUserId],
      );
      return mapRow(result.rows[0]!);
    });
  }

  async delete(dishId: string): Promise<{ deleted: DishRecord }> {
    return withTransaction(this.pool, async (client) => {
      const current = await lockDish(client, dishId);
      if (!current) throw new AppError('NOT_FOUND');
      try {
        await client.query('DELETE FROM dish WHERE dish_id = $1', [dishId]);
      } catch (error) {
        if (isForeignKeyViolation(error)) throw new AppError('DISH_IN_USE');
        throw error;
      }
      return { deleted: current };
    });
  }

  async replaceImage(
    dishId: string,
    image: StoredImage,
    actorUserId: string,
  ): Promise<{ dish: DishRecord; oldObjectKey: string | null }> {
    return withTransaction(this.pool, async (client) => {
      const current = await lockDish(client, dishId);
      if (!current) throw new AppError('NOT_FOUND');
      const result = await client.query<DishRow>(
        `WITH t AS (SELECT clock_timestamp() AS now)
         UPDATE dish
            SET image_url = $2,
                image_object_key = $3,
                image_mime_type = $4,
                image_size_bytes = $5,
                image_updated_at = t.now,
                image_updated_by = $6,
                updated_at = t.now,
                updated_by = $6
           FROM t
          WHERE dish_id = $1
         RETURNING ${DISH_COLUMNS}`,
        [dishId, image.imageUrl, image.objectKey, image.mimeType, image.sizeBytes, actorUserId],
      );
      return { dish: mapRow(result.rows[0]!), oldObjectKey: current.imageObjectKey };
    });
  }

  async removeImage(
    dishId: string,
    actorUserId: string,
  ): Promise<{ dish: DishRecord; oldObjectKey: string | null }> {
    return withTransaction(this.pool, async (client) => {
      const current = await lockDish(client, dishId);
      if (!current) throw new AppError('NOT_FOUND');
      if (!current.imageObjectKey) return { dish: current, oldObjectKey: null };

      const result = await client.query<DishRow>(
        `WITH t AS (SELECT clock_timestamp() AS now)
         UPDATE dish
            SET image_url = NULL,
                image_object_key = NULL,
                image_mime_type = NULL,
                image_size_bytes = NULL,
                image_updated_at = t.now,
                image_updated_by = $2,
                updated_at = t.now,
                updated_by = $2
           FROM t
          WHERE dish_id = $1
         RETURNING ${DISH_COLUMNS}`,
        [dishId, actorUserId],
      );
      return { dish: mapRow(result.rows[0]!), oldObjectKey: current.imageObjectKey };
    });
  }

  async findCurrentImage(imageId: string): Promise<CurrentImage | null> {
    const result = await this.pool.query<CurrentImageRow>(
      `SELECT dish_id, image_object_key, image_mime_type, image_size_bytes
         FROM dish
        WHERE image_url = $1`,
      [`/api/v1/dish-images/${imageId}`],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      dishId: row.dish_id,
      objectKey: row.image_object_key,
      mimeType: row.image_mime_type,
      sizeBytes: row.image_size_bytes,
    };
  }
}
