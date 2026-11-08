-- Enforce public_id NOT NULL via triggers because D1/SQLite does not support
-- adding NOT NULL to an existing column after rows already exist.
-- Format validation (6-character base58) is handled by the application layer.

CREATE TRIGGER IF NOT EXISTS nodes_public_id_not_null_insert
BEFORE INSERT ON nodes
WHEN NEW.public_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'public_id is required');
END;

CREATE TRIGGER IF NOT EXISTS nodes_public_id_not_null_update
BEFORE UPDATE ON nodes
WHEN NEW.public_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'public_id is required');
END;
