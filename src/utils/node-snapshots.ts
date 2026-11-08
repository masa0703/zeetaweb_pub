import { D1_IN_CLAUSE_BATCH } from './public-id'

export type NodeSnapshotSource = 'ui' | 'mcp'

export type InsertNodeSnapshotParams = {
  nodeId: number
  content: string | null
  nodeVersion: number
  userId: number | null
  source: NodeSnapshotSource
  clientId: string | null
}

export type NodeSnapshotRow = {
  id: number
  node_id: number
  content: string | null
  node_version: number
  user_id: number | null
  source: NodeSnapshotSource
  client_id: string | null
  created_at: string
}

/**
 * スナップショット INSERT の prepared statement を返す。
 *
 * content を更新する経路は必ずこの文を UPDATE と同じ `db.batch([...])` に入れる。
 * INSERT と UPDATE を別々に await すると、version ガードで UPDATE が0行になった
 * とき（競合に負けたとき）スナップショットだけが残り、現在の内容と同一の
 * 「戻しても何も変わらない undo 候補」が履歴に積まれる。
 *
 * batch は purge を含まないので、書き込み成功後に
 * `schedulePurgeNodeSnapshots` を呼ぶこと。
 */
export function nodeSnapshotInsertStatement(
  db: D1Database,
  params: InsertNodeSnapshotParams,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO node_snapshots
       (node_id, content, node_version, user_id, source, client_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    params.nodeId,
    params.content,
    params.nodeVersion,
    params.userId,
    params.source,
    params.clientId,
  )
}

export async function purgeNodeSnapshots(db: D1Database, nodeId: number): Promise<void> {
  await db.prepare(
    `DELETE FROM node_snapshots
     WHERE node_id = ?
       AND id NOT IN (
         SELECT id FROM node_snapshots
         WHERE node_id = ?
         ORDER BY node_version DESC, id DESC
         LIMIT 100
       )`
  ).bind(nodeId, nodeId).run()
}

export async function readNodeSnapshots(
  db: D1Database,
  nodeId: number,
  limit = 20,
): Promise<NodeSnapshotRow[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))
  const result = await db.prepare(
    `SELECT id, node_id, content, node_version, user_id, source, client_id, created_at
     FROM node_snapshots
     WHERE node_id = ?
     ORDER BY node_version DESC, id DESC
     LIMIT ?`
  ).bind(nodeId, safeLimit).all<NodeSnapshotRow>()
  return result.results || []
}

/**
 * そのノードの保持スナップショット総数。
 *
 * `readNodeSnapshots` は limit を最大100に丸めるため、返却件数からは
 * 「上限100が効いているか」を判定できない（壊れて105件残っていても100件返る）。
 * purge の検証はこの総数で行う。
 */
export async function countNodeSnapshots(db: D1Database, nodeId: number): Promise<number> {
  const row = await db.prepare(
    'SELECT COUNT(*) AS total FROM node_snapshots WHERE node_id = ?'
  ).bind(nodeId).first<{ total: number }>()
  return row?.total ?? 0
}

/**
 * 保持ポリシー（1ノード100件）の適用を応答からデタッチして走らせる。
 *
 * purge は保持数を削るだけで書き込み本体の正しさには関わらないため、
 * 失敗しても呼び出し側の応答を失敗させない。`waitUntil` が無い環境
 * （テスト等）では取りこぼすと保持上限の検証ができなくなるので await する。
 */
export async function schedulePurgeNodeSnapshots(
  db: D1Database,
  nodeId: number,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<void> {
  const promise = purgeNodeSnapshots(db, nodeId).catch(() => {})
  if (waitUntil) {
    waitUntil(promise)
    return
  }
  await promise
}

export async function purgeNodeSnapshotsForNodes(db: D1Database, nodeIds: number[]): Promise<void> {
  if (nodeIds.length === 0) return
  // D1 のバインド変数上限（100/クエリ）を超えないよう分割して batch で一括実行する
  const statements = []
  for (let i = 0; i < nodeIds.length; i += D1_IN_CLAUSE_BATCH) {
    const slice = nodeIds.slice(i, i + D1_IN_CLAUSE_BATCH)
    const placeholders = slice.map(() => '?').join(', ')
    statements.push(db.prepare(`DELETE FROM node_snapshots WHERE node_id IN (${placeholders})`).bind(...slice))
  }
  await db.batch(statements)
}
