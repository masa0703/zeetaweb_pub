-- Add trash support: trees.trash_root_node_id and nodes.deleted_at

-- 1) Schema changes
ALTER TABLE trees ADD COLUMN trash_root_node_id INTEGER;
ALTER TABLE nodes ADD COLUMN deleted_at DATETIME;

-- 2) Backfill trash root node for existing trees
INSERT INTO nodes (tree_id, title, content, version)
SELECT t.id, '(trash)', '', 1
FROM trees t
WHERE t.trash_root_node_id IS NULL;

UPDATE trees
SET trash_root_node_id = (
  SELECT n.id
  FROM nodes n
  WHERE n.tree_id = trees.id AND n.title = '(trash)'
  ORDER BY n.id DESC
  LIMIT 1
)
WHERE trash_root_node_id IS NULL;

-- 3) Indexes
CREATE INDEX IF NOT EXISTS idx_trees_trash_root_node_id ON trees(trash_root_node_id);
CREATE INDEX IF NOT EXISTS idx_nodes_deleted_at ON nodes(deleted_at);
