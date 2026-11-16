export interface VerifiedIdentityClaims {
  sub?: unknown;
  [key: string]: unknown;
}

export interface AuthorizationRequest {
  state: string;
  nonce: string;
  loginHint?: string;
}

export interface SsoProvider {
  authorizationUrl(request: AuthorizationRequest): Promise<string>;
  exchangeCode(
    code: string,
    expectedNonceHash: string,
    nonceHasher: (value: string) => string,
  ): Promise<VerifiedIdentityClaims>;
}
