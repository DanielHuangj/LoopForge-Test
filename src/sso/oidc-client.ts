import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError } from '../errors.js';
import type { AppConfig } from '../config.js';
import type { AuthorizationRequest, SsoProvider, VerifiedIdentityClaims } from '../ports/sso-provider.js';

interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
}

export type { AuthorizationRequest, VerifiedIdentityClaims } from '../ports/sso-provider.js';

export class OidcClient implements SsoProvider {
  private discoveryPromise: Promise<DiscoveryDocument> | null = null;
  private jwksPromise: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly config: AppConfig) {}

  private async discover(): Promise<DiscoveryDocument> {
    if (!this.discoveryPromise) {
      const discoveryUrl = `${this.config.sso.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
      this.discoveryPromise = (async () => {
        const response = await fetch(discoveryUrl, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`discovery returned ${response.status}`);
        const document = (await response.json()) as Partial<DiscoveryDocument>;
        if (
          typeof document.issuer !== 'string' ||
          typeof document.authorization_endpoint !== 'string' ||
          typeof document.token_endpoint !== 'string' ||
          typeof document.jwks_uri !== 'string'
        ) {
          throw new Error('discovery document is malformed');
        }
        return document as DiscoveryDocument;
      })().catch(() => {
        this.discoveryPromise = null;
        throw new AppError('LOGIN_FAILED');
      });
    }
    return this.discoveryPromise;
  }

  async authorizationUrl(request: AuthorizationRequest): Promise<string> {
    const discovery = await this.discover();
    let url: URL;
    try {
      url = new URL(discovery.authorization_endpoint);
    } catch {
      throw new AppError('LOGIN_FAILED');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppError('LOGIN_FAILED');
    }
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.sso.clientId);
    url.searchParams.set('redirect_uri', this.config.sso.redirectUri);
    url.searchParams.set('scope', 'openid profile');
    url.searchParams.set('state', request.state);
    url.searchParams.set('nonce', request.nonce);
    if (this.config.ssoMode === 'mock' && request.loginHint) {
      url.searchParams.set('login_hint', request.loginHint);
    }
    return url.toString();
  }

  async exchangeCode(code: string, expectedNonceHash: string, nonceHasher: (value: string) => string): Promise<VerifiedIdentityClaims> {
    const discovery = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.sso.redirectUri,
      client_id: this.config.sso.clientId,
      client_secret: this.config.sso.clientSecret,
    });

    let tokenResponse: TokenResponse;
    try {
      const response = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('token endpoint rejected the request');
      tokenResponse = (await response.json()) as TokenResponse;
    } catch {
      throw new AppError('LOGIN_FAILED');
    }

    if (!tokenResponse.id_token) throw new AppError('LOGIN_FAILED');

    try {
      if (!this.jwksPromise) this.jwksPromise = createRemoteJWKSet(new URL(discovery.jwks_uri));
      const { payload } = await jwtVerify(tokenResponse.id_token, this.jwksPromise, {
        issuer: this.config.sso.issuer,
        audience: this.config.sso.clientId,
        algorithms: ['RS256'],
        clockTolerance: 60,
      });
      const now = Math.floor(Date.now() / 1000);
      if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= now - 60) {
        throw new Error('invalid expiration claim');
      }
      if (typeof payload.iat !== 'number' || payload.iat > now + 60) {
        throw new Error('invalid issued-at claim');
      }
      const nonce = payload.nonce;
      if (typeof nonce !== 'string') throw new Error('missing nonce');
      const actualHash = Buffer.from(nonceHasher(nonce), 'utf8');
      const expectedHash = Buffer.from(expectedNonceHash, 'utf8');
      if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
        throw new Error('nonce mismatch');
      }
      return payload as VerifiedIdentityClaims;
    } catch {
      throw new AppError('LOGIN_FAILED');
    }
  }
}
