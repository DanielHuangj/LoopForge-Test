import { AppError } from '../errors.js';
import { KNOWN_ROLES, type AccountStatus, type NormalizedIdentity, type Role } from './models.js';
import type { AppConfig } from '../config.js';
import type { VerifiedIdentityClaims } from '../ports/sso-provider.js';

function codePointLength(value: string): number {
  return [...value].length;
}

function stringClaim(claims: VerifiedIdentityClaims, name: string): string | null {
  const value = claims[name];
  return typeof value === 'string' ? value : null;
}

function optionalText(claims: VerifiedIdentityClaims, claimName: string, max: number): string | null {
  const value = claims[claimName];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new AppError('LOGIN_FAILED');
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (codePointLength(trimmed) > max) throw new AppError('LOGIN_FAILED');
  return trimmed;
}

function parseRoles(claims: VerifiedIdentityClaims, claimName: string): Role[] {
  const value = claims[claimName];
  let entries: string[];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    entries = value as string[];
  } else if (typeof value === 'string') {
    entries = value.split(/\s+/).filter(Boolean);
  } else {
    throw new AppError('LOGIN_FAILED');
  }
  const known = new Set(KNOWN_ROLES);
  return [...new Set(entries)].filter((role): role is Role => known.has(role as Role));
}

export function normalizeIdentity(claims: VerifiedIdentityClaims, config: AppConfig): NormalizedIdentity {
  const sub = stringClaim(claims, 'sub');
  if (!sub) throw new AppError('LOGIN_FAILED');
  const userId = sub.trim();
  if (codePointLength(userId) < 1 || codePointLength(userId) > 128) throw new AppError('LOGIN_FAILED');

  const name = stringClaim(claims, config.claims.name)?.trim() ?? '';
  if (codePointLength(name) < 1 || codePointLength(name) > 200) throw new AppError('LOGIN_FAILED');

  const employeeNo = optionalText(claims, config.claims.employeeNo, 64);
  const department = optionalText(claims, config.claims.department, 200);

  const status = claims[config.claims.accountStatus];
  if (status !== 'ACTIVE' && status !== 'DISABLED') throw new AppError('LOGIN_FAILED');

  return {
    userId,
    name,
    employeeNo,
    department,
    accountStatus: status as AccountStatus,
    roles: parseRoles(claims, config.claims.roles),
  };
}
