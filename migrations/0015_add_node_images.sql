-- Add node image metadata table (binary files are stored in R2)

CREATE TABLE IF NOT EXISTS node_images (
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

CREATE INDEX IF NOT EXISTS idx_node_images_tree ON node_images(tree_id);
CREATE INDEX IF NOT EXISTS idx_node_images_node ON node_images(node_id);
