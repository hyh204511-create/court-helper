ALTER TABLE report_exports
  ADD COLUMN IF NOT EXISTS platform_account_id UUID NULL
  REFERENCES platform_accounts(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS report_exports_platform_account_idx
  ON report_exports (platform_account_id, created_at DESC);

DROP INDEX IF EXISTS report_exports_sha256_creator_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS report_exports_sha256_creator_account_uidx
  ON report_exports (sha256, created_by, platform_account_id);
