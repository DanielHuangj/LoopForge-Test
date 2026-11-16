import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { OidcClient } from '../src/sso/oidc-client.js';
import { getFreePort } from './helpers/database.js';

type TokenMode =
  | 'valid'
  | 'missing-exp'
  | 'expired'
  | 'wrong-signature'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'wrong-nonce'
  | 'missing-iat';

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

const expectedNonce = 'expected-nonce-value';

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('OIDC ID token verification', () => {
  let idp: FastifyInstance;
  let client: OidcClient;
  let issuer: string;
  let clientId: string;
  let signingKey: PrivateKey;
  let attackerKey: PrivateKey;
  let publicJwk: JWK;
  let mode: TokenMode = 'valid';

  async function issueIdToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const token = new SignJWT({
      nonce: mode === 'wrong-nonce' ? 'other-nonce-value' : expectedNonce,
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: String(publicJwk.kid) })
      .setIssuer(mode === 'wrong-issuer' ? 'https://wrong-issuer.example' : issuer)
      .setAudience(mode === 'wrong-audience' ? 'other-client' : clientId)
      .setSubject('u-oidc-test');

    if (mode !== 'missing-iat') token.setIssuedAt(now);
    if (mode !== 'missing-exp') token.setExpirationTime(mode === 'expired' ? now - 120 : now + 300);

    return token.sign(mode === 'wrong-signature' ? attackerKey : signingKey);
  }

  beforeAll(async () => {
    const signingPair = await generateKeyPair('RS256');
    const attackerPair = await generateKeyPair('RS256');
    signingKey = signingPair.privateKey;
    attackerKey = attackerPair.privateKey;

    publicJwk = await exportJWK(signingPair.publicKey);
    publicJwk.kid = 'oidc-test-key';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';

    const port = await getFreePort();
    issuer = `http://127.0.0.1:${port}`;
    clientId = 'loopforge-oidc-test';

    idp = Fastify({ logger: false });
    idp.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, _body, done) => done(null, {}),
    );
    idp.get('/.well-known/openid-configuration', async () => ({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    }));
    idp.get('/jwks', async () => ({ keys: [publicJwk] }));
    idp.post('/token', async () => ({ id_token: await issueIdToken() }));
    await idp.listen({ port, host: '127.0.0.1' });

    const config = loadConfig({
      APP_ENV: 'test',
      DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/unused',
      SSO_MODE: 'oidc',
      SSO_ISSUER: issuer,
      SSO_CLIENT_ID: clientId,
      SSO_CLIENT_SECRET: 'oidc-client-secret',
      SSO_REDIRECT_URI: 'http://127.0.0.1:8080/api/v1/auth/callback',
      SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789abcdef',
    } as NodeJS.ProcessEnv);
    client = new OidcClient(config);
  });

  afterAll(async () => {
    await idp?.close();
  });

  it('accepts a signed token with issuer, audience, exp, iat and nonce', async () => {
    mode = 'valid';
    const claims = await client.exchangeCode('code', hash(expectedNonce), hash);
    expect(claims.sub).toBe('u-oidc-test');
    expect(claims.nonce).toBe(expectedNonce);
  });

  it.each<TokenMode>([
    'missing-exp',
    'expired',
    'wrong-signature',
    'wrong-issuer',
    'wrong-audience',
    'wrong-nonce',
    'missing-iat',
  ])('rejects %s with LOGIN_FAILED', async (tokenMode) => {
    mode = tokenMode;
    try {
      await client.exchangeCode('code', hash(expectedNonce), hash);
      throw new Error('expected exchangeCode to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('LOGIN_FAILED');
    }
  });
});

describe('OIDC discovery validation', () => {
  let idp: FastifyInstance;
  let issuer: string;

  beforeAll(async () => {
    const port = await getFreePort();
    issuer = `http://127.0.0.1:${port}`;
    idp = Fastify({ logger: false });
    idp.get('/.well-known/openid-configuration', async () => ({
      issuer,
      authorization_endpoint: 'not-a-valid-url',
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    }));
    await idp.listen({ port, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await idp?.close();
  });

  it('rejects a malformed authorization_endpoint with LOGIN_FAILED instead of throwing TypeError', async () => {
    const config = loadConfig({
      APP_ENV: 'test',
      DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/unused',
      SSO_MODE: 'oidc',
      SSO_ISSUER: issuer,
      SSO_CLIENT_ID: 'loopforge-oidc-test',
      SSO_CLIENT_SECRET: 'oidc-client-secret',
      SSO_REDIRECT_URI: 'http://127.0.0.1:8080/api/v1/auth/callback',
      SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789abcdef',
    } as NodeJS.ProcessEnv);
    const client = new OidcClient(config);

    await expect(client.authorizationUrl({ state: 'state', nonce: 'nonce' })).rejects.toMatchObject({
      code: 'LOGIN_FAILED',
      status: 401,
    });
  });
});
