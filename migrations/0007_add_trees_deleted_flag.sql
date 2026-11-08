-- Migration: Add is_deleted flag to trees table for soft delete functionality
-- Date: 2026-02-07

-- Add is_deleted column to trees table (default 0 = not deleted)
ALTER TABLE trees ADD COLUMN is_deleted INTEGER DEFAULT 0;

-- Create index for faster queries on non-deleted trees
CREATE INDEX IF NOT EXISTS idx_trees_is_deleted ON trees(is_deleted);
