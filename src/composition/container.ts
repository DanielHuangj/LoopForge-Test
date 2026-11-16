import type pg from 'pg';
import type { AppConfig } from '../config.js';
import { checkDatabase } from '../db/pool.js';
import { LoginAttemptRepository } from '../db/repositories/login-attempt-repository.js';
import { UserRepository } from '../db/repositories/user-repository.js';
import { AuthService } from '../domain/auth-service.js';
import { SessionService } from '../domain/session-service.js';
import type { SsoProvider } from '../ports/sso-provider.js';
import { OidcClient } from '../sso/oidc-client.js';

export interface AppServices {
  auth: AuthService;
  sessions: SessionService;
  healthCheck(): Promise<void>;
}

export function createAppServices(input: {
  config: AppConfig;
  pool: pg.Pool;
  oidc?: SsoProvider;
}): AppServices {
  const users = new UserRepository(input.pool);
  const attempts = new LoginAttemptRepository(input.pool);
  const sessions = new SessionService(input.config);
  const oidc = input.oidc ?? new OidcClient(input.config);
  const auth = new AuthService(input.config, users, attempts, oidc, sessions);

  return {
    auth,
    sessions,
    healthCheck: () => checkDatabase(input.pool, input.config.healthDbTimeoutMs),
  };
}
