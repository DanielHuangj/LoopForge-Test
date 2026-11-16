import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { execute, tableRows } from './helpers/database.js';
import {
  buildTestApp,
  createIdentityEnvironment,
  json,
  performLogin,
  type BuiltApp,
} from './helpers/harness.js';
import { MemoryImageObjectStore } from '../src/storage/memory-image-object-store.js';
import type { DishVisibilityStore } from '../src/ports/dish-visibility-store.js';
import type { ImageObjectStore } from '../src/ports/image-object-store.js';

let environment: Awaited<ReturnType<typeof createIdentityEnvironment>>;
let built: BuiltApp;
let adminCookie: string;
let employeeCookie: string;
let visibleDishIds: Set<string>;
let objectStore: MemoryImageObjectStore;

const PNG = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#ffffff' } })
  .png()
  .toBuffer();
const JPEG = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#000000' } })
  .jpeg()
  .toBuffer();
const WEBP = await sharp({ create: { width: 4, height: 2, channels: 3, background: '#ff0000' } })
  .webp()
  .toBuffer();
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

interface StoredDishRow {
  name: string;
  category: string;
  description: string | null;
  reference_price_cents: string;
  sale_status: string;
  image_url: string | null;
  image_object_key: string | null;
  image_mime_type: string | null;
  image_size_bytes: string | null;
  image_updated_at: string | null;
  image_updated_by: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

function auth(cookie: string) {
  return { cookie };
}

interface MultipartPart {
  name: string;
  body: Buffer | string;
  filename?: string;
  contentType?: string;
}

function multipart(parts: MultipartPart[]) {
  const boundary = `----loopforge-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`
      : `Content-Disposition: form-data; name="${part.name}"\r\n`;
    chunks.push(Buffer.from(`--${boundary}\r\n${disposition}`));
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    chunks.push(Buffer.from('\r\n'));
    chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function createDish(overrides: Record<string, unknown> = {}) {
  const response = await built.app.inject({
    method: 'POST',
    url: '/api/v1/admin/dishes',
    headers: auth(adminCookie),
    payload: {
      name: '宫保鸡丁',
      category: '热菜',
      description: '花生、鸡丁',
      reference_price_cents: 2800,
      ...overrides,
    },
  });
  expect(response.statusCode).toBe(201);
  return json(response) as Record<string, any>;
}

async function getDish(dishId: string): Promise<Record<string, any>> {
  const response = await built.app.inject({
    method: 'GET',
    url: `/api/v1/admin/dishes/${dishId}`,
    headers: auth(adminCookie),
  });
  expect(response.statusCode).toBe(200);
  return json(response) as Record<string, any>;
}

async function getStoredDish(dishId: string): Promise<StoredDishRow> {
  const [row] = await tableRows<StoredDishRow>(
    environment.database.url,
    `SELECT name, category, description, reference_price_cents::text AS reference_price_cents,
            sale_status, image_url, image_object_key, image_mime_type,
            image_size_bytes::text AS image_size_bytes,
            image_updated_at::text AS image_updated_at, image_updated_by,
            created_at::text AS created_at, created_by,
            updated_at::text AS updated_at, updated_by
       FROM dish
      WHERE dish_id = $1`,
    [dishId],
  );
  expect(row).toBeDefined();
  return row!;
}

async function waitForTimestampTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

function expectAuditAdvanced(before: Record<string, any>, after: Record<string, any>): void {
  expect(after.created_at).toBe(before.created_at);
  expect(after.created_by).toBe(before.created_by);
  expect(after.updated_by).toBe('u-admin-001');
  expect(Date.parse(after.updated_at)).toBeGreaterThan(Date.parse(before.updated_at));
}

beforeAll(async () => {
  environment = await createIdentityEnvironment();
});

afterAll(async () => {
  await environment?.close();
});

beforeEach(async () => {
  await environment.reset();
  visibleDishIds = new Set();
  objectStore = new MemoryImageObjectStore();
  const visibility: DishVisibilityStore = {
    async isVisibleToEmployee(_userId, dishId) {
      return visibleDishIds.has(dishId);
    },
  };
  built = await buildTestApp({
    databaseUrl: environment.database.url,
    mockIssuer: environment.mockIssuer,
    mockPort: Number(new URL(environment.mockIssuer).port),
    dishVisibility: visibility,
    imageObjectStore: objectStore,
  });
  adminCookie = (await performLogin(built, 'u-admin-001')).sessionCookiePair;
  employeeCookie = (await performLogin(built, 'u-emp-001')).sessionCookiePair;
});

afterEach(async () => {
  await built?.close();
});

describe('dish API', () => {
  it('enforces authentication, admin role and image-write error precedence', async () => {
    const anonymous = await built.app.inject({ method: 'GET', url: '/api/v1/admin/dishes' });
    expect(anonymous.statusCode).toBe(401);
    expect(json(anonymous).code).toBe('UNAUTHENTICATED');

    const employeeList = await built.app.inject({
      method: 'GET',
      url: '/api/v1/admin/dishes',
      headers: auth(employeeCookie),
    });
    expect(employeeList.statusCode).toBe(403);
    expect(json(employeeList).code).toBe('FORBIDDEN');

    const dish = await createDish();
    const oversized = multipart([
      { name: 'file', filename: 'large.png', contentType: 'image/png', body: Buffer.alloc(5_242_881, 1) },
    ]);
    const employeeWrite = await built.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/dishes/${dish.dish_id}/image`,
      headers: { ...auth(employeeCookie), ...oversized.headers },
      payload: oversized.payload,
    });
    expect(employeeWrite.statusCode).toBe(403);
    expect(json(employeeWrite).code).toBe('IMAGE_FORBIDDEN');
  });

  it('creates, lists, edits and switches sale status while preserving off-shelf default', async () => {
    const created = await createDish({ name: '  宫保鸡丁  ', category: ' 热菜 ', sale_status: 'ON_SALE' });
    expect(created).toMatchObject({
      name: '宫保鸡丁',
      category: '热菜',
      description: '花生、鸡丁',
      reference_price_cents: 2800,
      sale_status: 'OFF_SHELF',
      image_url: null,
      image_placeholder: true,
      image_updated_at: null,
      image_updated_by: null,
      created_by: 'u-admin-001',
      updated_by: 'u-admin-001',
    });
    expect(created.dish_id).toMatch(/^[0-9a-f-]{36}$/);

    const list = await built.app.inject({
      method: 'GET',
      url: '/api/v1/admin/dishes',
      headers: auth(adminCookie),
    });
    expect(list.statusCode).toBe(200);
    expect((json(list) as any).items).toHaveLength(1);

    await waitForTimestampTick();
    const patched = await built.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/dishes/${created.dish_id}`,
      headers: auth(adminCookie),
      payload: { name: '微辣鸡丁', description: '   ', reference_price_cents: 3000 },
    });
    expect(patched.statusCode).toBe(200);
    const patchedDish = json(patched) as Record<string, any>;
    expect(patchedDish).toMatchObject({
      name: '微辣鸡丁',
      description: null,
      reference_price_cents: 3000,
      sale_status: 'OFF_SHELF',
    });
    expectAuditAdvanced(created, patchedDish);

    await waitForTimestampTick();
    const onSale = await built.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/dishes/${created.dish_id}/sale_status`,
      headers: auth(adminCookie),
      payload: { sale_status: 'ON_SALE' },
    });
    expect(onSale.statusCode).toBe(200);
    const onSaleDish = json(onSale) as Record<string, any>;
    expect(onSaleDish.sale_status).toBe('ON_SALE');
    expectAuditAdvanced(patchedDish, onSaleDish);

    await waitForTimestampTick();
    const repeatedOnSale = await built.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/dishes/${created.dish_id}/sale_status`,
      headers: auth(adminCookie),
      payload: { sale_status: 'ON_SALE' },
    });
    expect(repeatedOnSale.statusCode).toBe(200);
    const repeatedOnSaleDish = json(repeatedOnSale) as Record<string, any>;
    expect(repeatedOnSaleDish.sale_status).toBe('ON_SALE');
    expectAuditAdvanced(onSaleDish, repeatedOnSaleDish);

    const unknown = await built.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/dishes/${created.dish_id}`,
      headers: auth(adminCookie),
      payload: { sale_status: 'OFF_SHELF' },
    });
    expect(unknown.statusCode).toBe(422);
    expect(json(unknown)).toMatchObject({
      code: 'DISH_INVALID',
      details: [{ field: 'sale_status' }],
    });
    expect(await getDish(created.dish_id)).toEqual(repeatedOnSaleDish);

    const invalidStatus = await built.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/dishes/${created.dish_id}/sale_status`,
      headers: auth(adminCookie),
      payload: { sale_status: 'LOCKED' },
    });
    expect(invalidStatus.statusCode).toBe(422);
    expect(json(invalidStatus)).toMatchObject({
      code: 'DISH_INVALID',
      details: [{ field: 'sale_status' }],
    });
    expect(await getDish(created.dish_id)).toEqual(repeatedOnSaleDish);
  });

  it('validates names and exact BIGINT price tokens without precision loss', async () => {
    for (const payload of [
      { name: '', category: '热菜', reference_price_cents: 1 },
      { name: 'x'.repeat(61), category: '热菜', reference_price_cents: 1 },
      { name: '菜品', category: '热菜', reference_price_cents: 0 },
      { name: '菜品', category: '热菜', reference_price_cents: -1 },
      { name: '菜品', category: '热菜', reference_price_cents: '2800' },
      { name: '菜品', category: '热菜', reference_price_cents: null },
    ]) {
      const response = await built.app.inject({
        method: 'POST',
        url: '/api/v1/admin/dishes',
        headers: auth(adminCookie),
        payload,
      });
      expect(response.statusCode).toBe(422);
      expect(json(response).code).toBe('DISH_INVALID');
    }

    const tooLarge = await built.app.inject({
      method: 'POST',
      url: '/api/v1/admin/dishes',
      headers: { ...auth(adminCookie), 'content-type': 'application/json' },
      payload: '{"name":"菜品","category":"热菜","reference_price_cents":9223372036854775808}',
    });
    expect(tooLarge.statusCode).toBe(422);
    expect(json(tooLarge).code).toBe('DISH_INVALID');

    const maxPrice = await built.app.inject({
      method: 'POST',
      url: '/api/v1/admin/dishes',
      headers: { ...auth(adminCookie), 'content-type': 'application/json' },
      payload: '{"name":"最大价格","category":"热菜","reference_price_cents":9223372036854775807}',
    });
    expect(maxPrice.statusCode).toBe(201);
    expect(maxPrice.body).toContain('"reference_price_cents":9223372036854775807');
    expect(maxPrice.body).not.toContain('"reference_price_cents":"');

    const stored = await tableRows<{ value: string }>(
      environment.database.url,
      "SELECT reference_price_cents::text AS value FROM dish WHERE name = '最大价格'",
    );
    expect(stored).toEqual([{ value: '9223372036854775807' }]);
  });

  it('uploads, authorizes, replaces and removes a single private image', async () => {
    const dish = await createDish();
    const upload = multipart([
      { name: 'file', filename: 'dish.png', contentType: 'image/png', body: PNG },
    ]);
    const uploaded = await built.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/dishes/${dish.dish_id}/image`,
      headers: { ...auth(adminCookie), ...upload.headers },
      payload: upload.payload,
    });
    expect(uploaded.statusCode).toBe(200);
    const firstImage = json(uploaded) as Record<string, any>;
    expect(firstImage).toMatchObject({
      image_placeholder: false,
      image_mime_type: 'image/png',
      image_size_bytes: PNG.length,
      image_updated_by: 'u-admin-001',
      updated_by: 'u-admin-001',
      sale_status: 'OFF_SHELF',
    });
    expect(firstImage.image_url).toMatch(/^\/api\/v1\/dish-images\/[0-9a-f-]{36}$/);

    const [imageRow] = await tableRows<{ image_object_key: string }>(
      environment.database.url,
      'SELECT image_object_key FROM dish WHERE dish_id = $1',
      [dish.dish_id],
    );
    await objectStore.delete(imageRow!.image_object_key);
    const missingObject = await built.app.inject({
      method: 'GET',
      url: firstImage.image_url,
      headers: auth(adminCookie),
    });
    expect(missingObject.statusCode).toBe(503);
    expect(json(missingObject)).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await objectStore.put(imageRow!.image_object_key, PNG, 'image/png');

    const anonymousRead = await built.app.inject({ method: 'GET', url: firstImage.image_url });
    expect(anonymousRead.statusCode).toBe(401);
    expect(json(anonymousRead).code).toBe('UNAUTHENTICATED');

    const hidden = await built.app.inject({
      method: 'GET',
      url: firstImage.image_url,
      headers: auth(employeeCookie),
    });
    expect(hidden.statusCode).toBe(403);
    expect(hidden.headers['content-type']).toContain('application/json');
    expect(hidden.body).not.toContain('dish-images/');

    visibleDishIds.add(dish.dish_id);
    const employeeRead = await built.app.inject({
      method: 'GET',
      url: firstImage.image_url,
      headers: auth(employeeCookie),
    });
    expect(employeeRead.statusCode).toBe(200);
    expect(employeeRead.rawPayload).toEqual(PNG);
    expect(employeeRead.headers['content-type']).toBe('image/png');
    expect(employeeRead.headers['cache-control']).toBe('private, no-store');
    expect(employeeRead.headers['x-content-type-options']).toBe('nosniff');

    await waitForTimestampTick();
    const replacement = multipart([
      { name: 'file', filename: 'dish.jpg', contentType: 'image/jpeg', body: JPEG },
    ]);
    const replaced = await built.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/dishes/${dish.dish_id}/image`,
      headers: { ...auth(adminCookie), ...replacement.headers },
      payload: replacement.payload,
    });
    expect(replaced.statusCode).toBe(200);
    const secondImage = json(replaced) as Record<string, any>;
    expect(secondImage.image_url).not.toBe(firstImage.image_url);
    expect(secondImage.image_mime_type).toBe('image/jpeg');
    expect(secondImage.image_size_bytes).toBe(JPEG.length);
    expect(secondImage.image_updated_by).toBe('u-admin-001');
    expect(secondImage.updated_by).toBe('u-admin-001');
    expect(secondImage.sale_status).toBe(firstImage.sale_status);
    expect(secondImage.image_updated_at).toBe(secondImage.updated_at);
    expect(Date.parse(secondImage.updated_at)).toBeGreaterThan(Date.parse(firstImage.updated_at));
    expect(await getDish(dish.dish_id)).toEqual(secondImage);

    const adminNewRead = await built.app.inject({
      method: 'GET',
      url: secondImage.image_url,
      headers: auth(adminCookie),
    });
    expect(adminNewRead.statusCode).toBe(200);
    expect(adminNewRead.rawPayload).toEqual(JPEG);
    expect(adminNewRead.headers['content-type']).toBe('image/jpeg');
    expect(adminNewRead.headers['cache-control']).toBe('private, no-store');
    expect(adminNewRead.headers['x-content-type-options']).toBe('nosniff');

    const employeeNewRead = await built.app.inject({
      method: 'GET',
      url: secondImage.image_url,
      headers: auth(employeeCookie),
    });
    expect(employeeNewRead.statusCode).toBe(200);
    expect(employeeNewRead.rawPayload).toEqual(JPEG);
    expect(employeeNewRead.headers['content-type']).toBe('image/jpeg');

    const oldRead = await built.app.inject({
      method: 'GET',
      url: firstImage.image_url,
      headers: auth(adminCookie),
    });
    expect(oldRead.statusCode).toBe(404);

    await waitForTimestampTick();
    const removed = await built.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/dishes/${dish.dish_id}/image`,
      headers: auth(adminCookie),
    });
    expect(removed.statusCode).toBe(200);
    const removedDish = json(removed) as Record<string, any>;
    expect(removedDish).toMatchObject({
      image_url: null,
      image_placeholder: true,
      image_mime_type: null,
      image_size_bytes: null,
      image_updated_by: 'u-admin-001',
      sale_status: secondImage.sale_status,
    });
    expect(removedDish.updated_by).toBe('u-admin-001');
    expect(removedDish.image_updated_at).toBe(removedDish.updated_at);
    expect(Date.parse(removedDish.updated_at)).toBeGreaterThan(Date.parse(secondImage.updated_at));
    expect(await getDish(dish.dish_id)).toEqual(removedDish);

    const oldAfterRemove = await built.app.inject({
      method: 'GET',
      url: secondImage.image_url,
      headers: auth(adminCookie),
    });
    expect(oldAfterRemove.statusCode).toBe(404);

    const repeated = await built.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/dishes/${dish.dish_id}/image`,
      headers: auth(adminCookie),
    });
    expect(repeated.statusCode).toBe(200);
    expect(json(repeated).updated_at).toBe(removedDish.updated_at);
    expect(json(repeated).image_updated_at).toBe(removedDish.image_updated_at);
  });

  it('keeps the existing image unchanged after every failed replacement', async () => {
    const dish = await createDish({ name: '替换失败保护菜品' });
    const initialUpload = multipart([
      { name: 'file', filename: 'original.png', contentType: 'image/png', body: PNG },
    ]);
    const uploaded = await built.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/dishes/${dish.dish_id}/image`,
      headers: { ...auth(adminCookie), ...initialUpload.headers },
      payload: initialUpload.payload,
    });
    expect(uploaded.statusCode).toBe(200);
    const originalImage = json(uploaded) as Record<string, any>;
    const originalDetail = await getDish(dish.dish_id);
    const originalRow = await getStoredDish(dish.dish_id);
    expect(originalRow.image_object_key).not.toBeNull();

    const originalRead = await built.app.inject({
      method: 'GET',
      url: originalImage.image_url,
      headers: auth(adminCookie),
    });
    expect(originalRead.statusCode).toBe(200);
    expect(originalRead.rawPayload).toEqual(PNG);

    const failures: Array<{
      part: ReturnType<typeof multipart>;
      status: number;
      code: string;
      message: string;
    }> = [
      {
        part: multipart([
          { name: 'file', filename: 'renamed.jpg', contentType: 'image/jpeg', body: 'not an image' },
        ]),
        status: 422,
        code: 'INVALID_IMAGE',
        message: '仅支持 JPEG、PNG、WebP 图片',
      },
      {
        part: multipart([
          { name: 'file', filename: 'truncated.png', contentType: 'image/png', body: PNG.subarray(0, 20) },
        ]),
        status: 422,
        code: 'INVALID_IMAGE',
        message: '图片内容损坏',
      },
      {
        part: multipart([
          { name: 'file', filename: 'too-large.png', contentType: 'image/png', body: Buffer.alloc(5_242_881, 1) },
        ]),
        status: 413,
        code: 'IMAGE_TOO_LARGE',
        message: '图片不能超过 5 MB',
      },
      {
        part: multipart([
          { name: 'file', filename: 'unsupported.gif', contentType: 'image/gif', body: GIF },
        ]),
        status: 422,
        code: 'INVALID_IMAGE',
        message: '仅支持 JPEG、PNG、WebP 图片',
      },
    ];

    for (const failure of failures) {
      const response = await built.app.inject({
        method: 'PUT',
        url: `/api/v1/admin/dishes/${dish.dish_id}/image`,
        headers: { ...auth(adminCookie), ...failure.part.headers },
        payload: failure.part.payload,
      });
      expect(response.statusCode, response.body).toBe(failure.status);
      expect(json(response)).toMatchObject({ code: failure.code });
      expect(json(response).message).toContain(failure.message);
      expect(await getDish(dish.dish_id)).toEqual(originalDetail);
      expect(await getStoredDish(dish.dish_id)).toEqual(originalRow);
      expect(objectStore.has(originalRow.image_object_key!)).toBe(true);

      const stillReadable = await built.app.inject({
        method: 'GET',
        url: originalImage.image_url,
        headers: auth(adminCookie),
      });
      expect(stillReadable.statusCode).toBe(200);
      expect(stillReadable.rawPayload).toEqual(PNG);
      expect(stillReadable.headers['content-type']).toBe('image/png');
    }
  });

  it('rejects employee image upload, replacement and removal without changing the dish', async () => {
    const dish = await createDish({ name: '员工图片写保护菜品' });
    const emptyDetail = await getDish(dish.dish_id);
    const emptyRow = await getStoredDish(dish.dish_id);

    const employeeUpload = multipart([
      { name: 'file', filename: 'employee.png', contentType: 'image/png', body: PNG },
    ]);
    const uploadDenied = await built.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/dishes/${dish.dish_id}/image`,
      headers: { ...auth(employeeCookie), ...employeeUpload.headers },
      payload: employeeUpload.payload,
    });
    expect(uploadDenied.statusCode).toBe(403);
    expect(json(uploadDenied).code).toBe('IMAGE_FORBIDDEN');
    expect(uploadDenied.headers['content-type']).toContain('application/json');
    expect(uploadDenied.body).not.toContain('dish-images/');
    expect(uploadDenied.rawPayload.includes(PNG)).toBe(false);
    expect(await getDish(dish.dish_id)).toEqual(emptyDetail);
    expect(await getStoredDish(dish.dish_id)).toEqual(emptyRow);

    const adminUpload = multipart([
      { name: 'file', filename: 'admin.png', contentType: 'image/png', body: PNG },
    ]);
    const uploaded = await built.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/dishes/${dish.dish_id}/image`,
      headers: { ...auth(adminCookie), ...adminUpload.headers },
      payload: adminUpload.payload,
    });
    expect(uploaded.statusCode).toBe(200);
    const imageDetail = await getDish(dish.dish_id);
    const imageRow = await getStoredDish(dish.dish_id);

    const employeeReplacement = multipart([
      { name: 'file', filename: 'employee.jpg', contentType: 'image/jpeg', body: JPEG },
    ]);
    const replacementDenied = await built.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/dishes/${dish.dish_id}/image`,
      headers: { ...auth(employeeCookie), ...employeeReplacement.headers },
      payload: employeeReplacement.payload,
    });
    expect(replacementDenied.statusCode).toBe(403);
    expect(json(replacementDenied).code).toBe('IMAGE_FORBIDDEN');
    expect(replacementDenied.headers['content-type']).toContain('application/json');
    expect(replacementDenied.body).not.toContain('dish-images/');
    expect(replacementDenied.rawPayload.includes(JPEG)).toBe(false);
    expect(await getDish(dish.dish_id)).toEqual(imageDetail);
    expect(await getStoredDish(dish.dish_id)).toEqual(imageRow);

    const removalDenied = await built.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/dishes/${dish.dish_id}/image`,
      headers: auth(employeeCookie),
    });
    expect(removalDenied.statusCode).toBe(403);
    expect(json(removalDenied).code).toBe('IMAGE_FORBIDDEN');
    expect(removalDenied.headers['content-type']).toContain('application/json');
    expect(removalDenied.body).not.toContain('dish-images/');
    expect(await getDish(dish.dish_id)).toEqual(imageDetail);
    expect(await getStoredDish(dish.dish_id)).toEqual(imageRow);
  });

  it('rejects empty, multi-file, unsupported, corrupt and oversized images with specific reasons', async () => {
    const dish = await createDish();
    const url = `/api/v1/admin/dishes/${dish.dish_id}/image`;

    const cases: Array<{ part: ReturnType<typeof multipart>; status: number; code: string; message: string }> = [
      {
        part: multipart([{ name: 'note', body: 'no file' }]),
        status: 422,
        code: 'INVALID_IMAGE',
        message: '文件数量必须为 1',
      },
      {
        part: multipart([{ name: 'image', filename: 'wrong.png', contentType: 'image/png', body: PNG }]),
        status: 422,
        code: 'INVALID_IMAGE',
        message: '文件数量必须为 1',
      },
      {
        part: multipart([
          { name: 'file', filename: 'empty.png', contentType: 'image/png', body: Buffer.alloc(0) },
        ]),
        status: 422,
        code: 'INVALID_IMAGE',
        message: '图片文件不能为空',
      },
      {
        part: multipart([
          { name: 'file', filename: 'one.png', contentType: 'image/png', body: PNG },
          { name: 'file', filename: 'two.png', contentType: 'image/png', body: PNG },
        ]),
        status: 422,
        code: 'INVALID_IMAGE',
        message: '文件数量必须为 1',
      },
      {
        part: multipart([
          { name: 'file', filename: 'fake.png', contentType: 'image/png', body: 'not an image' },
        ]),
        status: 422,
        code: 'INVALID_IMAGE',
        message: '仅支持 JPEG、PNG、WebP 图片',
      },
      {
        part: multipart([
          { name: 'file', filename: 'cut.png', contentType: 'image/png', body: PNG.subarray(0, 20) },
        ]),
        status: 422,
        code: 'INVALID_IMAGE',
        message: '图片内容损坏',
      },
      {
        part: multipart([
          { name: 'file', filename: 'big.png', contentType: 'image/png', body: Buffer.alloc(5_242_881, 1) },
        ]),
        status: 413,
        code: 'IMAGE_TOO_LARGE',
        message: '图片不能超过 5 MB',
      },
    ];

    for (const item of cases) {
      const response = await built.app.inject({
        method: 'PUT',
        url,
        headers: { ...auth(adminCookie), ...item.part.headers },
        payload: item.part.payload,
      });
      expect(response.statusCode, response.body).toBe(item.status);
      expect(json(response)).toMatchObject({
        code: item.code,
        details: [{ field: 'file', message: item.message }],
      });
      expect(json(response).message).toContain(item.message);
    }

    const wrongContentType = await built.app.inject({
      method: 'PUT',
      url,
      headers: { ...auth(adminCookie), 'content-type': 'application/json' },
      payload: { file: 'not multipart' },
    });
    expect(wrongContentType.statusCode).toBe(422);
    expect(json(wrongContentType)).toMatchObject({
      code: 'INVALID_IMAGE',
      details: [{ field: 'file', message: '图片上传必须使用 multipart/form-data 且包含一个文件' }],
    });

    const webp = multipart([
      { name: 'file', filename: 'dish.webp', contentType: 'application/octet-stream', body: WEBP },
    ]);
    const accepted = await built.app.inject({
      method: 'PUT',
      url,
      headers: { ...auth(adminCookie), ...webp.headers },
      payload: webp.payload,
    });
    expect(accepted.statusCode).toBe(200);
    expect(json(accepted).image_mime_type).toBe('image/webp');

    const exactMax = Buffer.concat([PNG, Buffer.alloc(5_242_880 - PNG.length)]);
    const maxFile = multipart([
      { name: 'file', filename: 'exact-max.png', contentType: 'image/png', body: exactMax },
    ]);
    const maxAccepted = await built.app.inject({
      method: 'PUT',
      url,
      headers: { ...auth(adminCookie), ...maxFile.headers },
      payload: maxFile.payload,
    });
    expect(maxAccepted.statusCode).toBe(200);
    expect(json(maxAccepted).image_size_bytes).toBe(5_242_880);
  });

  it('returns 503 and preserves the dish when private object storage is unavailable', async () => {
    const dish = await createDish({ name: '存储故障菜品' });
    const failingStore: ImageObjectStore = {
      async put() {
        throw new Error('storage unavailable');
      },
      async get() {
        throw new Error('storage unavailable');
      },
      async delete() {},
    };
    const failingApp = await buildTestApp({
      databaseUrl: environment.database.url,
      mockIssuer: environment.mockIssuer,
      mockPort: Number(new URL(environment.mockIssuer).port),
      imageObjectStore: failingStore,
    });
    try {
      const cookie = (await performLogin(failingApp, 'u-admin-001')).sessionCookiePair;
      const upload = multipart([{ name: 'file', filename: 'dish.png', contentType: 'image/png', body: PNG }]);
      const response = await failingApp.app.inject({
        method: 'PUT',
        url: `/api/v1/admin/dishes/${dish.dish_id}/image`,
        headers: { ...auth(cookie), ...upload.headers },
        payload: upload.payload,
      });
      expect(response.statusCode).toBe(503);
      expect(json(response)).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

      const detail = await built.app.inject({
        method: 'GET',
        url: `/api/v1/admin/dishes/${dish.dish_id}`,
        headers: auth(adminCookie),
      });
      expect(json(detail)).toMatchObject({
        image_url: null,
        image_placeholder: true,
        updated_at: dish.updated_at,
      });
    } finally {
      await failingApp.close();
    }
  });

  it('deletes only unreferenced dishes and maps foreign-key restrictions', async () => {
    const unreferenced = await createDish({ name: '可删除菜品' });
    const upload = multipart([{ name: 'file', filename: 'delete.png', contentType: 'image/png', body: PNG }]);
    const uploaded = await built.app.inject({
      method: 'PUT',
      url: `/api/v1/admin/dishes/${unreferenced.dish_id}/image`,
      headers: { ...auth(adminCookie), ...upload.headers },
      payload: upload.payload,
    });
    expect(uploaded.statusCode).toBe(200);
    const [storedKey] = await tableRows<{ image_object_key: string }>(
      environment.database.url,
      'SELECT image_object_key FROM dish WHERE dish_id = $1',
      [unreferenced.dish_id],
    );
    const deleted = await built.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/dishes/${unreferenced.dish_id}`,
      headers: auth(adminCookie),
    });
    expect(deleted.statusCode).toBe(204);
    expect(objectStore.has(storedKey!.image_object_key)).toBe(false);
    const missing = await built.app.inject({
      method: 'GET',
      url: `/api/v1/admin/dishes/${unreferenced.dish_id}`,
      headers: auth(adminCookie),
    });
    expect(missing.statusCode).toBe(404);

    const referenced = await createDish({ name: '被引用菜品' });
    await execute(
      environment.database.url,
      `CREATE TABLE daily_menu_item_contract_probe (
         menu_id VARCHAR(64) NOT NULL,
         dish_id VARCHAR(64) NOT NULL REFERENCES dish(dish_id) ON DELETE RESTRICT,
         PRIMARY KEY (menu_id, dish_id)
       )`,
    );
    await execute(
      environment.database.url,
      'INSERT INTO daily_menu_item_contract_probe (menu_id, dish_id) VALUES ($1, $2)',
      ['menu-001', referenced.dish_id],
    );

    const blocked = await built.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/dishes/${referenced.dish_id}`,
      headers: auth(adminCookie),
    });
    expect(blocked.statusCode).toBe(409);
    expect(json(blocked)).toMatchObject({
      code: 'DISH_IN_USE',
      message: '菜品已被菜单或订单引用，请改为下架',
    });

    const stillThere = await built.app.inject({
      method: 'GET',
      url: `/api/v1/admin/dishes/${referenced.dish_id}`,
      headers: auth(adminCookie),
    });
    expect(stillThere.statusCode).toBe(200);

    await execute(environment.database.url, 'DELETE FROM daily_menu_item_contract_probe');
    const deletedAfterReference = await built.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/dishes/${referenced.dish_id}`,
      headers: auth(adminCookie),
    });
    expect(deletedAfterReference.statusCode).toBe(204);
  });
});
