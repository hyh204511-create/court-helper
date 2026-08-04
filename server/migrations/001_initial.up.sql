CREATE SEQUENCE IF NOT EXISTS cases_revision_seq
  AS BIGINT
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_username_unique UNIQUE (username),
  CONSTRAINT users_role_check CHECK (role IN ('admin', 'user'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  token_hash TEXT NOT NULL,
  client_type TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT sessions_client_type_check CHECK (client_type IN ('admin_ui', 'extension'))
);

CREATE TABLE IF NOT EXISTS platform_accounts (
  id UUID PRIMARY KEY,
  label TEXT NOT NULL,
  secret_ciphertext BYTEA NOT NULL,
  secret_iv BYTEA NOT NULL,
  secret_tag BYTEA NOT NULL,
  secret_version INTEGER NOT NULL DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at TIMESTAMPTZ,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_accounts_label_unique UNIQUE (label),
  CONSTRAINT platform_accounts_secret_version_check CHECK (secret_version = 1),
  CONSTRAINT platform_accounts_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS cases (
  id UUID PRIMARY KEY,
  client_uid TEXT NOT NULL,
  platform_account_id UUID NOT NULL,
  kind TEXT NOT NULL,
  plaintiff TEXT,
  defendant TEXT,
  status TEXT NOT NULL DEFAULT 'UNKNOWN',
  filed_time DATE,
  case_number TEXT,
  reject_time DATE,
  reject_reason TEXT,
  query_time TIMESTAMPTZ,
  needs_human BOOLEAN NOT NULL DEFAULT FALSE,
  error_code TEXT,
  source_event_id TEXT,
  source_updated_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT nextval('cases_revision_seq'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cases_client_uid_unique UNIQUE (client_uid),
  CONSTRAINT cases_platform_account_fk FOREIGN KEY (platform_account_id) REFERENCES platform_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT cases_kind_check CHECK (kind IN ('li', 'qz')),
  CONSTRAINT cases_status_check CHECK (status IN ('立案成功', '强执成功', '已驳回', '审核中', 'UNKNOWN')),
  CONSTRAINT cases_kind_status_check CHECK (
    (kind = 'li' AND status <> '强执成功') OR
    (kind = 'qz' AND status <> '立案成功')
  )
);

CREATE TABLE IF NOT EXISTS screenshots (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL,
  type TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  sha256 VARCHAR(64) NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT screenshots_case_fk FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  CONSTRAINT screenshots_object_key_unique UNIQUE (object_key),
  CONSTRAINT screenshots_case_type_unique UNIQUE (case_id, type),
  CONSTRAINT screenshots_type_check CHECK (type IN ('success', 'reject', 'enforcement_success')),
  CONSTRAINT screenshots_content_type_check CHECK (content_type IN ('image/jpeg', 'image/png')),
  CONSTRAINT screenshots_byte_size_check CHECK (byte_size >= 0 AND byte_size <= 10485760)
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS platform_accounts_enabled_idx ON platform_accounts (enabled) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS cases_revision_idx ON cases (revision);
CREATE INDEX IF NOT EXISTS cases_query_time_idx ON cases (query_time);
CREATE INDEX IF NOT EXISTS screenshots_case_id_idx ON screenshots (case_id);
