import type { NormalizedIdentity, UserRecord } from '../domain/models.js';

export interface IdentityStore {
  findById(userId: string): Promise<UserRecord | null>;
  synchronize(identity: NormalizedIdentity): Promise<void>;
  revokeRolesForExisting(identity: NormalizedIdentity): Promise<void>;
}
