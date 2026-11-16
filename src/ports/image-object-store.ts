import type { ImageMimeType } from '../domain/dish-models.js';

export interface StoredObject {
  body: Buffer;
  mimeType: ImageMimeType;
}

export interface ImageObjectStore {
  put(key: string, body: Buffer, mimeType: ImageMimeType): Promise<void>;
  get(key: string, mimeType: ImageMimeType): Promise<StoredObject>;
  delete(key: string): Promise<void>;
}
