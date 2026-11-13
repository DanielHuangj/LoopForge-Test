import { randomBytes } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

interface MockSubject {
  sub: string;
  name: string;
  department: string;
  employee_no: string;
  roles: string[];
  account_status: 'ACTIVE' | 'DISABLED';
}

const SUBJECTS: Record<string, MockSubject> = {
  'u-emp-001': {
    sub: 'u-emp-001',
    name: '测试员工',
    department: '研发部',
    employee_no: 'E001',
    roles: ['EMPLOYEE'],
    account_status: 'ACTIVE',
  },
  'u-admin-001': {
    sub: 'u-admin-001',
    name: '测试管理员',
    department: '行政部',
    employee_no: 'A001',
    roles: ['MENU_ADMIN'],
    account_status: 'ACTIVE',
  },
  'u-dual-001': {
    sub: 'u-dual-001',
    name: '测试双角色',
    department: '运营部',
    employee_no: 'D001',
    roles: ['EMPLOYEE', 'MENU_ADMIN'],
    account_status: 'ACTIVE',
  },
  'u-disabled-001': {
    sub: 'u-disabled-001',
    name: '测试停用用户',
    department: '研发部',
    employee_no: 'X001',
    roles: ['EMPLOYEE'],
    account_status: 'DISABLED',
  },
  'u-norole-001': {
    sub: 'u-norole-001',
    name: '测试无角色',
    department: '研发部',
    employee_no: 'N001',
    roles: [],
    account_status: 'ACTIVE',
  },
  'u-unknown-001': {
    sub: 'u-unknown-001',
    name: '测试未知角色',
    department: '研发部',
    employee_no: 'U001',
    roles: ['EMPLOYEE', 'SUPER_ADMIN'],
    account_status: 'ACTIVE',
  },
};

export const MOCK_LOGIN_HINTS = Object.keys(SUBJECTS);
export const MOCK_CLIENT_ID = 'loopforge-local';
export const MOCK_CLIENT_SECRET = 'loopforge-local-secret';

interface AuthorizationCode {
  subject: MockSubject;
  state: string;
  nonce: string;
  redirectUri: string;
  clientId: string;
  expiresAt: number;
}

export interface MockIdp {
  instance: FastifyInstance;
  issuer: string;
  listen(): Promise<number>;
  close(): Promise<void>;
}

export async function createMockIdp(issuer: string, port: number, host = '127.0.0.1'): Promise<MockIdp> {
  const normalizedIssuer = issuer.replace(/\/$/, '');
  const app = Fastify({
    logger: false,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const kid = randomBytes(8).toString('hex');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const codes = new Map<string, AuthorizationCode>();

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  app.get('/.well-known/openid-configuration', async () => ({
    issuer: normalizedIssuer,
    authorization_endpoint: `${normalizedIssuer}/authorize`,
    token_endpoint: `${normalizedIssuer}/token`,
    jwks_uri: `${normalizedIssuer}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile'],
    grant_types_supported: ['authorization_code'],
  }));

  app.get('/jwks', async () => ({ keys: [publicJwk] }));

  app.get('/authorize', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    if (query.response_type !== 'code') {
      return reply.code(400).send({ error: 'unsupported_response_type' });
    }
    if (query.client_id !== MOCK_CLIENT_ID) {
      return reply.code(400).send({ error: 'invalid_client' });
    }
    if (!query.redirect_uri || !query.state || !query.nonce) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const subject = SUBJECTS[query.login_hint ?? 'u-emp-001'];
    if (!subject) {
      return reply.code(400).send({ error: 'invalid_login_hint' });
    }
    const code = randomBytes(24).toString('base64url');
    codes.set(code, {
      subject,
      state: query.state,
      nonce: query.nonce,
      redirectUri: query.redirect_uri,
      clientId: query.client_id,
      expiresAt: Date.now() + 60_000,
    });
    const redirect = new URL(query.redirect_uri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', query.state);
    return reply.redirect(redirect.toString());
  });

  app.post('/token', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    if (body.grant_type !== 'authorization_code') {
      return reply.code(400).send({ error: 'unsupported_grant_type' });
    }
    if (!body.code) return reply.code(400).send({ error: 'invalid_request' });
    if (body.client_id !== MOCK_CLIENT_ID || body.client_secret !== MOCK_CLIENT_SECRET) {
      return reply.code(401).send({ error: 'invalid_client' });
    }
    const entry = codes.get(body.code);
    codes.delete(body.code);
    if (!entry || entry.expiresAt <= Date.now()) {
      return reply.code(400).send({ error: 'invalid_grant' });
    }
    if (entry.clientId !== body.client_id || entry.redirectUri !== body.redirect_uri) {
      return reply.code(400).send({ error: 'invalid_grant' });
    }
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({
      nonce: entry.nonce,
      name: entry.subject.name,
      department: entry.subject.department,
      employee_no: entry.subject.employee_no,
      roles: entry.subject.roles,
      account_status: entry.subject.account_status,
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
      .setIssuer(normalizedIssuer)
      .setAudience(entry.clientId)
      .setSubject(entry.subject.sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);

    return reply.send({
      access_token: randomBytes(24).toString('base64url'),
      token_type: 'Bearer',
      expires_in: 300,
      id_token: idToken,
    });
  });

  let boundPort = port;
  return {
    instance: app,
    issuer: normalizedIssuer,
    async listen(): Promise<number> {
      await app.listen({ port, host });
      const address = app.server.address();
      if (address && typeof address === 'object') boundPort = address.port;
      return boundPort;
    },
    async close(): Promise<void> {
      await app.close();
    },
  };
}
