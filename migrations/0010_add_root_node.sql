-- ツリー毎のrootノード導入
-- trees.root_node_id追加、既存データ移行、nodes.root_position廃止
--
-- 注意: wrangler D1はステートメント単位で実行するため PRAGMA foreign_keys = OFF が効かない。
-- そのため、FK制約に引っかからない書き方にしている。
--   - root_node_id は REFERENCES なしの INTEGER で追加
--   - nodes テーブル再構築は、先に trees.root_node_id を NULL にしてから DROP

-- 1. trees に root_node_id カラム追加（FK制約なし、アプリ側で整合性を担保）
ALTER TABLE trees ADD COLUMN root_node_id INTEGER;

-- 2. 既存ツリー毎にrootノード作成（root_position=-1をマーカーとして使用）
INSERT INTO nodes (tree_id, title, content, version, root_position)
SELECT id, 'root', '', 1, -1 FROM trees;

-- 3. trees.root_node_id を更新
UPDATE trees SET root_node_id = (
  SELECT n.id FROM nodes n
  WHERE n.tree_id = trees.id AND n.root_position = -1
);

-- 4. 既存ルートノード（node_relationsの子でないノード）をrootの子にする
--    root_positionの値をnode_relations.positionとして引き継ぐ
INSERT INTO node_relations (parent_node_id, child_node_id, position)
SELECT t.root_node_id, n.id, COALESCE(n.root_position, 0)
FROM nodes n
JOIN trees t ON n.tree_id = t.id
WHERE n.id NOT IN (SELECT child_node_id FROM node_relations)
  AND n.root_position != -1;

-- 4b. node_relations を一時退避
--     nodes再構築時のDROP TABLE nodesでON DELETE CASCADEが発火し、
--     node_relationsが消えるため、事前に退避しておく
CREATE TABLE _tmp_node_relations_backup (
  id INTEGER PRIMARY KEY,
  parent_node_id INTEGER NOT NULL,
  child_node_id INTEGER NOT NULL,
  created_at DATETIME,
  position INTEGER DEFAULT 0
);

INSERT INTO _tmp_node_relations_backup (id, parent_node_id, child_node_id, created_at, position)
SELECT id, parent_node_id, child_node_id, created_at, position
FROM node_relations;

-- 5. nodesテーブル再構築（root_positionカラム削除）
--    先に trees.root_node_id を退避してNULLにし、DROP後に復元する

-- 5a. root_node_id を一時テーブルに退避
CREATE TABLE _tmp_root_node_ids (tree_id INTEGER, root_node_id INTEGER);
INSERT INTO _tmp_root_node_ids SELECT id, root_node_id FROM trees;
UPDATE trees SET root_node_id = NULL;

-- 5b. nodesテーブル再構築
CREATE TABLE nodes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  author_user_id INTEGER,
  created_by_user_id INTEGER,
  updated_by_user_id INTEGER,
  version INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tree_id) REFERENCES trees(id) ON DELETE CASCADE,
  FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO nodes_new (id, tree_id, title, content, author_user_id,
  created_by_user_id, updated_by_user_id, version, created_at, updated_at)
SELECT id, tree_id, title, content, author_user_id,
  created_by_user_id, updated_by_user_id, version, created_at, updated_at
FROM nodes;

DROP TABLE nodes;
ALTER TABLE nodes_new RENAME TO nodes;

-- 5c. root_node_id を復元
UPDATE trees SET root_node_id = (
  SELECT root_node_id FROM _tmp_root_node_ids t WHERE t.tree_id = trees.id
);
DROP TABLE _tmp_root_node_ids;

-- 5d. node_relations を復元
INSERT INTO node_relations (id, parent_node_id, child_node_id, created_at, position)
SELECT id, parent_node_id, child_node_id, created_at, position
FROM _tmp_node_relations_backup;
DROP TABLE _tmp_node_relations_backup;

-- 6. インデックス再作成（root_position関連は除外）
CREATE INDEX idx_nodes_tree ON nodes(tree_id);
CREATE INDEX idx_nodes_created_at ON nodes(created_at);
CREATE INDEX idx_nodes_author_user_id ON nodes(author_user_id);
