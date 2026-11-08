-- Migration: Migrate author from TEXT to user_id reference
-- Description: Add author_user_id column and backfill from existing author text
-- Date: 2026-02-10

-- ================================================================
-- 1. ADD NEW COLUMN
-- ================================================================

-- Add author_user_id column (nullable during transition period)
ALTER TABLE nodes ADD COLUMN author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Create index for the new column
CREATE INDEX IF NOT EXISTS idx_nodes_author_user_id ON nodes(author_user_id);

-- ================================================================
-- 2. BACKFILL: Match by display_name / email with priority order
-- ================================================================

-- 2a: Match by display_name within same tree members
UPDATE nodes SET author_user_id = (
  SELECT u.id FROM users u
  JOIN tree_members tm ON tm.user_id = u.id AND tm.tree_id = nodes.tree_id
  WHERE u.display_name = nodes.author LIMIT 1
) WHERE author_user_id IS NULL AND EXISTS (
  SELECT 1 FROM users u
  JOIN tree_members tm ON tm.user_id = u.id AND tm.tree_id = nodes.tree_id
  WHERE u.display_name = nodes.author
);

-- 2b: Match by email within same tree members
UPDATE nodes SET author_user_id = (
  SELECT u.id FROM users u
  JOIN tree_members tm ON tm.user_id = u.id AND tm.tree_id = nodes.tree_id
  WHERE u.email = nodes.author LIMIT 1
) WHERE author_user_id IS NULL AND EXISTS (
  SELECT 1 FROM users u
  JOIN tree_members tm ON tm.user_id = u.id AND tm.tree_id = nodes.tree_id
  WHERE u.email = nodes.author
);

-- 2c: Match by display_name globally
UPDATE nodes SET author_user_id = (
  SELECT u.id FROM users u WHERE u.display_name = nodes.author LIMIT 1
) WHERE author_user_id IS NULL AND EXISTS (
  SELECT 1 FROM users u WHERE u.display_name = nodes.author
);

-- 2d: Match by email globally
UPDATE nodes SET author_user_id = (
  SELECT u.id FROM users u WHERE u.email = nodes.author LIMIT 1
) WHERE author_user_id IS NULL AND EXISTS (
  SELECT 1 FROM users u WHERE u.email = nodes.author
);

-- 2e: Fallback to created_by_user_id (for legacy data like 'Admin', 'Designer', etc.)
UPDATE nodes SET author_user_id = created_by_user_id
WHERE author_user_id IS NULL AND created_by_user_id IS NOT NULL;

-- 2f: Final fallback to tree owner
UPDATE nodes SET author_user_id = (
  SELECT tm.user_id FROM tree_members tm
  WHERE tm.tree_id = nodes.tree_id AND tm.role = 'owner' LIMIT 1
) WHERE author_user_id IS NULL;
