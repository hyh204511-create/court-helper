CREATE TABLE IF NOT EXISTS browser_commands (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('LOGIN', 'QUERY_LI', 'QUERY_QZ', 'EXPORT_REPORT')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'executing', 'succeeded', 'failed', 'expired', 'manual_required', 'cancelled')),
  platform_account_id UUID REFERENCES platform_accounts(id) ON DELETE RESTRICT,
  client_batch_id TEXT,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  claimed_by TEXT,
  claim_token_hash TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_code TEXT,
  result_summary TEXT,
  progress JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS browser_commands_requested_by_idx
  ON browser_commands (requested_by, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS browser_commands_filter_idx
  ON browser_commands (status, type, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS browser_commands_active_account_uidx
  ON browser_commands (platform_account_id)
  WHERE status IN ('pending', 'executing');
