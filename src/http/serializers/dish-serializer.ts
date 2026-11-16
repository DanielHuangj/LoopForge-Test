import { LosslessNumber, stringify } from 'lossless-json';
import type { DishDto, DishRecord } from '../../domain/dish-models.js';

type SerializableDishDto = Omit<DishDto, 'reference_price_cents'> & {
  reference_price_cents: LosslessNumber;
};

function serializeRecord(record: DishRecord): SerializableDishDto {
  return {
    dish_id: record.dishId,
    name: record.name,
    category: record.category,
    description: record.description,
    reference_price_cents: new LosslessNumber(record.referencePriceCents),
    sale_status: record.saleStatus,
    image_url: record.imageUrl,
    image_placeholder: record.imageUrl === null,
    image_mime_type: record.imageMimeType,
    image_size_bytes: record.imageSizeBytes,
    image_updated_at: record.imageUpdatedAt?.toISOString() ?? null,
    image_updated_by: record.imageUpdatedBy,
    created_at: record.createdAt.toISOString(),
    created_by: record.createdBy,
    updated_at: record.updatedAt.toISOString(),
    updated_by: record.updatedBy,
  };
}

export function serializeDish(record: DishRecord): string {
  return stringify(serializeRecord(record)) ?? '{}';
}

export function serializeDishList(records: DishRecord[]): string {
  return stringify({ items: records.map(serializeRecord) }) ?? '{"items":[]}';
}
