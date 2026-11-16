import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { AppError } from '../errors.js';
import type { AppConfig } from '../config.js';

const SESSION_ISSUER = 'loopforge-session';
const SESSION_AUDIENCE = 'loopforge-session';

export interface IssuedSession {
  token: string;
  expiresAt: number;
  maxAgeSeconds: number;
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export class SessionService {
  private readonly sessionKey: Uint8Array;

  constructor(private readonly config: AppConfig) {
    this.sessionKey = createHash('sha256')
      .update(`session:${config.sessionSecret}`, 'utf8')
      .digest();
  }

  async issue(userId: string): Promise<IssuedSession> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + this.config.sessionTtlSeconds;
    const token = await new SignJWT({ sid: randomUUID(), v: 1 })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(SESSION_ISSUER)
      .setAudience(SESSION_AUDIENCE)
      .setSubject(userId)
      .setIssuedAt(now)
      .setExpirationTime(expiresAt)
      .sign(this.sessionKey);
    return { token, expiresAt, maxAgeSeconds: Math.max(1, expiresAt - now) };
  }

  async verify(token: string | undefined): Promise<string> {
    if (!token) throw new AppError('UNAUTHENTICATED');
    try {
      const verified = await jwtVerify(token, this.sessionKey, {
        issuer: SESSION_ISSUER,
        audience: SESSION_AUDIENCE,
        algorithms: ['HS256'],
      });
      const payload = verified.payload;
      const now = Math.floor(Date.now() / 1000);
      if (
        verified.protectedHeader.typ !== 'JWT' ||
        payload.v !== 1 ||
        typeof payload.sub !== 'string' ||
        typeof payload.sid !== 'string' ||
        typeof payload.iat !== 'number' ||
        payload.iat > now + 60
      ) {
        throw new Error('invalid session payload');
      }
      return payload.sub;
    } catch {
      throw new AppError('UNAUTHENTICATED');
    }
  }

  signState(state: string): string {
    return base64url(createHmac('sha256', this.config.sessionSecret).update(`login-state:${state}`).digest());
  }

  verifyStateCookie(cookie: string | undefined): string | null {
    if (!cookie) return null;
    const separator = cookie.lastIndexOf('.');
    if (separator <= 0) return null;
    const state = cookie.slice(0, separator);
    const signature = cookie.slice(separator + 1);
    const expected = this.signState(state);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    return state;
  }

  sessionCookieOptions(maxAgeSeconds: number) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/',
      secure: this.config.appEnv === 'prod',
      maxAge: maxAgeSeconds,
    };
  }

  stateCookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/api/v1/auth',
      secure: this.config.appEnv === 'prod',
      maxAge: 600,
    };
  }
}
