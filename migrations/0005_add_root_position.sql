-- Add root_position column to nodes table for root node ordering
-- This allows managing the order of root nodes (nodes without parents)

-- Add root_position column with default value
ALTER TABLE nodes ADD COLUMN root_position INTEGER DEFAULT 0;

-- Set initial root_position based on created_at for existing root nodes
-- Root nodes are those not present as child_node_id in node_relations
UPDATE nodes
SET root_position = (
  SELECT COUNT(*)
  FROM nodes n2
  WHERE n2.id NOT IN (SELECT child_node_id FROM node_relations)
    AND n2.created_at < nodes.created_at
    AND nodes.id NOT IN (SELECT child_node_id FROM node_relations)
)
WHERE nodes.id NOT IN (SELECT child_node_id FROM node_relations);

-- Create index for efficient ordering queries
CREATE INDEX IF NOT EXISTS idx_nodes_root_position ON nodes(root_position);
