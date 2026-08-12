ALTER TABLE platform_accounts
  ADD COLUMN salesperson_mobile TEXT,
  ADD COLUMN assistant_mobile TEXT,
  ADD CONSTRAINT platform_accounts_contact_pair_check CHECK ((salesperson_mobile IS NULL) = (assistant_mobile IS NULL));

CREATE TABLE wecom_notifications (
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
  sent_at TIMESTAMPTZ,
  UNIQUE (case_id, result_status)
);

CREATE INDEX wecom_notifications_status_idx ON wecom_notifications (status, updated_at);
