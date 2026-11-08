-- Add relation type master table and typed relations
-- Existing relations are migrated to STRUCTURAL (id=1)

CREATE TABLE IF NOT EXISTS relation_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  icon_type INTEGER NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO relation_types (id, name, description, icon_type, is_system) VALUES
  (1, 'STRUCTURAL', 'Default parent-child relationship. Strong ownership (Composition).', 1, 1),
  (2, 'INSTANCE', 'Is-a relationship. Object is an instance of a Class/Type.', 2, 1),
  (3, 'REFERENCE', 'Weak link. Used for cross-reference or lookup.', 3, 1);

ALTER TABLE node_relations ADD COLUMN relation_type_id INTEGER NOT NULL DEFAULT 1;

-- Ensure pre-existing rows are explicitly set as STRUCTURAL.
UPDATE node_relations
SET relation_type_id = 1
WHERE relation_type_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_node_relations_relation_type
ON node_relations(relation_type_id);

CREATE INDEX IF NOT EXISTS idx_node_relations_parent_type_position
ON node_relations(parent_node_id, relation_type_id, position);
