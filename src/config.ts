export type AppEnv = 'dev' | 'test' | 'prod';
export type SsoMode = 'oidc' | 'mock';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type ObjectStorageDriver = 's3' | 'memory';

export interface ObjectStorageConfig {
  driver: ObjectStorageDriver;
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

export interface AppConfig {
  appEnv: AppEnv;
  port: number;
  databaseUrl: string;
  ssoMode: SsoMode;
  sessionSecret: string;
  sessionTtlSeconds: number;
  sessionCookieName: string;
  postLoginRedirectUrl: string;
  logLevel: LogLevel;
  healthDbTimeoutMs: number;
  mockSsoPort: number;
  mockSsoHost: string;
  mockSsoIssuer: string;
  objectStorage: ObjectStorageConfig;
  sso: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    authorizationEndpoint?: string;
  };
  claims: {
    name: string;
    roles: string;
    accountStatus: string;
    employeeNo: string;
    department: string;
  };
}

export class ConfigError extends Error {
  constructor(public readonly variableNames: string[], detail: string) {
    super(`invalid configuration: ${detail}`);
    this.name = 'ConfigError';
  }
}

const APP_ENVS = new Set(['dev', 'test', 'prod']);
const SSO_MODES = new Set(['oidc', 'mock']);
const OBJECT_STORAGE_DRIVERS = new Set(['s3', 'memory']);
const LOG_LEVELS = new Set(['error', 'warn', 'info', 'debug']);
const CLAIM_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const COOKIE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function required(env: NodeJS.ProcessEnv, name: string, missing: string[]): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    missing.push(name);
    return '';
  }
  return value;
}

function intInRange(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
  invalid: string[],
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^-?\d+$/.test(raw.trim())) {
    invalid.push(name);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    invalid.push(name);
    return fallback;
  }
  return value;
}

function absoluteHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function validRedirectUrl(value: string): boolean {
  if (value.length < 1 || value.length > 2048) return false;
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  if (value.includes('\\') || value.includes('#') || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  try {
    return new URL(value, 'http://placeholder.invalid').origin === 'http://placeholder.invalid';
  } catch {
    return false;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const missing: string[] = [];
  const invalid: string[] = [];

  const appEnvRaw = required(env, 'APP_ENV', missing);
  const ssoModeRaw = required(env, 'SSO_MODE', missing);
  const databaseUrl = required(env, 'DATABASE_URL', missing);
  const sessionSecret = required(env, 'SESSION_SECRET', missing);
  const objectStorageDriverRaw = required(env, 'OBJECT_STORAGE_DRIVER', missing);

  const appEnv = APP_ENVS.has(appEnvRaw) ? (appEnvRaw as AppEnv) : null;
  if (appEnvRaw && !appEnv) invalid.push('APP_ENV');

  const ssoMode = SSO_MODES.has(ssoModeRaw) ? (ssoModeRaw as SsoMode) : null;
  if (ssoModeRaw && !ssoMode) invalid.push('SSO_MODE');

  const objectStorageDriver = OBJECT_STORAGE_DRIVERS.has(objectStorageDriverRaw)
    ? (objectStorageDriverRaw as ObjectStorageDriver)
    : null;
  if (objectStorageDriverRaw && !objectStorageDriver) invalid.push('OBJECT_STORAGE_DRIVER');
  if (objectStorageDriver === 'memory' && appEnv !== 'test') invalid.push('OBJECT_STORAGE_DRIVER');

  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) invalid.push('DATABASE_URL');
  if (sessionSecret && Buffer.byteLength(sessionSecret, 'utf8') < 32) invalid.push('SESSION_SECRET');

  if (appEnv === 'prod' && ssoMode === 'mock') {
    invalid.push('SSO_MODE');
  }

  const port = intInRange(env, 'PORT', 8080, 1, 65535, invalid);
  const sessionTtlSeconds = intInRange(env, 'SESSION_TTL_SECONDS', 28800, 1, 28800, invalid);
  const healthDbTimeoutMs = intInRange(env, 'HEALTH_DB_TIMEOUT_MS', 2000, 1, 10000, invalid);
  const mockSsoPort = ssoMode === 'mock' ? intInRange(env, 'MOCK_SSO_PORT', 9090, 1, 65535, invalid) : 9090;
  const mockSsoHost = ssoMode === 'mock' ? env.MOCK_SSO_HOST?.trim() || '127.0.0.1' : '127.0.0.1';
  if (ssoMode === 'mock' && !/^[A-Za-z0-9.:[\]-]{1,255}$/.test(mockSsoHost)) invalid.push('MOCK_SSO_HOST');

  const sessionCookieName = env.SESSION_COOKIE_NAME?.trim() || 'loopforge_session';
  if (!COOKIE_NAME.test(sessionCookieName)) invalid.push('SESSION_COOKIE_NAME');

  const rawPostLoginRedirectUrl = env.POST_LOGIN_REDIRECT_URL;
  const postLoginRedirectUrl =
    rawPostLoginRedirectUrl === undefined || rawPostLoginRedirectUrl === ''
      ? '/api/v1/auth/me'
      : rawPostLoginRedirectUrl;
  if (!validRedirectUrl(postLoginRedirectUrl)) invalid.push('POST_LOGIN_REDIRECT_URL');

  const logLevelRaw = env.LOG_LEVEL?.trim() || 'info';
  if (!LOG_LEVELS.has(logLevelRaw)) invalid.push('LOG_LEVEL');
  if (appEnv === 'prod' && logLevelRaw === 'debug') invalid.push('LOG_LEVEL');

  const mockSsoIssuer = ssoMode === 'mock' ? env.MOCK_SSO_ISSUER?.trim() || 'http://localhost:9090' : 'http://localhost:9090';
  const mockIssuerUrl = absoluteHttpUrl(mockSsoIssuer);
  if (ssoMode === 'mock' && (!mockIssuerUrl || mockIssuerUrl.search || mockIssuerUrl.hash)) {
    invalid.push('MOCK_SSO_ISSUER');
  }

  let issuer = '';
  let clientId = '';
  let clientSecret = '';
  let redirectUri = '';

  if (ssoMode === 'oidc') {
    issuer = required(env, 'SSO_ISSUER', missing);
    clientId = required(env, 'SSO_CLIENT_ID', missing);
    clientSecret = required(env, 'SSO_CLIENT_SECRET', missing);
    redirectUri = required(env, 'SSO_REDIRECT_URI', missing);

    const issuerUrl = issuer ? absoluteHttpUrl(issuer) : null;
    if (issuer && (!issuerUrl || issuerUrl.search || issuerUrl.hash)) invalid.push('SSO_ISSUER');
    if (issuerUrl && appEnv === 'prod' && issuerUrl.protocol !== 'https:') invalid.push('SSO_ISSUER');

    if (clientId && (clientId.length < 1 || clientId.length > 200)) invalid.push('SSO_CLIENT_ID');

    const redirect = redirectUri ? absoluteHttpUrl(redirectUri) : null;
    if (redirectUri && (!redirect || redirect.hash)) invalid.push('SSO_REDIRECT_URI');
    if (redirect && appEnv === 'prod' && redirect.protocol !== 'https:') invalid.push('SSO_REDIRECT_URI');
  } else if (ssoMode === 'mock') {
    issuer = mockSsoIssuer.replace(/\/$/, '');
    clientId = 'loopforge-local';
    clientSecret = 'loopforge-local-secret';
    redirectUri = `http://localhost:${port}/api/v1/auth/callback`;

    if (mockIssuerUrl) {
      const issuerPort = mockIssuerUrl.port
        ? Number(mockIssuerUrl.port)
        : mockIssuerUrl.protocol === 'https:'
          ? 443
          : 80;
      if (issuerPort !== mockSsoPort) invalid.push('MOCK_SSO_ISSUER');
    }
  }

  const claimEnv = {
    name: env.SSO_NAME_CLAIM?.trim() || 'name',
    roles: env.SSO_ROLES_CLAIM?.trim() || 'roles',
    accountStatus: env.SSO_ACCOUNT_STATUS_CLAIM?.trim() || 'account_status',
    employeeNo: env.SSO_EMPLOYEE_NO_CLAIM?.trim() || 'employee_no',
    department: env.SSO_DEPARTMENT_CLAIM?.trim() || 'department',
  };
  const claimVariableNames: Record<keyof typeof claimEnv, string> = {
    name: 'SSO_NAME_CLAIM',
    roles: 'SSO_ROLES_CLAIM',
    accountStatus: 'SSO_ACCOUNT_STATUS_CLAIM',
    employeeNo: 'SSO_EMPLOYEE_NO_CLAIM',
    department: 'SSO_DEPARTMENT_CLAIM',
  };
  for (const [key, value] of Object.entries(claimEnv) as Array<[keyof typeof claimEnv, string]>) {
    if (!CLAIM_NAME.test(value)) invalid.push(claimVariableNames[key]);
  }
  const claimCounts = new Map<string, number>();
  for (const value of Object.values(claimEnv)) {
    claimCounts.set(value, (claimCounts.get(value) ?? 0) + 1);
  }
  for (const [key, value] of Object.entries(claimEnv) as Array<[keyof typeof claimEnv, string]>) {
    if ((claimCounts.get(value) ?? 0) > 1) invalid.push(claimVariableNames[key]);
  }

  let objectStorage: ObjectStorageConfig = { driver: objectStorageDriver ?? 's3' };
  if (objectStorageDriver === 's3') {
    const endpoint = required(env, 'OBJECT_STORAGE_ENDPOINT', missing);
    const region = required(env, 'OBJECT_STORAGE_REGION', missing);
    const bucket = required(env, 'OBJECT_STORAGE_BUCKET', missing);
    const accessKeyId = required(env, 'OBJECT_STORAGE_ACCESS_KEY_ID', missing);
    const secretAccessKey = required(env, 'OBJECT_STORAGE_SECRET_ACCESS_KEY', missing);
    const forcePathStyleRaw = required(env, 'OBJECT_STORAGE_FORCE_PATH_STYLE', missing);

    const endpointUrl = endpoint ? absoluteHttpUrl(endpoint) : null;
    if (endpoint && (!endpointUrl || endpointUrl.search || endpointUrl.hash)) {
      invalid.push('OBJECT_STORAGE_ENDPOINT');
    }
    if (region && !/^[a-z0-9-]{1,64}$/.test(region)) invalid.push('OBJECT_STORAGE_REGION');
    if (bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
      invalid.push('OBJECT_STORAGE_BUCKET');
    }
    if (accessKeyId && (accessKeyId.length < 1 || accessKeyId.length > 128)) {
      invalid.push('OBJECT_STORAGE_ACCESS_KEY_ID');
    }
    if (secretAccessKey && (secretAccessKey.length < 1 || secretAccessKey.length > 256)) {
      invalid.push('OBJECT_STORAGE_SECRET_ACCESS_KEY');
    }
    if (forcePathStyleRaw && forcePathStyleRaw !== 'true' && forcePathStyleRaw !== 'false') {
      invalid.push('OBJECT_STORAGE_FORCE_PATH_STYLE');
    }

    objectStorage = {
      driver: 's3',
      endpoint,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: forcePathStyleRaw === 'true',
    };
  }

  if (missing.length > 0 || invalid.length > 0) {
    const unique = [...new Set([...missing, ...invalid])];
    throw new ConfigError(unique, `invalid or missing configuration variables: ${unique.join(', ')}`);
  }

  return {
    appEnv: appEnv as AppEnv,
    port,
    databaseUrl,
    ssoMode: ssoMode as SsoMode,
    sessionSecret,
    sessionTtlSeconds,
    sessionCookieName,
    postLoginRedirectUrl,
    logLevel: logLevelRaw as LogLevel,
    healthDbTimeoutMs,
    mockSsoPort,
    mockSsoHost,
    mockSsoIssuer,
    objectStorage,
    sso: { issuer, clientId, clientSecret, redirectUri },
    claims: claimEnv,
  };
}
