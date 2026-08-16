ALTER TABLE platform_accounts
  DROP CONSTRAINT IF EXISTS platform_accounts_wecom_userid_pair_check;

ALTER TABLE platform_accounts
  ADD COLUMN salesperson_name TEXT,
  ADD COLUMN assistant_name TEXT;

UPDATE platform_accounts
SET salesperson_name = salesperson_wecom_userid,
    assistant_name = assistant_wecom_userid;

ALTER TABLE platform_accounts
  DROP COLUMN salesperson_wecom_userid,
  DROP COLUMN assistant_wecom_userid;

ALTER TABLE platform_accounts
  ADD CONSTRAINT platform_accounts_contact_name_pair_check CHECK (
    (salesperson_name IS NULL) = (assistant_name IS NULL)
  );
