ALTER TABLE trees ADD COLUMN node_count INTEGER NOT NULL DEFAULT 0;

UPDATE trees
SET node_count = (SELECT COUNT(*) FROM nodes WHERE nodes.tree_id = trees.id);
