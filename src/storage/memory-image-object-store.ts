import type { ImageMimeType } from '../domain/dish-models.js';
import type { ImageObjectStore, StoredObject } from '../ports/image-object-store.js';

export class MemoryImageObjectStore implements ImageObjectStore {
  private readonly objects = new Map<string, { body: Buffer; mimeType: ImageMimeType }>();

  async put(key: string, body: Buffer, mimeType: ImageMimeType): Promise<void> {
    this.objects.set(key, { body: Buffer.from(body), mimeType });
  }

  async get(key: string, mimeType: ImageMimeType): Promise<StoredObject> {
    const object = this.objects.get(key);
    if (!object) throw new Error('object not found');
    return { body: Buffer.from(object.body), mimeType: object.mimeType ?? mimeType };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }
}
