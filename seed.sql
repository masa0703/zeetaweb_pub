-- サンプルデータの挿入

-- 開発用テストユーザー作成（/auth/test-login と整合）
INSERT OR IGNORE INTO users (
  oauth_provider, oauth_provider_id, email, display_name, avatar_url, last_login_at
) VALUES
  ('test', 'test-1', 'test-user-1@example.com', 'Test User 1', NULL, CURRENT_TIMESTAMP),
  ('test', 'test-2', 'test-user-2@example.com', 'Test User 2', NULL, CURRENT_TIMESTAMP);

-- ツリー作成
INSERT OR IGNORE INTO trees (id, name, description, owner_user_id) VALUES
  (1, 'サンプルプロジェクト', 'サンプルのプロジェクト計画ツリー', 1);

-- rootノード作成
INSERT OR IGNORE INTO nodes (id, public_id, tree_id, title, content, version) VALUES
  (100, '11111A', 1, 'root', '', 1);

-- trees.root_node_id 設定
UPDATE trees SET root_node_id = 100 WHERE id = 1;

-- 通常ノード作成
INSERT OR IGNORE INTO nodes (id, public_id, tree_id, title, content, author_user_id, version) VALUES
  (1, '11111B', 1, 'プロジェクト計画', 'プロジェクト全体の計画を記載', 1, 1),
  (2, '11111C', 1, '目標', '今月中にプロトタイプを完成させる', 1, 1),
  (3, '11111D', 1, 'タスクリスト', '実施すべきタスクの一覧', 1, 1),
  (4, '11111E', 1, 'デザイン', 'UI/UXデザインを作成', 1, 1),
  (5, '11111F', 1, '実装', 'コーディング作業', 1, 1),
  (6, '11111G', 1, 'アイデアメモ', '思いついたアイデアを記録', 1, 1),
  (7, '11111H', 1, '機能追加案', '検索機能を追加したい', 1, 1);

-- 親子関係の設定（root → トップレベルノード）
INSERT OR IGNORE INTO node_relations (parent_node_id, child_node_id, position) VALUES
  (100, 1, 0),
  (100, 6, 1);

-- 通常の親子関係
INSERT OR IGNORE INTO node_relations (parent_node_id, child_node_id, position) VALUES
  (1, 2, 0),
  (1, 3, 1),
  (3, 4, 0),
  (3, 5, 1),
  (6, 7, 0);

-- ツリーメンバー追加
INSERT OR IGNORE INTO tree_members (tree_id, user_id, role, added_by_user_id) VALUES
  (1, 1, 'owner', 1);

-- 既存ユーザー全員を開発用ツリーに参加させる（データが見えない状態を防止）
INSERT OR IGNORE INTO tree_members (tree_id, user_id, role, added_by_user_id)
SELECT 1, id, CASE WHEN id = 1 THEN 'owner' ELSE 'editor' END, 1
FROM users;
