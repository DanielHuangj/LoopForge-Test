import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { ObjectStorageConfig } from '../src/config.js';
import { S3ImageObjectStore } from '../src/storage/s3-image-object-store.js';

const endpoint = process.env.OBJECT_STORAGE_TEST_ENDPOINT;
const enabled = Boolean(endpoint);

function testConfig(): ObjectStorageConfig {
  return {
    driver: 's3',
    endpoint,
    region: process.env.OBJECT_STORAGE_TEST_REGION ?? 'us-east-1',
    bucket: process.env.OBJECT_STORAGE_TEST_BUCKET ?? 'loopforge-dish-images',
    accessKeyId: process.env.OBJECT_STORAGE_TEST_ACCESS_KEY_ID,
    secretAccessKey: process.env.OBJECT_STORAGE_TEST_SECRET_ACCESS_KEY,
    forcePathStyle: true,
  };
}

function directObjectUrl(config: ObjectStorageConfig, key: string): string {
  return `${config.endpoint!.replace(/\/$/, '')}/${config.bucket}/${key}`;
}

describe.skipIf(!enabled)('real private object storage integration', () => {
  it('keeps direct object URLs private while the application adapter can read and delete', async () => {
    const config = testConfig();
    const store = new S3ImageObjectStore(config);
    const key = `dish-images/integration/${randomUUID()}.png`;
    const body = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();

    try {
      await store.put(key, body, 'image/png');

      const anonymous = await fetch(directObjectUrl(config, key));
      expect(anonymous.status).not.toBe(200);
      expect(await anonymous.text()).not.toContain(body.toString('base64'));

      await expect(store.get(key, 'image/png')).resolves.toEqual({ body, mimeType: 'image/png' });
    } finally {
      await store.delete(key).catch(() => undefined);
    }

    await expect(store.get(key, 'image/png')).rejects.toBeInstanceOf(Error);
  });
});
