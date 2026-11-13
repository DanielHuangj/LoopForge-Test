export const PUBLIC_PATHS = new Set([
  '/healthz',
  '/api/v1/auth/login',
  '/api/v1/auth/callback',
]);

export const PROTECTED_PATHS = new Set([
  '/api/v1/auth/me',
  '/api/v1/employee/auth-check',
  '/api/v1/admin/auth-check',
]);

export const TEST_PATHS = new Set([
  '/api/v1/test/business-error',
  '/api/v1/test/uncaught-error',
]);

export function isTestPrefix(pathname: string): boolean {
  return pathname.startsWith('/api/v1/test/');
}
