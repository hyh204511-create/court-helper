ALTER TABLE cases
  ADD COLUMN created_by UUID;

ALTER TABLE cases
  ADD CONSTRAINT cases_created_by_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS cases_created_by_idx ON cases (created_by);
