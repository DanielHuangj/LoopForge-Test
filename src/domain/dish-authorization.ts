import { AppError } from '../errors.js';
import type { UserRecord } from './models.js';

export function hasRole(user: UserRecord, role: 'EMPLOYEE' | 'MENU_ADMIN'): boolean {
  return user.roles.includes(role);
}

export function assertCanWriteDishImage(user: UserRecord): void {
  if (!hasRole(user, 'MENU_ADMIN')) throw new AppError('IMAGE_FORBIDDEN');
}

export function assertCanReadDishImage(user: UserRecord): void {
  if (user.roles.length === 0) throw new AppError('FORBIDDEN');
  if (!hasRole(user, 'MENU_ADMIN') && !hasRole(user, 'EMPLOYEE')) throw new AppError('FORBIDDEN');
}
