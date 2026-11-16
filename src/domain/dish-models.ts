export type SaleStatus = 'ON_SALE' | 'OFF_SHELF';
export type ImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';
export type PriceCentsText = string;

export const MAX_IMAGE_BYTES = 5_242_880;
export const MAX_PRICE_CENTS = '9223372036854775807';

export interface DishRecord {
  dishId: string;
  name: string;
  category: string;
  description: string | null;
  referencePriceCents: PriceCentsText;
  saleStatus: SaleStatus;
  imageUrl: string | null;
  imageObjectKey: string | null;
  imageMimeType: ImageMimeType | null;
  imageSizeBytes: number | null;
  imageUpdatedAt: Date | null;
  imageUpdatedBy: string | null;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface CreateDishInput {
  name: string;
  category: string;
  description: string | null;
  referencePriceCents: PriceCentsText;
}

export interface UpdateDishInput {
  name?: string;
  category?: string;
  description?: string | null;
  referencePriceCents?: PriceCentsText;
}

export interface StoredImage {
  imageId: string;
  imageUrl: string;
  objectKey: string;
  mimeType: ImageMimeType;
  sizeBytes: number;
}

export interface CurrentImage {
  dishId: string;
  objectKey: string;
  mimeType: ImageMimeType;
  sizeBytes: number;
}

export interface DishDto {
  dish_id: string;
  name: string;
  category: string;
  description: string | null;
  reference_price_cents: PriceCentsText;
  sale_status: SaleStatus;
  image_url: string | null;
  image_placeholder: boolean;
  image_mime_type: ImageMimeType | null;
  image_size_bytes: number | null;
  image_updated_at: string | null;
  image_updated_by: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}
