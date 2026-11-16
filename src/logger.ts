import pino, { type Logger } from 'pino';

export interface Redactor {
  registerSecret(value: string | undefined): void;
  redact(value: string): string;
}

const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi;
const OIDC_PARAMETER_VALUE =
  /((?:^|[?&\s])(?:code|state|nonce|assertion|id_token|access_token|refresh_token|client_secret)=)[^&\s]+/gi;
const OIDC_JSON_VALUE =
  /("(?:code|state|nonce|assertion|id_token|access_token|refresh_token|client_secret)"\s*:\s*")[^"]+/gi;

export function createRedactor(initialSecrets: Array<string | undefined> = []): Redactor {
  const secrets = new Set<string>();
  const registerSecret = (value: string | undefined): void => {
    if (value && value.length >= 4) secrets.add(value);
  };
  for (const value of initialSecrets) registerSecret(value);

  return {
    registerSecret,
    redact(value: string): string {
      let result = value;
      for (const secret of secrets) {
        if (secret) result = result.split(secret).join('[REDACTED]');
      }
      result = result.replace(JWT_LIKE, '[REDACTED]');
      result = result.replace(BEARER_VALUE, 'Bearer [REDACTED]');
      result = result.replace(OIDC_PARAMETER_VALUE, '$1[REDACTED]');
      result = result.replace(OIDC_JSON_VALUE, '$1[REDACTED]');
      return result;
    },
  };
}

export function createLogger(level: string, destination?: NodeJS.WritableStream): Logger {
  return pino(
    {
      level,
      base: undefined,
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      formatters: { level: (label) => ({ level: label }) },
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'res.headers["set-cookie"]',
          'cookie',
          'authorization',
          'set-cookie',
          'password',
          'clientSecret',
          'sessionSecret',
          'databaseUrl',
        ],
        censor: '[REDACTED]',
      },
    },
    destination ?? process.stdout,
  );
}

export function safePath(rawUrl: string): string {
  const queryIndex = rawUrl.indexOf('?');
  return queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
}
