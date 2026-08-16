ALTER TABLE platform_accounts
  DROP CONSTRAINT IF EXISTS platform_accounts_contact_name_pair_check;

ALTER TABLE platform_accounts
  ADD COLUMN salesperson_wecom_userid TEXT,
  ADD COLUMN assistant_wecom_userid TEXT;

UPDATE platform_accounts
SET salesperson_wecom_userid = salesperson_name,
    assistant_wecom_userid = assistant_name;

ALTER TABLE platform_accounts
  DROP COLUMN salesperson_name,
  DROP COLUMN assistant_name;

ALTER TABLE platform_accounts
  ADD CONSTRAINT platform_accounts_wecom_userid_pair_check CHECK (
    (salesperson_wecom_userid IS NULL) = (assistant_wecom_userid IS NULL)
  );
