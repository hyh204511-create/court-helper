CREATE TABLE IF NOT EXISTS extension_devices (
  id UUID PRIMARY KEY,
  device_id UUID NOT NULL UNIQUE,
  label TEXT,
  paired_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS extension_pairings (
  id UUID PRIMARY KEY,
  device_id UUID NOT NULL,
  label TEXT,
  exchange_secret_hash TEXT NOT NULL,
  verification_code_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'consumed', 'expired', 'cancelled')),
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS extension_device_id UUID REFERENCES extension_devices(id) ON DELETE SET NULL;

-- Password-minted extension sessions predate administrator device approval.
-- They cannot be safely tied to a revocable device, so invalidate them at upgrade.
UPDATE sessions
SET revoked_at = COALESCE(revoked_at, NOW())
WHERE client_type = 'extension' AND extension_device_id IS NULL;

CREATE INDEX IF NOT EXISTS extension_devices_paired_by_idx ON extension_devices (paired_by, created_at DESC);
CREATE INDEX IF NOT EXISTS extension_pairings_status_created_idx ON extension_pairings (status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS extension_pairings_one_active_device_idx
  ON extension_pairings (device_id)
  WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS sessions_extension_device_id_idx ON sessions (extension_device_id);
