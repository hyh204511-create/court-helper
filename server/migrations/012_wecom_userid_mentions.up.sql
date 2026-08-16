ALTER TABLE platform_accounts
  ADD COLUMN salesperson_wecom_userid TEXT,
  ADD COLUMN assistant_wecom_userid TEXT,
  ADD CONSTRAINT platform_accounts_wecom_userid_pair_check CHECK (
    (salesperson_wecom_userid IS NULL) = (assistant_wecom_userid IS NULL)
  );
