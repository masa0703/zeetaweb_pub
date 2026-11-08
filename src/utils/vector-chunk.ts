// ベクトル検索用のコンテンツ・チャンク分割ユーティリティ（P2）
//
// 長文ノードを1ベクトルにまとめると (a) 2000字以降が検索に出ない (b) 埋め込みが
// 平均化されて精度が落ちる（centroid drift）ため、コンテンツをオーバーラップ付きの
// チャンクに分割し、各チャンクを個別ベクトル（id = `${nodeId}#${chunkIdx}`）にする。

export const CHUNK_SIZE = 800
export const CHUNK_OVERLAP = 120
// 1ノードあたりのチャンク上限。これを超える分は打ち切る（暗黙の欠落を避けるため呼び出し側でログ）。
// 掃除（stale チャンク削除）の探索範囲もこの値を上限にする。
export const MAX_CHUNKS_PER_NODE = 50

/**
 * コンテンツをオーバーラップ付きチャンクに分割する。
 * - 空文字/短文（<= CHUNK_SIZE）は 1 要素配列で返す（空文字なら `['']` = タイトルのみノード）。
 * - MAX_CHUNKS_PER_NODE で打ち切る（超過分は捨てる）。
 */
export function splitIntoChunks(content: string | null | undefined): string[] {
  const text = String(content ?? '')
  if (text.length <= CHUNK_SIZE) return [text]

  const step = Math.max(1, CHUNK_SIZE - CHUNK_OVERLAP)
  const chunks: string[] = []
  let start = 0
  while (start < text.length && chunks.length < MAX_CHUNKS_PER_NODE) {
    chunks.push(text.slice(start, start + CHUNK_SIZE))
    start += step
  }
  return chunks
}

/** チャンクベクトルの ID を生成する（`${nodeId}#${chunkIdx}`）。 */
export function chunkVectorId(nodeId: number, chunkIdx: number): string {
  return `${nodeId}#${chunkIdx}`
}

/**
 * ベクトル ID からノード内部 ID を取り出す。
 * - 新方式 `123#2` → 123
 * - 旧方式（チャンク化前）`123` → 123（移行期の後方互換）
 * - 解釈できない場合は NaN
 */
export function nodeIdFromVectorId(vectorId: string): number {
  const raw = String(vectorId)
  const hashIdx = raw.indexOf('#')
  const idPart = hashIdx === -1 ? raw : raw.slice(0, hashIdx)
  return Number(idPart)
}

/**
 * あるノードを newChunkCount 個のチャンクで upsert する際、削除すべき stale な
 * ベクトル ID の一覧を返す。
 * - 旧方式の単一ベクトル `${nodeId}`（チャンク化前の名残）
 * - 新チャンク数を超える古いチャンク `${nodeId}#${i}`（i >= newChunkCount）
 * 存在しない ID を deleteByIds に渡しても no-op なので安全。
 */
export function staleChunkIds(nodeId: number, newChunkCount: number): string[] {
  const ids: string[] = [String(nodeId)]
  for (let i = Math.max(0, newChunkCount); i < MAX_CHUNKS_PER_NODE; i++) {
    ids.push(chunkVectorId(nodeId, i))
  }
  return ids
}

/** あるノードの全チャンク（＋旧単一ベクトル）を削除するための ID 一覧。 */
export function allChunkIdsForDelete(nodeId: number): string[] {
  return staleChunkIds(nodeId, 0)
}
