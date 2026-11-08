-- Remove redundant original_file_name column from node_images
-- Keep existing records and constraints

CREATE TABLE node_images_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_id INTEGER NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  serial_no INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  file_ext TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(node_id, serial_no),
  UNIQUE(node_id, file_name)
);

INSERT INTO node_images_new (
  id, tree_id, node_id, serial_no, file_name, file_ext, mime_type, file_size, r2_key, created_by_user_id, created_at
)
SELECT
  id, tree_id, node_id, serial_no, file_name, file_ext, mime_type, file_size, r2_key, created_by_user_id, created_at
FROM node_images;

DROP TABLE node_images;
ALTER TABLE node_images_new RENAME TO node_images;

CREATE INDEX IF NOT EXISTS idx_node_images_tree ON node_images(tree_id);
CREATE INDEX IF NOT EXISTS idx_node_images_node ON node_images(node_id);
