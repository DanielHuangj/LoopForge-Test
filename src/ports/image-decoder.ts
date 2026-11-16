import type { ImageMimeType } from '../domain/dish-models.js';

export interface DecodedImage {
  mimeType: ImageMimeType;
}

export interface ImageDecoder {
  hasCapacity(): boolean;
  decode(body: Buffer): Promise<DecodedImage>;
  close(): Promise<void>;
}
