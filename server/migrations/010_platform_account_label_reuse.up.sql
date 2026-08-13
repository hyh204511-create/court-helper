ALTER TABLE platform_accounts
  DROP CONSTRAINT IF EXISTS platform_accounts_label_unique;

CREATE UNIQUE INDEX IF NOT EXISTS platform_accounts_active_label_uidx
  ON platform_accounts (label)
  WHERE deleted_at IS NULL;
