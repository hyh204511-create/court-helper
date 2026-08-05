DROP INDEX IF EXISTS cases_created_by_idx;

ALTER TABLE cases
  DROP CONSTRAINT IF EXISTS cases_created_by_fk;

ALTER TABLE cases
  DROP COLUMN IF EXISTS created_by;
