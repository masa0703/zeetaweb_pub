/**
 * 親子リレーションの作成・解除の規則（REST /api/trees/:tree_id/relations と MCP link_node / unlink_node の共通実装）
 *
 * 権限・ツリー所属・スコープの検証は経路ごとに異なるため呼び出し側に残し、
 * ここでは両経路で同一の「リレーションとして成立するか」の判定と書き込みだけを持つ。
 * 判定結果は文言を持たない理由コードで返し、呼び出し側が各自の文言・ステータスへ写像する。
 */

import { checkCircularReference, type CircularCheckContext } from '../utils/node-relations'

export type NewRelationRejection = 'self_reference' | 'cycle_detected' | 'cycle_indeterminate' | 'already_exists'
export type RelationRemovalRejection = 'not_found' | 'last_parent'

export async function checkNewRelation(
  db: D1Database,
  parentId: number,
  childId: number,
  cycleContext: CircularCheckContext,
): Promise<NewRelationRejection | null> {
  if (parentId === childId) return 'self_reference'

  const cycleCheck = await checkCircularReference(db, parentId, childId, cycleContext)
  if (cycleCheck === 'cycle_detected') return 'cycle_detected'
  if (cycleCheck === 'indeterminate') return 'cycle_indeterminate'

  const exists = await db.prepare(
    'SELECT 1 AS exists_flag FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?'
  ).bind(parentId, childId).first<{ exists_flag: number }>()
  if (exists?.exists_flag === 1) return 'already_exists'

  return null
}

/** 親の子リストの末尾（MAX(position)+1）にリレーションを追加する */
export async function appendRelation(
  db: D1Database,
  parentId: number,
  childId: number,
  relationTypeId: number,
): Promise<void> {
  await db.prepare(
    `INSERT INTO node_relations (parent_node_id, child_node_id, position, relation_type_id)
     VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM node_relations WHERE parent_node_id = ?), ?)`
  ).bind(parentId, childId, parentId, relationTypeId).run()
}

/** ノードは常に1つ以上の親を持つ必要があるため、唯一の親の解除は拒否する */
export async function checkRelationRemoval(
  db: D1Database,
  parentId: number,
  childId: number,
): Promise<RelationRemovalRejection | null> {
  const [relationRow, parentCountRow] = await db.batch([
    db.prepare('SELECT 1 AS exists_flag FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?')
      .bind(parentId, childId),
    db.prepare('SELECT COUNT(*) AS parent_count FROM node_relations WHERE child_node_id = ?')
      .bind(childId),
  ])

  const existsFlag = (relationRow.results?.[0] as { exists_flag: number } | undefined)?.exists_flag
  if (existsFlag !== 1) return 'not_found'

  const parentCount = Number((parentCountRow.results?.[0] as { parent_count: number } | undefined)?.parent_count || 0)
  if (parentCount <= 1) return 'last_parent'

  return null
}

const STRUCTURAL_RELATION_TYPE_ID = 1
const REFERENCE_RELATION_TYPE_ID = 3

/**
 * 親が1人だけになったノードの、その親との関係を STRUCTURAL にする文。
 * 親数が2以上のノードや、すでに STRUCTURAL の関係には何もしない（冪等）。
 * 親を減らす DELETE と同じ db.batch の後ろに積むこと（別リクエストにすると中間状態が見える）。
 */
export function normalizeSoleParentStatement(db: D1Database, childId: number): D1PreparedStatement {
  return db.prepare(
    `UPDATE node_relations SET relation_type_id = ${STRUCTURAL_RELATION_TYPE_ID}
     WHERE child_node_id = ? AND relation_type_id <> ${STRUCTURAL_RELATION_TYPE_ID}
       AND (SELECT COUNT(*) FROM node_relations WHERE child_node_id = ?) = 1`
  ).bind(childId, childId)
}

/** 削除件数を返す（0 なら他リクエストと競合して既に消えている）。親が1人になった子は STRUCTURAL にする */
export async function removeRelation(db: D1Database, parentId: number, childId: number): Promise<number> {
  const [deleted] = await db.batch([
    db.prepare('DELETE FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?').bind(parentId, childId),
    normalizeSoleParentStatement(db, childId),
  ])
  return deleted.meta.changes
}

export const LAST_STRUCTURAL_PARENT_ERROR =
  'Cannot change the last STRUCTURAL parent to another type: set another parent to STRUCTURAL first.'

export type RelationTypeChangeResult =
  | { status: 'updated'; demotedParentIds: number[] }
  | { status: 'last_structural' }
  | { status: 'not_found' }

/**
 * 関係の種別を変更する。「STRUCTURALな親は1つ」の原則を守る:
 * - STRUCTURAL に変える: 同じ子の他の STRUCTURAL の親を REFERENCE に矯正し、矯正した親を返す
 * - STRUCTURAL 以外に変える: 同じ子に他の STRUCTURAL の親がいない（＝最後の STRUCTURAL）なら拒否する
 * 判定は UPDATE 文に埋め込み、判定と書き込みの間に競合を挟まない。
 */
export async function setRelationType(
  db: D1Database,
  parentId: number,
  childId: number,
  relationTypeId: number,
): Promise<RelationTypeChangeResult> {
  if (relationTypeId === STRUCTURAL_RELATION_TYPE_ID) {
    const [updated, demoted] = await db.batch([
      db.prepare('UPDATE node_relations SET relation_type_id = ? WHERE parent_node_id = ? AND child_node_id = ?')
        .bind(STRUCTURAL_RELATION_TYPE_ID, parentId, childId),
      // 対象の関係が存在するときだけ矯正する（存在しないのに他の親を書き換えない）
      db.prepare(
        `UPDATE node_relations SET relation_type_id = ${REFERENCE_RELATION_TYPE_ID}
         WHERE child_node_id = ? AND parent_node_id <> ? AND relation_type_id = ${STRUCTURAL_RELATION_TYPE_ID}
           AND EXISTS (SELECT 1 FROM node_relations t WHERE t.parent_node_id = ? AND t.child_node_id = ?)
         RETURNING parent_node_id`
      ).bind(childId, parentId, parentId, childId),
    ])
    if (updated.meta.changes === 0) return { status: 'not_found' }
    const demotedParentIds = (demoted.results as Array<{ parent_node_id: number }>).map((row) => Number(row.parent_node_id))
    return { status: 'updated', demotedParentIds }
  }

  const result = await db.prepare(
    `UPDATE node_relations SET relation_type_id = ?
     WHERE parent_node_id = ? AND child_node_id = ?
       AND NOT (relation_type_id = ${STRUCTURAL_RELATION_TYPE_ID}
                AND NOT EXISTS (SELECT 1 FROM node_relations o
                                WHERE o.child_node_id = ? AND o.parent_node_id <> ?
                                  AND o.relation_type_id = ${STRUCTURAL_RELATION_TYPE_ID}))`
  ).bind(relationTypeId, parentId, childId, childId, parentId).run()
  if (result.meta.changes > 0) return { status: 'updated', demotedParentIds: [] }

  // 0件: 関係が無いか、最後の STRUCTURAL のため拒否された
  const exists = await db.prepare('SELECT 1 AS exists_flag FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?')
    .bind(parentId, childId).first<{ exists_flag: number }>()
  return exists?.exists_flag === 1 ? { status: 'last_structural' } : { status: 'not_found' }
}
