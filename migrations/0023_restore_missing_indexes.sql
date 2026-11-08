-- 欠落インデックスの復旧
--
-- 背景:
-- `zeeta2-production-apac`（本番）と `zeeta2-staging` はデータ移行で作られたため、
-- 0022 以前の `CREATE INDEX`（IF NOT EXISTS 無し）で作られたインデックスが1本も存在しない。
-- d1_migrations 上は 0019 まで適用済みの記録があるが、実体は 0022 の6本のみだった。
-- 元DB `zeeta2-production` の43本を正として、全環境で冪等に復旧させる。
--
-- 除外したもの（カラム自体が削除済みのため復旧しない）:
-- - idx_nodes_parent_id     … nodes.parent_id を 0003 で削除
-- - idx_nodes_position      … nodes.position を 0004 で node_relations へ移動
-- - idx_nodes_root_position / idx_nodes_tree_root … nodes.root_position を 0010 で削除

-- nodes
CREATE INDEX IF NOT EXISTS idx_nodes_tree ON nodes(tree_id);
CREATE INDEX IF NOT EXISTS idx_nodes_created_at ON nodes(created_at);
CREATE INDEX IF NOT EXISTS idx_nodes_author_user_id ON nodes(author_user_id);
CREATE INDEX IF NOT EXISTS idx_nodes_deleted_at ON nodes(deleted_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_public_id ON nodes(public_id) WHERE public_id IS NOT NULL;

-- node_relations
CREATE INDEX IF NOT EXISTS idx_node_relations_parent ON node_relations(parent_node_id);
CREATE INDEX IF NOT EXISTS idx_node_relations_child ON node_relations(child_node_id);
CREATE INDEX IF NOT EXISTS idx_node_relations_parent_position ON node_relations(parent_node_id, position);
CREATE INDEX IF NOT EXISTS idx_node_relations_relation_type ON node_relations(relation_type_id);
CREATE INDEX IF NOT EXISTS idx_node_relations_parent_type_position ON node_relations(parent_node_id, relation_type_id, position);

-- users
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_oauth ON users(oauth_provider, oauth_provider_id);

-- trees
CREATE INDEX IF NOT EXISTS idx_trees_owner ON trees(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_trees_updated ON trees(updated_at);
CREATE INDEX IF NOT EXISTS idx_trees_is_deleted ON trees(is_deleted);
CREATE INDEX IF NOT EXISTS idx_trees_trash_root_node_id ON trees(trash_root_node_id);

-- tree_members
CREATE INDEX IF NOT EXISTS idx_tree_members_tree ON tree_members(tree_id);
CREATE INDEX IF NOT EXISTS idx_tree_members_user ON tree_members(user_id);
CREATE INDEX IF NOT EXISTS idx_tree_members_role ON tree_members(tree_id, role);

-- invitations
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(invitee_email);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations(status, expires_at);

-- notifications
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);

-- sessions
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- api_keys
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_root_node_id ON api_keys(root_node_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

-- node_images
CREATE INDEX IF NOT EXISTS idx_node_images_tree ON node_images(tree_id);
CREATE INDEX IF NOT EXISTS idx_node_images_node ON node_images(node_id);

-- audit_logs
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tree_id ON audit_logs(tree_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- mcp_oauth（0022で作成済みだが冪等性のため再掲）
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_auth_requests_expires ON mcp_oauth_authorization_requests(expires_at);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_auth_codes_expires ON mcp_oauth_authorization_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_lookup ON mcp_oauth_tokens(token_hash, token_type);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_user_tree ON mcp_oauth_tokens(user_id, tree_id);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_client ON mcp_oauth_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_refresh_parent ON mcp_oauth_tokens(refresh_token_id);
