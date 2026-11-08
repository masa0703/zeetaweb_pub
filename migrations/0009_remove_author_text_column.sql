-- Migration: Remove legacy author TEXT column
-- Description: Complete migration from author TEXT to author_user_id INTEGER
-- Date: 2026-02-10
-- PREREQUISITE: Migration 0008 + backend/frontend code changes must be deployed first

-- ================================================================
-- 1. RECREATE NODES TABLE WITHOUT author TEXT COLUMN
-- ================================================================

-- SQLite does not support DROP COLUMN directly (pre-3.35.0)
-- Must recreate table

PRAGMA foreign_keys = OFF;

CREATE TABLE nodes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  author_user_id INTEGER,
  created_by_user_id INTEGER,
  updated_by_user_id INTEGER,
  version INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  root_position INTEGER DEFAULT 0,
  FOREIGN KEY (tree_id) REFERENCES trees(id) ON DELETE CASCADE,
  FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Copy data (excluding author TEXT column)
INSERT INTO nodes_new (
  id, tree_id, title, content, author_user_id,
  created_by_user_id, updated_by_user_id, version,
  created_at, updated_at, root_position
)
SELECT
  id, tree_id, title, content, author_user_id,
  created_by_user_id, updated_by_user_id, version,
  created_at, updated_at, root_position
FROM nodes;

-- Drop old table
DROP TABLE nodes;

-- Rename
ALTER TABLE nodes_new RENAME TO nodes;

-- ================================================================
-- 2. RECREATE ALL INDEXES
-- ================================================================

CREATE INDEX idx_nodes_tree ON nodes(tree_id);
CREATE INDEX idx_nodes_tree_root ON nodes(tree_id, root_position);
CREATE INDEX idx_nodes_created_at ON nodes(created_at);
CREATE INDEX idx_nodes_root_position ON nodes(root_position);
CREATE INDEX idx_nodes_author_user_id ON nodes(author_user_id);

PRAGMA foreign_keys = ON;
