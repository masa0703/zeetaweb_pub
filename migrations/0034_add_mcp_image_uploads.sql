-- MCP create_node_image_upload が発行する、画像アップロード用の1回限りの合鍵
-- 合鍵は SHA-256 hex で保存し、平文は保存しない（mcp_oauth_tokens と同じ方式）
CREATE TABLE IF NOT EXISTS mcp_image_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,                 -- 発行したユーザー（受付時に編集権限を再確認する）
  tree_id INTEGER NOT NULL,
  node_id INTEGER NOT NULL,                 -- 内部ID
  node_public_id TEXT NOT NULL,             -- 応答の URL を組み立てる公開ID
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,              -- 受付時、本体のバイト数と一致するか確認する
  expires_at DATETIME NOT NULL,
  used_at DATETIME,                         -- 1回使ったら埋める（成功・失敗を問わない）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (tree_id) REFERENCES trees(id) ON DELETE CASCADE,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mcp_image_uploads_expires ON mcp_image_uploads(expires_at);
