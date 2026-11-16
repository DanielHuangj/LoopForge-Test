import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { normalizeIdentity } from './identity.js';
import type { AppConfig } from '../config.js';
import type { SessionService } from './session-service.js';
import type { Role, UserRecord } from './models.js';
import type { IdentityStore } from '../ports/identity-store.js';
import type { LoginAttemptStore } from '../ports/login-attempt-store.js';
import type { SsoProvider } from '../ports/sso-provider.js';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface LoginStart {
  state: string;
  nonce: string;
  authorizationUrl: string;
}

export interface LoginCompletion {
  userId: string;
  token: string;
  maxAgeSeconds: number;
}

export type AccessRequirement = 'AUTHENTICATED' | Role;

export function isAuthorized(user: UserRecord, requirement: AccessRequirement): boolean {
  if (user.roles.length === 0) return false;
  return requirement === 'AUTHENTICATED' || user.roles.includes(requirement);
}

export class AuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly users: IdentityStore,
    private readonly attempts: LoginAttemptStore,
    private readonly oidc: SsoProvider,
    private readonly sessions: SessionService,
  ) {}

  async startLogin(loginHint?: string): Promise<LoginStart> {
    await this.attempts.removeExpired();
    const state = randomToken();
    const nonce = randomToken();
    await this.attempts.create(sha256Hex(state), sha256Hex(nonce));
    const authorizationUrl = await this.oidc.authorizationUrl({ state, nonce, loginHint });
    return { state, nonce, authorizationUrl };
  }

  async authenticate(sessionToken: string | undefined): Promise<UserRecord> {
    const userId = await this.sessions.verify(sessionToken);
    const user = await this.users.findById(userId);
    if (!user || user.accountStatus !== 'ACTIVE') {
      throw new AppError('UNAUTHENTICATED');
    }
    return user;
  }

  async authenticateFor(sessionToken: string | undefined, requirement: AccessRequirement): Promise<UserRecord> {
    const user = await this.authenticate(sessionToken);
    if (!isAuthorized(user, requirement)) throw new AppError('FORBIDDEN');
    return user;
  }

  async completeCallback(input: {
    code: string;
    state: string;
    stateCookie: string | undefined;
  }): Promise<LoginCompletion> {
    const cookieState = this.sessions.verifyStateCookie(input.stateCookie);
    if (!cookieState || cookieState !== input.state) {
      throw new AppError('LOGIN_FAILED');
    }

    const nonceHash = await this.attempts.consume(sha256Hex(input.state));
    if (!nonceHash) throw new AppError('LOGIN_FAILED');

    const claims = await this.oidc.exchangeCode(input.code, nonceHash, sha256Hex);
    const identity = normalizeIdentity(claims, this.config);

    if (identity.roles.length === 0) {
      const existing = await this.users.findById(identity.userId);
      if (existing) {
        try {
          await this.users.revokeRolesForExisting(identity);
        } catch (error) {
          throw this.mapDatabaseError(error);
        }
      }
      throw new AppError('FORBIDDEN');
    }

    try {
      await this.users.synchronize(identity);
    } catch (error) {
      throw this.mapDatabaseError(error);
    }

    if (identity.accountStatus === 'DISABLED') {
      throw new AppError('FORBIDDEN');
    }

    const session = await this.sessions.issue(identity.userId);
    return { userId: identity.userId, token: session.token, maxAgeSeconds: session.maxAgeSeconds };
  }

  private mapDatabaseError(error: unknown): Error {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: string }).code
        : undefined;
    const message = error instanceof Error ? error.message : '';
    if (code === '23505' || /duplicate key|unique constraint/i.test(message)) {
      return new AppError('LOGIN_FAILED');
    }
    return error instanceof Error ? error : new Error('identity synchronization failed');
  }
}
