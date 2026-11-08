-- 子ノードと関係タイプで絞るクエリ（祖先を辿る path_up、STRUCTURAL 親の確認、親の降格）が、
-- idx_node_relations_relation_type を選んで同じタイプの関係を全件読んでいた（本番で1回約17万行）。
-- 両方の列を持つインデックスを用意し、子ノードから直接引けるようにする。
CREATE INDEX IF NOT EXISTS idx_node_relations_child_type ON node_relations(child_node_id, relation_type_id);
