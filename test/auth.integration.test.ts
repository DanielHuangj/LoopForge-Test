import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { execute, tableRows } from './helpers/database.js';
import {
  buildTestApp,
  cookiePair,
  cookieValue,
  createIdentityEnvironment,
  findSetCookie,
  json,
  performLogin,
  type BuiltApp,
} from './helpers/harness.js';
import { createPool } from '../src/db/pool.js';
import { createAppServices } from '../src/composition/container.js';
import { SessionService } from '../src/domain/session-service.js';

let environment: Awaited<ReturnType<typeof createIdentityEnvironment>>;
let built: BuiltApp;

beforeAll(async () => {
  environment = await createIdentityEnvironment();
});

afterAll(async () => {
  await environment?.close();
});

beforeEach(async () => {
  await environment.reset();
  built = await buildTestApp({
    databaseUrl: environment.database.url,
    mockIssuer: environment.mockIssuer,
    mockPort: Number(new URL(environment.mockIssuer).port),
  });
});

afterEach(async () => {
  await built?.close();
});

function authHeader(cookiePairValue: string) {
  return { cookie: cookiePairValue };
}

function sessionCookieFrom(response: { headers: Record<string, unknown> }): string {
  const setCookie = response.headers['set-cookie'];
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [String(setCookie)] : [];
  const value = values.find((item) => item.startsWith('loopforge_session='));
  if (!value) throw new Error('missing session cookie');
  return value.split(';', 1)[0] ?? '';
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const segment = token.split('.')[1];
  if (!segment) throw new Error('not a JWT');
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('health and authentication boundaries', () => {
  it('serves unauthenticated health checks with trace headers', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({ status: 'UP' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-trace-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns 401 with the unified envelope for all protected probes without a session', async () => {
    for (const url of ['/api/v1/auth/me', '/api/v1/employee/auth-check', '/api/v1/admin/auth-check']) {
      const response = await built.app.inject({ method: 'GET', url });
      const body = json(response);
      expect(response.statusCode).toBe(401);
      expect(body.code).toBe('UNAUTHENTICATED');
      expect(body.message).toBe('请先登录');
      expect(body.traceId).toBe(response.headers['x-trace-id']);
      expect(body.loginUrl).toBe('/api/v1/auth/login');
      expect(body).not.toHaveProperty('userId');
      expect(body).not.toHaveProperty('roles');
    }
  });

  it('completes the mock SSO login, sets hardened cookies, and enforces the employee matrix', async () => {
    const login = await performLogin(built, 'u-emp-001');
    expect(login.callback.statusCode).toBe(302);
    expect(login.callback.headers.location).toBe('/api/v1/auth/me');
    const setCookie = findSetCookie(login.callback, 'loopforge_session');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Domain=');
    expect(setCookie).not.toContain('Secure');
    expect(findSetCookie(login.callback, 'loopforge_login_state')).toBeDefined();

    const me = await built.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(login.sessionCookiePair),
    });
    expect(me.statusCode).toBe(200);
    expect(json(me)).toEqual({
      userId: 'u-emp-001',
      name: '测试员工',
      department: '研发部',
      roles: ['EMPLOYEE'],
      accountStatus: 'ACTIVE',
    });

    const employee = await built.app.inject({
      method: 'GET',
      url: '/api/v1/employee/auth-check',
      headers: authHeader(login.sessionCookiePair),
    });
    expect(employee.statusCode).toBe(200);
    expect(json(employee)).toEqual({ allowed: true });

    const admin = await built.app.inject({
      method: 'GET',
      url: '/api/v1/admin/auth-check',
      headers: authHeader(login.sessionCookiePair),
    });
    expect(admin.statusCode).toBe(403);
    expect(json(admin)).toMatchObject({ code: 'FORBIDDEN', message: '无权访问' });
    expect(json(admin)).not.toHaveProperty('roles');
    expect(json(admin)).not.toHaveProperty('userId');
  });

  it('enforces the admin and dual-role probe matrices', async () => {
    const adminLogin = await performLogin(built, 'u-admin-001');
    const adminMe = await built.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(adminLogin.sessionCookiePair),
    });
    expect(json(adminMe).roles).toEqual(['MENU_ADMIN']);
    expect(
      (
        await built.app.inject({
          method: 'GET',
          url: '/api/v1/employee/auth-check',
          headers: authHeader(adminLogin.sessionCookiePair),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await built.app.inject({
          method: 'GET',
          url: '/api/v1/admin/auth-check',
          headers: authHeader(adminLogin.sessionCookiePair),
        })
      ).statusCode,
    ).toBe(200);

    const dualLogin = await performLogin(built, 'u-dual-001');
    const dualMe = await built.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(dualLogin.sessionCookiePair),
    });
    expect(json(dualMe).roles).toEqual(['EMPLOYEE', 'MENU_ADMIN']);
    expect(
      (
        await built.app.inject({
          method: 'GET',
          url: '/api/v1/employee/auth-check',
          headers: authHeader(dualLogin.sessionCookiePair),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await built.app.inject({
          method: 'GET',
          url: '/api/v1/admin/auth-check',
          headers: authHeader(dualLogin.sessionCookiePair),
        })
      ).statusCode,
    ).toBe(200);

    const ids = [adminLogin, dualLogin].map((entry) => decodeJwtPayload(entry.sessionCookiePair.split('=')[1] ?? '').sid);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('ignores unknown roles, persists only known roles, and updates a repeated login instead of duplicating it', async () => {
    const unknownLogin = await performLogin(built, 'u-unknown-001');
    expect(unknownLogin.callback.statusCode).toBe(302);
    const me = await built.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(unknownLogin.sessionCookiePair),
    });
    expect(json(me).roles).toEqual(['EMPLOYEE']);

    const unknownRoles = await tableRows<{ role: string }>(
      environment.database.url,
      "SELECT role FROM user_role WHERE user_id = 'u-unknown-001' ORDER BY role",
    );
    expect(unknownRoles).toEqual([{ role: 'EMPLOYEE' }]);

    await execute(environment.database.url, "UPDATE app_user SET synced_at = '2000-01-01T00:00:00Z' WHERE user_id = 'u-dual-001'");
    const first = await performLogin(built, 'u-dual-001');
    const second = await performLogin(built, 'u-dual-001');
    expect(first.sessionCookiePair).not.toBe(second.sessionCookiePair);
    const users = await tableRows<{ count: string; synced: Date }>(
      environment.database.url,
      "SELECT count(*)::text AS count, max(synced_at) AS synced FROM app_user WHERE user_id = 'u-dual-001'",
    );
    expect(users[0]?.count).toBe('1');
    expect(new Date(users[0]!.synced).getTime()).toBeGreaterThan(new Date('2000-01-02T00:00:00Z').getTime());
    const roles = await tableRows<{ role: string }>(
      environment.database.url,
      "SELECT role FROM user_role WHERE user_id = 'u-dual-001' ORDER BY role",
    );
    expect(roles).toEqual([{ role: 'EMPLOYEE' }, { role: 'MENU_ADMIN' }]);
  });

  it('rejects disabled and no-role identities without creating sessions', async () => {
    const disabled = await performLogin(built, 'u-disabled-001');
    expect(disabled.callback.statusCode).toBe(403);
    expect(disabled.sessionCookiePair).toBe('');
    expect(json(disabled.callback).code).toBe('FORBIDDEN');

    const noRole = await performLogin(built, 'u-norole-001');
    expect(noRole.callback.statusCode).toBe(403);
    expect(noRole.sessionCookiePair).toBe('');
    const rows = await tableRows<{ count: string }>(
      environment.database.url,
      "SELECT count(*)::text AS count FROM app_user WHERE user_id = 'u-norole-001'",
    );
    expect(rows[0]?.count).toBe('0');

    const disabledAccess = await built.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(disabled.stateCookiePair),
    });
    expect(disabledAccess.statusCode).toBe(401);
  });

  it("applies P-06 option A by revoking an existing user's roles and invalidating old sessions", async () => {
    await execute(
      environment.database.url,
      `INSERT INTO app_user (user_id, employee_no, name, department, account_status, synced_at)
       VALUES ('u-norole-001', 'N001', '测试无角色', '研发部', 'ACTIVE', '2000-01-01T00:00:00Z')`,
    );
    await execute(environment.database.url, "INSERT INTO user_role (user_id, role) VALUES ('u-norole-001', 'EMPLOYEE')");

    const oldSession = await new SessionService(built.config).issue('u-norole-001');
    const oldSessionCookie = `${built.config.sessionCookieName}=${oldSession.token}`;
    const beforeSync = await built.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(oldSessionCookie),
    });
    expect(beforeSync.statusCode).toBe(200);

    const noRole = await performLogin(built, 'u-norole-001');
    expect(noRole.callback.statusCode).toBe(403);
    expect(json(noRole.callback).code).toBe('FORBIDDEN');
    expect(noRole.sessionCookiePair).toBe('');

    const afterSync = await built.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(oldSessionCookie),
    });
    expect(afterSync.statusCode).toBe(403);
    expect(json(afterSync).code).toBe('FORBIDDEN');
    expect(json(afterSync)).not.toHaveProperty('roles');

    const users = await tableRows<{ user_id: string; synced_at: Date; role_count: string }>(
      environment.database.url,
      `SELECT u.user_id, u.synced_at, count(r.role)::text AS role_count
         FROM app_user u LEFT JOIN user_role r ON r.user_id = u.user_id
        WHERE u.user_id = 'u-norole-001'
        GROUP BY u.user_id`,
    );
    expect(users).toHaveLength(1);
    expect(users[0]?.role_count).toBe('0');
    expect(new Date(users[0]!.synced_at).getTime()).toBeGreaterThan(new Date('2000-01-02T00:00:00Z').getTime());
  });

  it('validates callback parameters, state integrity, replay, and expiry', async () => {
    const missing = await built.app.inject({ method: 'GET', url: '/api/v1/auth/callback' });
    expect(missing.statusCode).toBe(422);
    expect(json(missing).code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(json(missing).details)).toBe(true);
    expect(findSetCookie(missing, 'loopforge_session')).toBeUndefined();

    const longCode = await built.app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?code=${'a'.repeat(5000)}&state=x`,
    });
    expect(longCode.statusCode).toBe(422);

    const login = await performLogin(built, 'u-emp-001');
    const stateCookie = login.stateCookiePair;
    const tamperedCookie = `${stateCookie.slice(0, -1)}x`;
    const authorize = await fetch(login.login.headers.location as string, { redirect: 'manual' });
    const callbackUrl = new URL(authorize.headers.get('location') as string);
    const tampered = await built.app.inject({
      method: 'GET',
      url: `${callbackUrl.pathname}${callbackUrl.search}`,
      headers: { cookie: tamperedCookie },
    });
    expect(tampered.statusCode).toBe(401);
    expect(json(tampered).code).toBe('LOGIN_FAILED');

    const replay = await built.app.inject({
      method: 'GET',
      url: `${callbackUrl.pathname}${callbackUrl.search}`,
      headers: { cookie: stateCookie },
    });
    expect(replay.statusCode).toBe(401);
    expect(json(replay).code).toBe('LOGIN_FAILED');

    const expiryLogin = await performLogin(built, 'u-emp-001');
    const expiryAuthorize = await fetch(expiryLogin.login.headers.location as string, { redirect: 'manual' });
    const expiryUrl = new URL(expiryAuthorize.headers.get('location') as string);
    await execute(environment.database.url, 'UPDATE login_attempt SET expires_at = clock_timestamp() - interval \'1 second\'');
    const expired = await built.app.inject({
      method: 'GET',
      url: `${expiryUrl.pathname}${expiryUrl.search}`,
      headers: { cookie: expiryLogin.stateCookiePair },
    });
    expect(expired.statusCode).toBe(401);
  });

  it('consumes state for OIDC authorization errors without creating a session', async () => {
    const login = await built.app.inject({
      method: 'GET',
      url: '/api/v1/auth/login?login_hint=u-emp-001',
    });
    const stateCookie = cookiePair(login, 'loopforge_login_state');
    expect(stateCookie).toBeDefined();
    const state = stateCookie!.slice('loopforge_login_state='.length).split('.', 1)[0]!;

    const callback = await built.app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      headers: { cookie: stateCookie! },
    });
    expect(callback.statusCode).toBe(401);
    expect(json(callback).code).toBe('LOGIN_FAILED');
    expect(findSetCookie(callback, 'loopforge_session')).toBeUndefined();
    const errorLog = built.logs
      .entries()
      .find((entry) => entry.event === 'http_error' && entry.traceId === callback.headers['x-trace-id']);
    expect(errorLog).toMatchObject({ errorCode: 'LOGIN_FAILED', oidcErrorCode: 'access_denied' });

    const attempts = await tableRows<{ count: string }>(
      environment.database.url,
      'SELECT count(*)::text AS count FROM login_attempt',
    );
    expect(attempts).toEqual([{ count: '0' }]);

    const replay = await built.app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?code=fake-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: stateCookie! },
    });
    expect(replay.statusCode).toBe(401);
    expect(json(replay).code).toBe('LOGIN_FAILED');

    const oversizedLogin = await built.app.inject({
      method: 'GET',
      url: '/api/v1/auth/login?login_hint=u-emp-001',
    });
    const oversizedStateCookie = cookiePair(oversizedLogin, 'loopforge_login_state')!;
    const oversizedState = oversizedStateCookie.slice('loopforge_login_state='.length).split('.', 1)[0]!;
    const oversized = await built.app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?error=invalid_scope&state=${encodeURIComponent(oversizedState)}&error_description=${'x'.repeat(2049)}`,
      headers: { cookie: oversizedStateCookie },
    });
    expect(oversized.statusCode).toBe(422);
    expect(json(oversized).details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'error_description' })]),
    );
    const retainedAttempts = await tableRows<{ count: string }>(
      environment.database.url,
      'SELECT count(*)::text AS count FROM login_attempt',
    );
    expect(retainedAttempts).toEqual([{ count: '1' }]);
  });

  it('rejects expired, tampered, random, and disabled-account sessions', async () => {
    const random = await built.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: 'loopforge_session=not.a.valid-token' },
    });
    expect(random.statusCode).toBe(401);

    const login = await performLogin(built, 'u-emp-001');
    const token = login.sessionCookiePair.split('=')[1] ?? '';
    const [tokenHeader, tokenPayload, tokenSignature] = token.split('.');
    const signatureBytes = Buffer.from(tokenSignature ?? '', 'base64url');
    signatureBytes[0] = signatureBytes[0]! ^ 0x01;
    const tampered = `${tokenHeader}.${tokenPayload}.${signatureBytes.toString('base64url')}`;
    const tamperedResponse = await built.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: `loopforge_session=${tampered}` },
    });
    expect(tamperedResponse.statusCode).toBe(401);

    await execute(environment.database.url, "UPDATE app_user SET account_status = 'DISABLED' WHERE user_id = 'u-emp-001'");
    const disabled = await built.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(login.sessionCookiePair),
    });
    expect(disabled.statusCode).toBe(401);
    expect(json(disabled).code).toBe('UNAUTHENTICATED');
    expect(json(disabled)).not.toHaveProperty('userId');
  });

  it('expires sessions at the configured TTL', async () => {
    const shortLived = await buildTestApp({
      databaseUrl: environment.database.url,
      mockIssuer: environment.mockIssuer,
      mockPort: Number(new URL(environment.mockIssuer).port),
      sessionTtlSeconds: 1,
    });
    try {
      const login = await performLogin(shortLived, 'u-emp-001');
      const immediately = await shortLived.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: authHeader(login.sessionCookiePair),
      });
      expect(immediately.statusCode).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 1300));
      const expired = await shortLived.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: authHeader(login.sessionCookiePair),
      });
      expect(expired.statusCode).toBe(401);
    } finally {
      await shortLived.close();
    }
  });


  it('rolls back the identity transaction when employee_no conflicts with another user', async () => {
    await execute(
      environment.database.url,
      `INSERT INTO app_user (user_id, employee_no, name, department, account_status, synced_at)
       VALUES ('u-conflict-001', 'U001', '冲突员工号', '研发部', 'ACTIVE', clock_timestamp())`,
    );
    const result = await performLogin(built, 'u-unknown-001');
    expect(result.callback.statusCode).toBe(401);
    expect(json(result.callback).code).toBe('LOGIN_FAILED');
    expect(result.sessionCookiePair).toBe('');
    const rows = await tableRows<{ count: string }>(
      environment.database.url,
      "SELECT count(*)::text AS count FROM app_user WHERE user_id = 'u-unknown-001'",
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('returns 403 for an active account whose roles have all been revoked', async () => {
    const dualLogin = await performLogin(built, 'u-dual-001');
    await execute(environment.database.url, "DELETE FROM user_role WHERE user_id = 'u-dual-001'");
    for (const url of ['/api/v1/auth/me', '/api/v1/employee/auth-check', '/api/v1/admin/auth-check']) {
      const response = await built.app.inject({
        method: 'GET',
        url,
        headers: authHeader(dualLogin.sessionCookiePair),
      });
      expect(response.statusCode).toBe(403);
      expect(json(response).code).toBe('FORBIDDEN');
      expect(json(response)).not.toHaveProperty('roles');
    }
  });

  it('ignores spoofed identity and role hints from headers and query parameters', async () => {
    const login = await performLogin(built, 'u-emp-001');
    const admin = await built.app.inject({
      method: 'GET',
      url: '/api/v1/admin/auth-check?role=MENU_ADMIN&roles=MENU_ADMIN',
      headers: { ...authHeader(login.sessionCookiePair), 'x-role': 'MENU_ADMIN', 'x-user-id': 'u-admin-001' },
    });
    expect(admin.statusCode).toBe(403);
    const me = await built.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { ...authHeader(login.sessionCookiePair), 'x-role': 'MENU_ADMIN', 'x-user-id': 'u-admin-001' },
    });
    expect(json(me).userId).toBe('u-emp-001');
  });

  it('re-reads roles and account status from the database on every request', async () => {
    const dualLogin = await performLogin(built, 'u-dual-001');
    await execute(environment.database.url, "DELETE FROM user_role WHERE user_id = 'u-dual-001' AND role = 'MENU_ADMIN'");
    const adminProbe = await built.app.inject({
      method: 'GET',
      url: '/api/v1/admin/auth-check',
      headers: authHeader(dualLogin.sessionCookiePair),
    });
    expect(adminProbe.statusCode).toBe(403);
    const me = await built.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(dualLogin.sessionCookiePair),
    });
    expect(json(me).roles).toEqual(['EMPLOYEE']);
  });
});

describe('routing, errors, logs and infrastructure failure', () => {
  it('distinguishes unauthenticated and authenticated unknown routes and methods', async () => {
    const unauthUnknown = await built.app.inject({ method: 'GET', url: '/api/v1/not-exist' });
    expect(unauthUnknown.statusCode).toBe(401);
    expect(json(unauthUnknown).code).toBe('UNAUTHENTICATED');

    const login = await performLogin(built, 'u-emp-001');
    const authUnknown = await built.app.inject({
      method: 'GET',
      url: '/api/v1/not-exist',
      headers: authHeader(login.sessionCookiePair),
    });
    expect(authUnknown.statusCode).toBe(404);
    expect(json(authUnknown).code).toBe('NOT_FOUND');

    const publicMethod = await built.app.inject({ method: 'POST', url: '/healthz' });
    expect(publicMethod.statusCode).toBe(405);
    expect(json(publicMethod).code).toBe('METHOD_NOT_ALLOWED');

    const protectedMethodUnauth = await built.app.inject({ method: 'POST', url: '/api/v1/auth/me' });
    expect(protectedMethodUnauth.statusCode).toBe(401);
    const protectedMethodAuth = await built.app.inject({
      method: 'POST',
      url: '/api/v1/auth/me',
      headers: authHeader(login.sessionCookiePair),
    });
    expect(protectedMethodAuth.statusCode).toBe(405);

    const outsideApi = await built.app.inject({ method: 'GET', url: '/not-exist' });
    expect(outsideApi.statusCode).toBe(404);
  });

  it('maps business and uncaught exceptions to the unified envelope without leaking internals', async () => {
    const business = await built.app.inject({ method: 'GET', url: '/api/v1/test/business-error' });
    expect(business.statusCode).toBe(409);
    expect(json(business).code).toBe('DEMO_CONFLICT');
    expect(json(business).message).toBe('演示业务冲突');
    expect(json(business).traceId).toBe(business.headers['x-trace-id']);
    expect(String(business.headers['content-type'])).toContain('application/json');

    const uncaught = await built.app.inject({ method: 'GET', url: '/api/v1/test/uncaught-error' });
    expect(uncaught.statusCode).toBe(500);
    expect(json(uncaught).code).toBe('INTERNAL_ERROR');
    expect(json(uncaught).message).toBe('服务器内部错误');
    expect(uncaught.body).not.toContain('uncaught test failure');
    expect(uncaught.body).not.toContain('stack');
    expect(json(uncaught).traceId).toBe(uncaught.headers['x-trace-id']);
  });

  it('does not expose test exception routes in dev and gates them before auth', async () => {
    const devApp = await buildTestApp({
      databaseUrl: environment.database.url,
      mockIssuer: environment.mockIssuer,
      mockPort: Number(new URL(environment.mockIssuer).port),
      appEnv: 'dev',
    });
    try {
      for (const url of ['/api/v1/test/business-error', '/api/v1/test/uncaught-error']) {
        const response = await devApp.app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(404);
        expect(json(response).code).toBe('NOT_FOUND');
        expect(json(response).traceId).toBe(response.headers['x-trace-id']);
      }
    } finally {
      await devApp.close();
    }
  });

  it('emits structured access and error logs with the same trace id and no query string or secrets', async () => {
    const uncaught = await built.app.inject({
      method: 'GET',
      url: '/api/v1/test/uncaught-error?code=SECRET_CODE&token=SECRET_TOKEN',
    });
    const traceId = uncaught.headers['x-trace-id'];
    const entries = built.logs.entries();
    const access = entries.find((entry) => entry.event === 'http_access' && entry.traceId === traceId);
    const errorEntry = entries.find((entry) => entry.event === 'http_error' && entry.traceId === traceId);
    expect(access).toBeDefined();
    expect(access).toMatchObject({
      level: 'info',
      method: 'GET',
      path: '/api/v1/test/uncaught-error',
      status: 500,
    });
    expect(typeof access?.durationMs).toBe('number');
    expect(access?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(errorEntry).toBeDefined();
    expect(errorEntry).toMatchObject({ level: 'error', errorCode: 'INTERNAL_ERROR', errorType: 'Error' });
    expect(errorEntry?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(String(errorEntry?.stack)).toContain('uncaught test failure');
    expect(built.logs.lines.join('\n')).not.toContain('SECRET_CODE');
    expect(built.logs.lines.join('\n')).not.toContain('SECRET_TOKEN');
    expect(built.logs.lines.join('\n')).not.toContain('test-session-secret');

    const health = await built.app.inject({ method: 'GET', url: '/healthz?probe=1' });
    const healthTrace = health.headers['x-trace-id'];
    const healthAccess = built.logs.entries().find((entry) => entry.event === 'http_access' && entry.traceId === healthTrace);
    expect(healthAccess).toMatchObject({ path: '/healthz', status: 200 });
  });

  it('returns 503 for health checks when the database is unavailable', async () => {
    const badPool = createPool('postgres://user:secretpw@127.0.0.1:1/not-a-db');
    try {
      const broken = await import('../src/app.js');
      const services = createAppServices({ config: built.config, pool: badPool });
      const app: FastifyInstance = await broken.buildApp({ config: built.config, ...services });
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(503);
      expect(json(response)).toMatchObject({
        status: 'DOWN',
        code: 'SERVICE_UNAVAILABLE',
        message: '服务暂不可用',
      });
      expect(json(response).traceId).toBe(response.headers['x-trace-id']);
      expect(response.body).not.toContain('secretpw');
      expect(response.body).not.toContain('127.0.0.1');
      await app.close();
    } finally {
      await badPool.end();
    }
  });
});
