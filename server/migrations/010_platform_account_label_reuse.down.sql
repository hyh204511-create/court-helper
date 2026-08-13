DROP INDEX IF EXISTS platform_accounts_active_label_uidx;

ALTER TABLE platform_accounts
  ADD CONSTRAINT platform_accounts_label_unique UNIQUE (label);
