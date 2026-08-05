CREATE TABLE IF NOT EXISTS login_commands (
  id UUID PRIMARY KEY,
  platform_account_id UUID NOT NULL REFERENCES platform_accounts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending','executing','success','failed','expired')),
  result_code TEXT,
  result_message TEXT,
  claimed_by TEXT,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS login_commands_status_idx
  ON login_commands (status, created_at);
