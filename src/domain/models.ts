export type Role = 'EMPLOYEE' | 'MENU_ADMIN';
export type AccountStatus = 'ACTIVE' | 'DISABLED';

export interface UserRecord {
  userId: string;
  name: string;
  department: string | null;
  employeeNo: string | null;
  accountStatus: AccountStatus;
  syncedAt: Date;
  roles: Role[];
}

export interface NormalizedIdentity {
  userId: string;
  name: string;
  department: string | null;
  employeeNo: string | null;
  accountStatus: AccountStatus;
  roles: Role[];
}

export const KNOWN_ROLES: readonly Role[] = ['EMPLOYEE', 'MENU_ADMIN'];
