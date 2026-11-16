import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectStorageConfig } from '../config.js';
import type { ImageMimeType } from '../domain/dish-models.js';
import type { ImageObjectStore, StoredObject } from '../ports/image-object-store.js';

export class S3ImageObjectStore implements ImageObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ObjectStorageConfig) {
    if (!config.bucket) throw new Error('object storage bucket is not configured');
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
          : undefined,
    });
  }

  async put(key: string, body: Buffer, mimeType: ImageMimeType): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: mimeType,
        ContentLength: body.length,
      }),
    );
  }

  async get(key: string, mimeType: ImageMimeType): Promise<StoredObject> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
    if (!response.Body) throw new Error('object body is missing');
    const body = Buffer.from(await response.Body.transformToByteArray());
    return { body, mimeType };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
