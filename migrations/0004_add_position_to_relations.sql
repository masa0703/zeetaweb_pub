-- Add position column to node_relations for per-parent ordering
-- This allows each node to have different order under different parents

-- Step 1: Add position column to node_relations
ALTER TABLE node_relations ADD COLUMN position INTEGER DEFAULT 0;

-- Step 2: Migrate existing position data from nodes to node_relations
-- For each relation, copy the child node's position value
UPDATE node_relations 
SET position = (
  SELECT nodes.position 
  FROM nodes 
  WHERE nodes.id = node_relations.child_node_id
);

-- Step 3: Create index for efficient ordering queries
CREATE INDEX IF NOT EXISTS idx_node_relations_parent_position 
ON node_relations(parent_node_id, position);

-- Step 4: Drop the position column from nodes table
-- Since position is now managed per parent-child relationship
-- We need to recreate the table without position column

-- Create new nodes table without position
CREATE TABLE nodes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT,
  author TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Copy all data from old table
INSERT INTO nodes_new (id, title, content, author, created_at, updated_at)
SELECT id, title, content, author, created_at, updated_at
FROM nodes;

-- Drop old table
DROP TABLE nodes;

-- Rename new table
ALTER TABLE nodes_new RENAME TO nodes;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_nodes_created_at ON nodes(created_at);

-- Note: Foreign key constraints in node_relations will be automatically
-- maintained as long as we preserve node IDs during migration
