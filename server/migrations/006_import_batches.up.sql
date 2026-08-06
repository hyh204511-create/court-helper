CREATE TABLE IF NOT EXISTS import_batches (
  id UUID PRIMARY KEY,
  file_name TEXT NOT NULL CHECK (file_name <> ''),
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL
    CHECK (content_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  byte_size BIGINT NOT NULL CHECK (byte_size > 0 AND byte_size <= 20971520),
  sha256 TEXT NOT NULL,
  li_rows INTEGER NOT NULL CHECK (li_rows >= 0),
  qz_rows INTEGER NOT NULL CHECK (qz_rows >= 0),
  skipped_rows INTEGER NOT NULL CHECK (skipped_rows >= 0),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS import_batches_created_at_idx
  ON import_batches (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS import_batches_created_by_created_at_idx
  ON import_batches (created_by, created_at DESC, id DESC);
