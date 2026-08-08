ALTER TABLE browser_commands
  DROP CONSTRAINT IF EXISTS browser_commands_type_check;

ALTER TABLE browser_commands
  ADD CONSTRAINT browser_commands_type_check
  CHECK (type IN ('LOGIN', 'QUERY_LI', 'QUERY_QZ', 'EXPORT_REPORT'));
