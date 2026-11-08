-- Add per-node child sort settings
-- These settings control how each node's direct children are sorted in the tree UI.

ALTER TABLE nodes ADD COLUMN child_sort_mode TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE nodes ADD COLUMN child_sort_direction TEXT NOT NULL DEFAULT 'asc';
