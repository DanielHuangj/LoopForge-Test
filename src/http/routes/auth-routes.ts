import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../errors.js';
import type { AppConfig } from '../../config.js';
import type { AuthService } from '../../domain/auth-service.js';
import type { SessionService } from '../../domain/session-service.js';
import { MOCK_LOGIN_HINTS } from '../../sso/mock-idp.js';

export const STATE_COOKIE_NAME = 'loopforge_login_state';

function queryValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function validateLoginHint(config: AppConfig, rawHint: unknown): string | undefined {
  if (config.ssoMode !== 'mock' || rawHint === undefined) return undefined;
  if (typeof rawHint !== 'string' || !MOCK_LOGIN_HINTS.includes(rawHint)) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'login_hint', message: '不支持的测试身份' }],
    });
  }
  return rawHint;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  auth: AuthService,
  sessions: SessionService,
): void {
  const authenticate = async (request: FastifyRequest): Promise<void> => {
    request.authUser = await auth.authenticateFor(request.cookies[config.sessionCookieName], 'AUTHENTICATED');
  };

  app.get('/api/v1/auth/login', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const loginHint = validateLoginHint(config, query.login_hint);
    const start = await auth.startLogin(loginHint);
    reply.setCookie(
      STATE_COOKIE_NAME,
      `${start.state}.${sessions.signState(start.state)}`,
      sessions.stateCookieOptions(),
    );
    return reply.redirect(start.authorizationUrl);
  });

  app.get('/api/v1/auth/callback', async (request, reply) => {
    reply.clearCookie(STATE_COOKIE_NAME, sessions.stateCookieOptions());
    const query = request.query as Record<string, unknown>;
    const code = queryValue(query.code);
    const state = queryValue(query.state);
    const oidcError = queryValue(query.error);
    const errorDescription = queryValue(query.error_description);

    const details: Array<{ field: string; message: string }> = [];
    if (!state || state.trim() === '') details.push({ field: 'state', message: '必填' });
    if (state && state.length > 512) details.push({ field: 'state', message: '长度超过限制' });
    if (oidcError !== undefined) {
      if (oidcError.length > 128) details.push({ field: 'error', message: '长度超过限制' });
      if (errorDescription !== undefined && errorDescription.length > 2048) {
        details.push({ field: 'error_description', message: '长度超过限制' });
      }
    } else {
      if (!code || code.trim() === '') details.push({ field: 'code', message: '必填' });
      if (code && code.length > 4096) details.push({ field: 'code', message: '长度超过限制' });
    }
    if (details.length > 0) {
      throw new AppError('VALIDATION_ERROR', { details });
    }

    const completion = await auth.completeCallback({
      code,
      state: state!,
      stateCookie: request.cookies[STATE_COOKIE_NAME],
      oidcError,
    });
    reply.setCookie(
      config.sessionCookieName,
      completion.token,
      sessions.sessionCookieOptions(completion.maxAgeSeconds),
    );
    reply.clearCookie(STATE_COOKIE_NAME, sessions.stateCookieOptions());
    return reply.redirect(config.postLoginRedirectUrl);
  });

  app.get('/api/v1/auth/me', { preHandler: authenticate }, async (request, reply: FastifyReply) => {
    const user = request.authUser;
    if (!user) throw new AppError('UNAUTHENTICATED');
    return reply.send({
      userId: user.userId,
      name: user.name,
      department: user.department,
      roles: [...user.roles].sort(),
      accountStatus: user.accountStatus,
    });
  });
}
