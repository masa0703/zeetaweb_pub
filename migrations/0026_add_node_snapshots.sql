CREATE TABLE IF NOT EXISTS node_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL,
  content TEXT,
  node_version INTEGER NOT NULL,
  user_id INTEGER,
  source TEXT NOT NULL CHECK (source IN ('ui', 'mcp')),
  client_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_node_snapshots_node_version
  ON node_snapshots(node_id, node_version DESC);
CREATE INDEX IF NOT EXISTS idx_node_snapshots_node_created_at
  ON node_snapshots(node_id, created_at);
