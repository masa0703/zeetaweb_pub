-- Drop the legacy MCP API key mechanism.
--
-- MCP 認証は OAuth（`POST /api/mcp/trees/:tree_id`）へ一本化した。
-- APIキー方式（`zk_` プレフィックス / `POST /api/mcp`）は下位互換のためだけに
-- 残していたもので、本番の有効キーは直近30日間まったく使われていなかった。
--
-- `audit_logs.api_key_id` 列は過去ログの参照のため残置する（FK制約は無いので
-- このテーブルを落としても既存行は壊れず、孤児参照になるだけ）。
-- 付随するインデックス（idx_api_keys_user_id / idx_api_keys_root_node_id /
-- idx_api_keys_active）は DROP TABLE で同時に消える。

DROP TABLE IF EXISTS api_keys;
