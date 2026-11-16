import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { Writable } from 'node:stream';
import { buildApp } from '../../src/app.js';
import { loadConfig, type AppConfig, type AppEnv } from '../../src/config.js';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { runSeed, SEED_IDENTITIES } from '../../src/db/seed.js';
import { createLogger, createRedactor } from '../../src/logger.js';
import { createMockIdp, type MockIdp } from '../../src/sso/mock-idp.js';
import { createAppServices } from '../../src/composition/container.js';
import type { DishVisibilityStore } from '../../src/ports/dish-visibility-store.js';
import type { ImageDecoder } from '../../src/ports/image-decoder.js';
import type { ImageObjectStore } from '../../src/ports/image-object-store.js';
import { getFreePort } from './database.js';

export class MemoryLogStream extends Writable {
  readonly lines: string[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) this.lines.push(line);
    }
    callback();
  }

  entries(): Array<Record<string, unknown>> {
    return this.lines.map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return { raw: line };
      }
    });
  }
}

export function setCookieValues(response: LightMyRequestResponse): string[] {
  const raw = response.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

export function findSetCookie(response: LightMyRequestResponse, name: string): string | undefined {
  return setCookieValues(response).find((value) => value.startsWith(`${name}=`));
}

export function cookiePair(response: LightMyRequestResponse, name: string): string | undefined {
  const value = findSetCookie(response, name);
  if (!value) return undefined;
  return value.split(';', 1)[0];
}

export function cookieValue(response: LightMyRequestResponse, name: string): string | undefined {
  const pair = cookiePair(response, name);
  return pair?.slice(name.length + 1);
}

export async function createIdentityEnvironment() {
  const db = await import('./database.js');
  const database = await db.createTestDatabase();
  await runMigrations(database.url);
  await runSeed(database.url, 'test');

  const mockPort = await getFreePort();
  const mockIssuer = `http://127.0.0.1:${mockPort}`;
  const mockIdp = await createMockIdp(mockIssuer, mockPort);
  await mockIdp.listen();

  return {
    database,
    mockIdp,
    mockIssuer,
    async reset(): Promise<void> {
      const seedIds = SEED_IDENTITIES.map((identity) => identity.userId);
      const placeholders = seedIds.map((_, index) => `$${index + 1}`).join(',');
      await db.execute(database.url, 'DELETE FROM login_attempt');
      await db.execute(database.url, 'DELETE FROM dish');
      await db.execute(database.url, `DELETE FROM user_role WHERE user_id NOT IN (${placeholders})`, seedIds);
      await db.execute(database.url, `DELETE FROM app_user WHERE user_id NOT IN (${placeholders})`, seedIds);
      await runSeed(database.url, 'test');
    },
    async close(): Promise<void> {
      await mockIdp.close();
      await database.close();
    },
  };
}

export interface BuiltApp {
  app: FastifyInstance;
  pool: pg.Pool;
  config: AppConfig;
  logs: MemoryLogStream;
  close(): Promise<void>;
}

export async function buildTestApp(input: {
  databaseUrl: string;
  mockIssuer: string;
  mockPort: number;
  appEnv?: AppEnv;
  sessionTtlSeconds?: number;
  captureLogs?: boolean;
  databaseUrlOverride?: string;
  dishVisibility?: DishVisibilityStore;
  imageDecoder?: ImageDecoder;
  imageObjectStore?: ImageObjectStore;
}): Promise<BuiltApp> {
  const appPort = await getFreePort();
  const appEnv = input.appEnv ?? 'test';
  const objectStorageEnv = appEnv === 'test'
    ? { OBJECT_STORAGE_DRIVER: 'memory' }
    : {
        OBJECT_STORAGE_DRIVER: 's3',
        OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
        OBJECT_STORAGE_REGION: 'us-east-1',
        OBJECT_STORAGE_BUCKET: 'loopforge-dish-images',
        OBJECT_STORAGE_ACCESS_KEY_ID: 'test-access-key',
        OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
        OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
      };
  const config = loadConfig({
    APP_ENV: appEnv,
    PORT: String(appPort),
    DATABASE_URL: input.databaseUrl,
    SSO_MODE: 'mock',
    SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789abcdef',
    SESSION_TTL_SECONDS: String(input.sessionTtlSeconds ?? 28800),
    LOG_LEVEL: 'info',
    MOCK_SSO_PORT: String(input.mockPort),
    MOCK_SSO_ISSUER: input.mockIssuer,
    ...objectStorageEnv,
  } as NodeJS.ProcessEnv);

  const logs = new MemoryLogStream();
  const logger = createLogger('info', logs);
  const pool = createPool(input.databaseUrlOverride ?? input.databaseUrl, {
    connectionTimeoutMillis: config.healthDbTimeoutMs,
    statementTimeoutMs: config.healthDbTimeoutMs,
    queryTimeoutMs: config.healthDbTimeoutMs,
  });
  const redactor = createRedactor([
    config.databaseUrl,
    config.sso.clientSecret,
    config.sessionSecret,
    config.objectStorage.accessKeyId,
    config.objectStorage.secretAccessKey,
  ]);
  const services = createAppServices({
    config,
    pool,
    dishVisibility: input.dishVisibility,
    imageDecoder: input.imageDecoder,
    imageObjectStore: input.imageObjectStore,
  });
  const app = await buildApp({ config, ...services, logger, redactor });
  return {
    app,
    pool,
    config,
    logs,
    async close(): Promise<void> {
      await app.close();
      await pool.end().catch(() => undefined);
    },
  };
}

export interface LoginResult {
  login: LightMyRequestResponse;
  callback: LightMyRequestResponse;
  sessionCookiePair: string;
  stateCookiePair: string;
}

export async function performLogin(
  built: BuiltApp,
  loginHint = 'u-emp-001',
): Promise<LoginResult> {
  const login = await built.app.inject({
    method: 'GET',
    url: `/api/v1/auth/login?login_hint=${encodeURIComponent(loginHint)}`,
  });
  if (login.statusCode !== 302 || !login.headers.location) {
    throw new Error(`login did not redirect: ${login.statusCode} ${login.body}`);
  }
  const stateCookiePair = cookiePair(login, 'loopforge_login_state');
  if (!stateCookiePair) throw new Error('login did not set state cookie');

  const authorizeResponse = await fetch(login.headers.location, { redirect: 'manual' });
  const callbackLocation = authorizeResponse.headers.get('location');
  if (!callbackLocation) {
    throw new Error(`mock authorize did not redirect: ${authorizeResponse.status} ${await authorizeResponse.text()}`);
  }
  const callbackUrl = new URL(callbackLocation);

  const callback = await built.app.inject({
    method: 'GET',
    url: `${callbackUrl.pathname}${callbackUrl.search}`,
    headers: { cookie: stateCookiePair },
  });
  const sessionCookiePair = cookiePair(callback, 'loopforge_session');
  return { login, callback, sessionCookiePair: sessionCookiePair ?? '', stateCookiePair };
}

export function json(response: LightMyRequestResponse): Record<string, unknown> {
  try {
    return JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}
