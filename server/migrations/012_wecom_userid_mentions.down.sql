ALTER TABLE platform_accounts
  DROP CONSTRAINT IF EXISTS platform_accounts_wecom_userid_pair_check,
  DROP COLUMN IF EXISTS assistant_wecom_userid,
  DROP COLUMN IF EXISTS salesperson_wecom_userid;
