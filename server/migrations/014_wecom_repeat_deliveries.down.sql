CREATE TABLE wecom_notifications_original (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  platform_account_id UUID NOT NULL REFERENCES platform_accounts(id) ON DELETE RESTRICT,
  result_status TEXT NOT NULL CHECK (result_status IN ('立案成功', '强执成功', '已驳回')),
  screenshot_id UUID NOT NULL REFERENCES screenshots(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

INSERT INTO wecom_notifications_original (
  id, case_id, platform_account_id, result_status, screenshot_id,
  status, error_code, attempt_count, created_at, updated_at, sent_at
)
SELECT
  id, case_id, platform_account_id, result_status, screenshot_id,
  status, error_code, attempt_count, created_at, updated_at, sent_at
FROM wecom_notifications
WHERE trigger_id = screenshot_id;

DROP TABLE wecom_notifications;
DROP INDEX IF EXISTS wecom_notifications_status_idx;
DROP INDEX IF EXISTS wecom_notifications_repeat_pkey;
DROP INDEX IF EXISTS wecom_notifications_repeat_case_id_result_status_trigger_id_key;
DROP INDEX IF EXISTS wecom_notifications_case_result_trigger_idx;
DROP INDEX IF EXISTS wecom_notifications_case_id_result_status_key;
ALTER TABLE wecom_notifications_original RENAME TO wecom_notifications;
CREATE UNIQUE INDEX wecom_notifications_case_id_result_status_key
  ON wecom_notifications (case_id, result_status);
CREATE INDEX wecom_notifications_status_idx ON wecom_notifications (status, updated_at);
