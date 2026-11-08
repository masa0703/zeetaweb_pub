-- 関係タイプ INSTANCE（id=2）を廃止し、STRUCTURAL / REFERENCE の2種にする。
-- 既存の INSTANCE は「STRUCTURAL な親は1つ」を守って振り分ける:
--   子に STRUCTURAL の親が無い → STRUCTURAL（子ごとに1本だけ。parent_node_id が最小のもの）
--   それ以外                  → REFERENCE

UPDATE node_relations
SET relation_type_id = 1
WHERE relation_type_id = 2
  AND NOT EXISTS (
    SELECT 1 FROM node_relations o
    WHERE o.child_node_id = node_relations.child_node_id
      AND o.relation_type_id = 1
  )
  AND parent_node_id = (
    SELECT MIN(p.parent_node_id) FROM node_relations p
    WHERE p.child_node_id = node_relations.child_node_id
      AND p.relation_type_id = 2
  );

UPDATE node_relations
SET relation_type_id = 3
WHERE relation_type_id = 2;

DELETE FROM relation_types WHERE id = 2;
