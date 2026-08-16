ALTER TABLE users
  ADD COLUMN wecom_webhook_ciphertext BYTEA,
  ADD COLUMN wecom_webhook_iv BYTEA,
  ADD COLUMN wecom_webhook_tag BYTEA,
  ADD COLUMN wecom_webhook_version INTEGER;

ALTER TABLE users
  ADD CONSTRAINT users_wecom_webhook_fields_check CHECK (
    (wecom_webhook_ciphertext IS NULL
      AND wecom_webhook_iv IS NULL
      AND wecom_webhook_tag IS NULL
      AND wecom_webhook_version IS NULL)
    OR
    (wecom_webhook_ciphertext IS NOT NULL
      AND wecom_webhook_iv IS NOT NULL
      AND wecom_webhook_tag IS NOT NULL
      AND wecom_webhook_version = 1)
  );
