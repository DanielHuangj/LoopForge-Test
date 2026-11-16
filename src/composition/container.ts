import type pg from 'pg';
import type { AppConfig } from '../config.js';
import { checkDatabase } from '../db/pool.js';
import { PostgresDishRepository } from '../db/repositories/dish-repository.js';
import { LoginAttemptRepository } from '../db/repositories/login-attempt-repository.js';
import { UserRepository } from '../db/repositories/user-repository.js';
import { AuthService } from '../domain/auth-service.js';
import { DishAvailability, DishService } from '../domain/dish-service.js';
import { DishImageService } from '../domain/dish-image-service.js';
import { DenyAllDishVisibilityStore } from '../domain/dish-visibility.js';
import { ImageDecoderPool } from '../domain/image-decoder-pool.js';
import { SessionService } from '../domain/session-service.js';
import type { DishVisibilityStore } from '../ports/dish-visibility-store.js';
import type { DishStore } from '../ports/dish-store.js';
import type { ImageDecoder } from '../ports/image-decoder.js';
import type { ImageObjectStore } from '../ports/image-object-store.js';
import type { SsoProvider } from '../ports/sso-provider.js';
import { MemoryImageObjectStore } from '../storage/memory-image-object-store.js';
import { S3ImageObjectStore } from '../storage/s3-image-object-store.js';
import { OidcClient } from '../sso/oidc-client.js';

export interface AppServices {
  auth: AuthService;
  sessions: SessionService;
  dishes: DishService;
  dishImages: DishImageService;
  dishAvailability: DishAvailability;
  imageDecoder: ImageDecoder;
  healthCheck(): Promise<void>;
  close(): Promise<void>;
}

export function createAppServices(input: {
  config: AppConfig;
  pool: pg.Pool;
  oidc?: SsoProvider;
  dishStore?: DishStore;
  imageObjectStore?: ImageObjectStore;
  dishVisibility?: DishVisibilityStore;
  imageDecoder?: ImageDecoder;
}): AppServices {
  const users = new UserRepository(input.pool);
  const attempts = new LoginAttemptRepository(input.pool);
  const sessions = new SessionService(input.config);
  const oidc = input.oidc ?? new OidcClient(input.config);
  const auth = new AuthService(input.config, users, attempts, oidc, sessions);
  const dishStore = input.dishStore ?? new PostgresDishRepository(input.pool);
  const objectStore =
    input.imageObjectStore ??
    (input.config.objectStorage.driver === 'memory'
      ? new MemoryImageObjectStore()
      : new S3ImageObjectStore(input.config.objectStorage));
  const visibility = input.dishVisibility ?? new DenyAllDishVisibilityStore();
  const imageDecoder = input.imageDecoder ?? new ImageDecoderPool();
  const dishes = new DishService(dishStore, objectStore);
  const dishImages = new DishImageService(dishStore, objectStore, imageDecoder, visibility);
  const dishAvailability = new DishAvailability(dishStore);

  return {
    auth,
    sessions,
    dishes,
    dishImages,
    dishAvailability,
    imageDecoder,
    healthCheck: () => checkDatabase(input.pool, input.config.healthDbTimeoutMs),
    close: () => imageDecoder.close(),
  };
}
