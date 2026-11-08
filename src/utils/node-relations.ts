export type CircularCheckStatus = 'cycle_detected' | 'no_cycle' | 'indeterminate'

export type CircularCheckContext = {
  route: string
  treeId?: number | null
  parentId: number
  childId: number
}

export const CIRCULAR_CHECK_INDETERMINATE_MESSAGE = 'Circular reference check timed out or failed; request rejected'

function isCircularCheckTimeoutLikeErrorMessage(message: string): boolean {
  const lower = String(message || '').toLowerCase()
  return (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('cpu time') ||
    lower.includes('exceeded') ||
    lower.includes('deadline')
  )
}

export async function checkCircularReference(
  db: D1Database,
  parentId: number,
  childId: number,
  context: CircularCheckContext
): Promise<CircularCheckStatus> {
  const start = Date.now()
  try {
    // childIdから子孫を辿ってparentIdに到達できる場合、parentId->childId追加で循環になる
    const result = await db.prepare(`
      WITH RECURSIVE descendants AS (
        SELECT child_node_id AS descendant_id, 1 AS depth
        FROM node_relations
        WHERE parent_node_id = ?
        UNION ALL
        SELECT nr.child_node_id, d.depth + 1
        FROM node_relations nr
        INNER JOIN descendants d ON nr.parent_node_id = d.descendant_id
        WHERE d.depth < 100
      )
      SELECT CASE
        WHEN EXISTS(
          SELECT 1
          FROM descendants
          WHERE descendant_id = ? OR depth >= 100
        ) THEN 1
        ELSE 0
      END AS found
    `).bind(childId, parentId).first<{ found: number }>()

    const elapsedMs = Date.now() - start
    if (!result || (result.found !== 0 && result.found !== 1)) {
      console.warn('[circular-check] indeterminate (null result)', {
        route: context.route,
        tree_id: context.treeId ?? null,
        parent_id: context.parentId,
        child_id: context.childId,
        elapsed_ms: elapsedMs,
        error_message: 'null result',
      })
      return 'indeterminate'
    }

    return result.found === 1 ? 'cycle_detected' : 'no_cycle'
  } catch (error) {
    const elapsedMs = Date.now() - start
    const errorMessage = String(error)
    const isTimeoutLike = isCircularCheckTimeoutLikeErrorMessage(errorMessage)
    const logPrefix = isTimeoutLike ? '[circular-check][timeout]' : '[circular-check][error]'
    console.error(logPrefix, {
      route: context.route,
      tree_id: context.treeId ?? null,
      parent_id: context.parentId,
      child_id: context.childId,
      elapsed_ms: elapsedMs,
      error_message: errorMessage,
    })
    return 'indeterminate'
  }
}

export async function getAccessibleNodeIds(db: D1Database, rootNodeId: number): Promise<number[]> {
  const { results } = await db.prepare(
    `WITH RECURSIVE accessible(id) AS (
       SELECT ?
       UNION
       SELECT nr.child_node_id
       FROM node_relations nr
       JOIN accessible a ON nr.parent_node_id = a.id
     )
     SELECT id FROM accessible`
  ).bind(rootNodeId).all<{ id: number }>()

  return (results || []).map(r => Number(r.id)).filter(Number.isFinite)
}
