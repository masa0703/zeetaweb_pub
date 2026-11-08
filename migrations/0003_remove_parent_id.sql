-- parent_id カラムを削除（複数親システムでは不要）
-- 順序管理は position カラムのみで行う

-- 重要: 外部キー制約を一時的に無効化
PRAGMA foreign_keys = OFF;

-- 1. parent_id インデックスを削除
DROP INDEX IF EXISTS idx_nodes_parent_id;

-- 2. parent_id カラムを削除
-- SQLiteでは ALTER TABLE DROP COLUMN が直接使えないため、
-- テーブルを再作成する必要がある

-- 2.1 新しいテーブルを作成（parent_id なし）
CREATE TABLE nodes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT,
  author TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  position INTEGER DEFAULT 0
);

-- 2.2 データをコピー（parent_id 以外）
INSERT INTO nodes_new (id, title, content, author, created_at, updated_at, position)
SELECT id, title, content, author, created_at, updated_at, position
FROM nodes;

-- 2.3 古いテーブルを削除
DROP TABLE nodes;

-- 2.4 新しいテーブルをリネーム
ALTER TABLE nodes_new RENAME TO nodes;

-- 2.5 必要なインデックスを再作成
CREATE INDEX idx_nodes_position ON nodes(position);
CREATE INDEX idx_nodes_created_at ON nodes(created_at);

-- 3. 外部キー制約を再有効化
PRAGMA foreign_keys = ON;

-- 4. データ整合性チェック
-- node_relations が正しく保持されているか確認
-- (エラーがあればマイグレーションが失敗する)
