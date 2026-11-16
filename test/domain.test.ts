import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { AuthService, isAuthorized } from '../src/domain/auth-service.js';
import { normalizeIdentity } from '../src/domain/identity.js';
import type { AccountStatus, Role, UserRecord } from '../src/domain/models.js';
import type { IdentityStore } from '../src/ports/identity-store.js';
import type { LoginAttemptStore } from '../src/ports/login-attempt-store.js';
import type { SsoProvider } from '../src/ports/sso-provider.js';
import type { SessionService } from '../src/domain/session-service.js';

const config = loadConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  SSO_MODE: 'mock',
  SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  MOCK_SSO_PORT: '9090',
  MOCK_SSO_ISSUER: 'http://localhost:9090',
} as NodeJS.ProcessEnv);

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'u-domain-001',
    name: '领域用户',
    roles: ['EMPLOYEE'],
    account_status: 'ACTIVE',
    employee_no: 'D001',
    department: '研发部',
    ...overrides,
  };
}

function user(roles: Role[], accountStatus: AccountStatus = 'ACTIVE'): UserRecord {
  return {
    userId: 'u-domain-001',
    name: '领域用户',
    department: '研发部',
    employeeNo: 'D001',
    accountStatus,
    syncedAt: new Date(),
    roles,
  };
}

describe('identity normalization', () => {
  it.each([12345, true, ['研发部'], { name: '研发部' }])(
    'rejects a non-string employee_no claim: %j',
    (value) => {
      expect(() => normalizeIdentity(claims({ employee_no: value }), config)).toThrow(
        expect.objectContaining({ code: 'LOGIN_FAILED', status: 401 }),
      );
    },
  );

  it.each([12345, true, ['研发部'], { name: '研发部' }])(
    'rejects a non-string department claim: %j',
    (value) => {
      expect(() => normalizeIdentity(claims({ department: value }), config)).toThrow(
        expect.objectContaining({ code: 'LOGIN_FAILED', status: 401 }),
      );
    },
  );

  it('accepts missing, null, empty, and whitespace-only optional claims as null', () => {
    for (const value of [undefined, null, '', '   ']) {
      const identity = normalizeIdentity(claims({ employee_no: value, department: value }), config);
      expect(identity.employeeNo).toBeNull();
      expect(identity.department).toBeNull();
    }
  });

  it('trims optional claims and enforces Unicode code-point length limits', () => {
    const identity = normalizeIdentity(
      claims({ employee_no: '  E-001  ', department: '  研发部  ' }),
      config,
    );
    expect(identity.employeeNo).toBe('E-001');
    expect(identity.department).toBe('研发部');

    expect(() => normalizeIdentity(claims({ employee_no: '员'.repeat(65) }), config)).toThrow(
      expect.objectContaining({ code: 'LOGIN_FAILED' }),
    );
    expect(() => normalizeIdentity(claims({ department: '部'.repeat(201) }), config)).toThrow(
      expect.objectContaining({ code: 'LOGIN_FAILED' }),
    );
  });
});

describe('domain authorization', () => {
  it('centralizes AUTHENTICATED and single-role checks without extending roles', () => {
    expect(isAuthorized(user([]), 'AUTHENTICATED')).toBe(false);
    expect(isAuthorized(user(['EMPLOYEE']), 'AUTHENTICATED')).toBe(true);
    expect(isAuthorized(user(['EMPLOYEE']), 'EMPLOYEE')).toBe(true);
    expect(isAuthorized(user(['EMPLOYEE']), 'MENU_ADMIN')).toBe(false);
    expect(isAuthorized(user(['MENU_ADMIN']), 'MENU_ADMIN')).toBe(true);
    expect(isAuthorized(user(['MENU_ADMIN']), 'EMPLOYEE')).toBe(false);
    expect(isAuthorized(user(['EMPLOYEE', 'MENU_ADMIN']), 'EMPLOYEE')).toBe(true);
    expect(isAuthorized(user(['EMPLOYEE', 'MENU_ADMIN']), 'MENU_ADMIN')).toBe(true);
  });

  it('maps missing session and disabled accounts to 401 before authorization', async () => {
    const auth = authService(user([]));
    await expect(auth.authenticateFor(undefined, 'EMPLOYEE')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
    });

    const disabled = authService(user(['EMPLOYEE'], 'DISABLED'));
    await expect(disabled.authenticateFor('valid-token', 'EMPLOYEE')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
  });

  it('maps zero roles and missing required roles to 403', async () => {
    const zeroRoles = authService(user([]));
    await expect(zeroRoles.authenticateFor('valid-token', 'AUTHENTICATED')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });

    const employeeOnly = authService(user(['EMPLOYEE']));
    await expect(employeeOnly.authenticateFor('valid-token', 'MENU_ADMIN')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });

  it('re-reads the current role set on every request and applies role narrowing', async () => {
    let current = user(['EMPLOYEE', 'MENU_ADMIN']);
    const auth = authService(() => current);

    await expect(auth.authenticateFor('valid-token', 'MENU_ADMIN')).resolves.toMatchObject({
      userId: 'u-domain-001',
    });

    current = user(['EMPLOYEE']);
    await expect(auth.authenticateFor('valid-token', 'MENU_ADMIN')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

function authService(userOrFactory: UserRecord | (() => UserRecord)): AuthService {
  const users: IdentityStore = {
    async findById() {
      return typeof userOrFactory === 'function' ? userOrFactory() : userOrFactory;
    },
    async synchronize() {},
    async revokeRolesForExisting() {},
  };
  const attempts: LoginAttemptStore = {
    async create() {},
    async removeExpired() {},
    async consume() {
      return null;
    },
  };
  const sso: SsoProvider = {
    async authorizationUrl() {
      return 'http://idp.test/authorize';
    },
    async exchangeCode() {
      return {};
    },
  };
  const sessions = {
    async verify(token: string | undefined) {
      if (!token) throw new AppError('UNAUTHENTICATED');
      return 'u-domain-001';
    },
  } as unknown as SessionService;
  return new AuthService(config, users, attempts, sso, sessions);
}
