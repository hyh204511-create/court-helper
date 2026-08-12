DROP TABLE IF EXISTS wecom_notifications;
ALTER TABLE platform_accounts
  DROP CONSTRAINT IF EXISTS platform_accounts_contact_pair_check,
  DROP COLUMN IF EXISTS assistant_mobile,
  DROP COLUMN IF EXISTS salesperson_mobile;
