import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { SessionService } from '../src/domain/session-service.js';
import { createRedactor } from '../src/logger.js';

const baseEnv = {
  APP_ENV: 'test',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  SSO_MODE: 'mock',
  SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  MOCK_SSO_PORT: '9090',
  MOCK_SSO_ISSUER: 'http://localhost:9090',
} satisfies NodeJS.ProcessEnv;

describe('configuration', () => {
  it('applies documented defaults and mock SSO settings', () => {
    const config = loadConfig({ ...baseEnv } as NodeJS.ProcessEnv);
    expect(config.port).toBe(8080);
    expect(config.sessionCookieName).toBe('loopforge_session');
    expect(config.sessionTtlSeconds).toBe(28800);
    expect(config.postLoginRedirectUrl).toBe('/api/v1/auth/me');
    expect(config.sso.clientId).toBe('loopforge-local');
    expect(config.sso.redirectUri).toBe('http://localhost:8080/api/v1/auth/callback');
    expect(config.mockSsoHost).toBe('127.0.0.1');
  });

  it('reports only missing or invalid variable names', () => {
    try {
      loadConfig({} as NodeJS.ProcessEnv);
      throw new Error('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.variableNames).toEqual(
        expect.arrayContaining(['APP_ENV', 'DATABASE_URL', 'SSO_MODE', 'SESSION_SECRET']),
      );
      expect(configError.message).not.toContain('postgres://');
    }
  });

  it('rejects production mock mode and non-https OIDC URLs', () => {
    expect(() =>
      loadConfig({ ...baseEnv, APP_ENV: 'prod' } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);

    expect(() =>
      loadConfig({
        APP_ENV: 'prod',
        DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
        SSO_MODE: 'oidc',
        SSO_ISSUER: 'http://idp.example.com',
        SSO_CLIENT_ID: 'client',
        SSO_CLIENT_SECRET: 'secret',
        SSO_REDIRECT_URI: 'http://app.example.com/callback',
        SESSION_SECRET: '0123456789abcdef0123456789abcdef',
      } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  it('rejects debug logging in production and inconsistent mock issuer ports', () => {
    expect(() =>
      loadConfig({ ...baseEnv, APP_ENV: 'prod', LOG_LEVEL: 'debug' } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);

    expect(() =>
      loadConfig({ ...baseEnv, MOCK_SSO_ISSUER: 'http://localhost:9091' } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  it('sets Secure cookies only in production', () => {
    const devConfig = loadConfig({ ...baseEnv } as NodeJS.ProcessEnv);
    const prodConfig = loadConfig({
      APP_ENV: 'prod',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
      SSO_MODE: 'oidc',
      SSO_ISSUER: 'https://idp.example.com',
      SSO_CLIENT_ID: 'client',
      SSO_CLIENT_SECRET: 'secret',
      SSO_REDIRECT_URI: 'https://app.example.com/api/v1/auth/callback',
      SESSION_SECRET: '0123456789abcdef0123456789abcdef',
      POST_LOGIN_REDIRECT_URL: 'https://app.example.com/after-login',
    } as NodeJS.ProcessEnv);

    expect(new SessionService(devConfig).sessionCookieOptions(100).secure).toBe(false);
    expect(new SessionService(prodConfig).sessionCookieOptions(100).secure).toBe(true);
  });

  it('redacts dynamic OIDC parameters from log strings', () => {
    const redactor = createRedactor(['static-secret']);
    const redacted = redactor.redact(
      'token failed code=SECRET_CODE&state=SECRET_STATE nonce=SECRET_NONCE id_token=SECRET_ID_TOKEN ' +
        'assertion=SECRET_ASSERTION access_token=SECRET_ACCESS refresh_token=SECRET_REFRESH ' +
        'client_secret=SECRET_CLIENT {"id_token":"SECRET_JSON_TOKEN"} static-secret',
    );
    for (const secret of [
      'SECRET_CODE',
      'SECRET_STATE',
      'SECRET_NONCE',
      'SECRET_ID_TOKEN',
      'SECRET_ASSERTION',
      'SECRET_ACCESS',
      'SECRET_REFRESH',
      'SECRET_CLIENT',
      'SECRET_JSON_TOKEN',
      'static-secret',
    ]) {
      expect(redacted).not.toContain(secret);
    }
  });
});
