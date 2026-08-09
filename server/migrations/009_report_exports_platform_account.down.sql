DROP INDEX IF EXISTS report_exports_platform_account_idx;
DROP INDEX IF EXISTS report_exports_sha256_creator_account_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS report_exports_sha256_creator_uidx
  ON report_exports (sha256, created_by);
ALTER TABLE report_exports DROP COLUMN IF EXISTS platform_account_id;
