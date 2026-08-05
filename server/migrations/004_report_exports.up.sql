CREATE TABLE IF NOT EXISTS report_exports (
  id UUID PRIMARY KEY,
  file_name TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS report_exports_created_by_idx
  ON report_exports (created_by, created_at);

CREATE INDEX IF NOT EXISTS report_exports_created_at_idx
  ON report_exports (created_at);

CREATE UNIQUE INDEX IF NOT EXISTS report_exports_sha256_creator_uidx
  ON report_exports (sha256, created_by);
