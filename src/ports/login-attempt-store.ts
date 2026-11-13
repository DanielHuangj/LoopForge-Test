export interface LoginAttemptStore {
  create(stateHash: string, nonceHash: string): Promise<void>;
  removeExpired(): Promise<void>;
  consume(stateHash: string): Promise<string | null>;
}
