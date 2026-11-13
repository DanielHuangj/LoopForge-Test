CREATE TABLE login_attempt (
  state_hash VARCHAR(64) PRIMARY KEY,
  nonce_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT ck_login_attempt_state_hash CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_login_attempt_nonce_hash CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_login_attempt_expiry CHECK (expires_at > created_at)
);

CREATE INDEX idx_login_attempt_expires_at ON login_attempt (expires_at);
