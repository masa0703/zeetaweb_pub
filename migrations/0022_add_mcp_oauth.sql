-- MCP OAuth (OAuth 2.1 authorization server + resource server) support.
--
-- Zeeta 自身が Authorization Server / Resource Server を兼ねる。
-- 発行される token / authorization code は平文保存せず SHA-256 hex を保存する。
-- token は resource（ツリー固有 MCP URL）へ束縛され、権限は毎リクエストで
-- tree_members の現在 role と突き合わせて再判定する。

-- 動的クライアント登録（DCR）で登録された MCP クライアント
CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE,
  client_name TEXT,
  client_uri TEXT,
  redirect_uris TEXT NOT NULL,                                    -- JSON配列
  grant_types TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  response_types TEXT NOT NULL DEFAULT '["code"]',
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',        -- publicクライアント + PKCEのみ
  scope TEXT,
  registration_source TEXT NOT NULL DEFAULT 'dcr',                -- 'dcr'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- /oauth/authorize の同意待ちリクエスト（同意画面でのパラメータ改変を防ぐため保存する）
CREATE TABLE IF NOT EXISTS mcp_oauth_authorization_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  tree_id INTEGER NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (tree_id) REFERENCES trees(id) ON DELETE CASCADE
);

-- 認可コード（一回限り使用可能・PKCE検証用の code_challenge を保持）
CREATE TABLE IF NOT EXISTS mcp_oauth_authorization_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  tree_id INTEGER NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (tree_id) REFERENCES trees(id) ON DELETE CASCADE
);

-- access token / refresh token（いずれも SHA-256 hex で保存）
CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  token_type TEXT NOT NULL,                 -- 'access' | 'refresh'
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  tree_id INTEGER NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  refresh_token_id INTEGER,                 -- access token: 発行元 refresh token 行
  rotated_from_token_id INTEGER,            -- refresh rotation の直前の行
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME,
  last_used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (tree_id) REFERENCES trees(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_auth_requests_expires ON mcp_oauth_authorization_requests(expires_at);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_auth_codes_expires ON mcp_oauth_authorization_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_lookup ON mcp_oauth_tokens(token_hash, token_type);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_user_tree ON mcp_oauth_tokens(user_id, tree_id);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_client ON mcp_oauth_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_refresh_parent ON mcp_oauth_tokens(refresh_token_id);
