-- Node Relations テーブル（多対多の親子関係）
CREATE TABLE IF NOT EXISTS node_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_node_id INTEGER NOT NULL,
  child_node_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (child_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
  UNIQUE(parent_node_id, child_node_id)
);

-- インデックス作成
CREATE INDEX IF NOT EXISTS idx_node_relations_parent ON node_relations(parent_node_id);
CREATE INDEX IF NOT EXISTS idx_node_relations_child ON node_relations(child_node_id);

-- 既存のparent_idデータをnode_relationsに移行
INSERT INTO node_relations (parent_node_id, child_node_id)
SELECT parent_id, id FROM nodes WHERE parent_id IS NOT NULL;

-- 注意: parent_idカラムは互換性のため残しますが、
-- 今後はnode_relationsテーブルを使用します
