-- Add public_id column to nodes for opaque external identifiers.
-- Internal integer primary key remains unchanged.
ALTER TABLE nodes ADD COLUMN public_id TEXT;

-- Partial unique index allows NULL values during backfill before enforcement.
CREATE UNIQUE INDEX idx_nodes_public_id ON nodes(public_id) WHERE public_id IS NOT NULL;
