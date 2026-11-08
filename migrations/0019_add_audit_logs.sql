CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,                    -- 操作者（NULLありうる: APIキー操作時はapi_keys.user_idを紐付け）
  api_key_id INTEGER,                 -- 使用されたAPIキーID（MCP/APIキー経由の場合。HTTPセッション時はNULL）
  action TEXT NOT NULL,               -- 操作種別（後述の命名規則）
  target_type TEXT NOT NULL,          -- 'user', 'tree', 'node', 'relation', 'api_key', 'invitation'
  target_id TEXT,                     -- 対象オブジェクトのID（複合キーの場合は連結文字列）
  tree_id INTEGER,                    -- 関連ツリーID（ある場合）
  -- Note: 差分(diff)は記録しない（テーブルサイズ抑制のため）
  ip_address TEXT,                    -- 接続元IP（cf-connecting-ip）
  user_agent TEXT,                    -- User-Agent（先頭128文字程度）
  source TEXT NOT NULL DEFAULT 'api', -- 'api'（HTTP直）または 'mcp'（MCP経由）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- クエリ性能のためのインデックス
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id, created_at DESC);
CREATE INDEX idx_audit_logs_target ON audit_logs(target_type, target_id, created_at DESC);
CREATE INDEX idx_audit_logs_tree_id ON audit_logs(tree_id, created_at DESC);
CREATE INDEX idx_audit_logs_action ON audit_logs(action, created_at DESC);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
