ALTER TABLE users DROP CONSTRAINT IF EXISTS users_wecom_webhook_fields_check;
ALTER TABLE users
  DROP COLUMN IF EXISTS wecom_webhook_version,
  DROP COLUMN IF EXISTS wecom_webhook_tag,
  DROP COLUMN IF EXISTS wecom_webhook_iv,
  DROP COLUMN IF EXISTS wecom_webhook_ciphertext;
