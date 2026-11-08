import { splitIntoChunks, chunkVectorId, nodeIdFromVectorId, staleChunkIds, allChunkIdsForDelete } from './vector-chunk'

// ============================================================
// Vectorize ユーティリティ
// ============================================================

export function buildNodeVectorText(pathText: string, content: string | null | undefined): string {
  const body = String(content || '').trim()
  return body ? `${pathText}\n\n${body}` : pathText
}

export async function generateEmbedding(ai: Ai | undefined, text: string): Promise<number[] | null> {
  if (!ai) return null
  try {
    const response = await (ai as any).run('@cf/baai/bge-m3', { text: [text] })
    const vectors = response?.data?.[0]
    return Array.isArray(vectors) && vectors.length > 0 ? (vectors as number[]) : null
  } catch (e) {
    console.error('[vectorize] embed failed:', e)
    return null
  }
}

export async function generateEmbeddingsBatch(
  ai: Ai | undefined,
  texts: string[],
): Promise<(number[] | null)[]> {
  if (!ai || texts.length === 0) return texts.map(() => null)
  try {
    const response = await (ai as any).run('@cf/baai/bge-m3', { text: texts })
    const data = response?.data
    if (!Array.isArray(data)) return texts.map(() => null)
    return texts.map((_, i) => {
      const v = data[i]
      return Array.isArray(v) && v.length > 0 ? (v as number[]) : null
    })
  } catch (e) {
    console.error('[vectorize] batch embed failed, falling back to individual calls:', e)
    // バッチ失敗時は1件ずつフォールバック（大きなコンテンツが混在している場合に対応）
    return Promise.all(texts.map((text) => generateEmbedding(ai, text)))
  }
}

// ベクトル検索の類似度下限（cosine）。これ未満のマッチはノイズとして足切りする（P3）。
// 2026-07-20 に本番データでキャリブレーション: 関連クエリの上位10件は 0.55-0.66、
// 無関係クエリ（例: カレーの作り方）は最高でも 0.47 → ギャップの中間 0.50 を採用。
// recall が落ちたと感じたら 0.45 程度まで下げて再調整する。
const VECTOR_SCORE_MIN = 0.5

export async function vectorSearch(
  vectorize: VectorizeIndex | undefined,
  queryVector: number[],
  treeId: number | undefined,
  topK = 20,
): Promise<number[]> {
  if (!vectorize) return []
  try {
    // チャンク化により1ノードが複数ベクトル（`${nodeId}#${idx}`）を持つため、
    // チャンク単位で多めに取得し、ノード単位に集約（最良スコアのチャンクを採用）する。
    // matches はスコア降順なので、先着のチャンク＝そのノードの最良チャンク。
    const rawTopK = Math.min(100, Math.max(topK, topK * 4))
    // tree_id メタデータフィルタで自ツリーに絞り込み、枠を他ツリーに浪費しない。
    // treeId 未指定時のみ全ツリー横断（後方互換）。アクセス制御は D1 側でも多層防御。
    const queryOptions: Record<string, unknown> = {
      topK: rawTopK,
      returnValues: false,
      returnMetadata: 'none',
    }
    if (treeId !== undefined) {
      queryOptions.filter = { tree_id: treeId }
    }
    const result = await vectorize.query(queryVector, queryOptions as any)
    const seen = new Set<number>()
    const nodeIds: number[] = []
    for (const m of result.matches || []) {
      // matches はスコア降順なので、しきい値を下回ったら以降は全てノイズ
      if (m.score < VECTOR_SCORE_MIN) break
      const nodeId = nodeIdFromVectorId(String(m.id))
      if (!Number.isFinite(nodeId) || seen.has(nodeId)) continue
      seen.add(nodeId)
      nodeIds.push(nodeId)
      if (nodeIds.length >= topK) break
    }
    return nodeIds
  } catch (e) {
    console.error('[vectorize] query failed:', e)
    return []
  }
}

// ノードのフルパス（`root > ... > title`）を親を辿って構築する（埋め込み用）。
// realtime upsert と bulk sync の両方で使う（bulk での全件スキャン地図を廃止するため共通化）。
// STRUCTURAL 親を優先し、STRUCTURAL 親を持たないノードは全リレーションで fallback する
// （表示側 resolveNodePathInfo の structural_only → fallback_non_structural と同じ規則。P4）。
export async function getNodePathText(db: D1Database, nodeId: number): Promise<string> {
  const buildPathUp = async (structuralOnly: boolean): Promise<string | null> => {
    const relationFilter = structuralOnly ? 'AND nr.relation_type_id = 1' : ''
    // CROSS JOIN で path_up を外側に固定する。通常の JOIN だとプランナーが node_relations を外側にし、
    // relation_type のインデックスで同じタイプの関係を1段ごとに全件読む（本番で1回約17万行）。
    const pathRow = await db.prepare(`
      WITH RECURSIVE path_up(node_id, path_text, depth) AS (
        SELECT n.id, n.title, 0
        FROM nodes n WHERE n.id = ?
        UNION ALL
        SELECT nr.parent_node_id,
               n2.title || ' > ' || path_up.path_text,
               path_up.depth + 1
        FROM path_up
        CROSS JOIN node_relations nr ON nr.child_node_id = path_up.node_id
        JOIN nodes n2 ON n2.id = nr.parent_node_id
        WHERE path_up.depth < 100 ${relationFilter}
      )
      SELECT path_text FROM path_up ORDER BY depth DESC LIMIT 1
    `).bind(nodeId).first<{ path_text: string }>()
    return pathRow?.path_text ?? null
  }

  // STRUCTURAL 親の有無で経路を選ぶ（タイトルに ' > ' が含まれても誤判定しないよう存在確認で分岐）
  const hasStructuralParent = await db.prepare(
    'SELECT 1 FROM node_relations WHERE child_node_id = ? AND relation_type_id = 1 LIMIT 1'
  ).bind(nodeId).first()

  const pathText = hasStructuralParent
    ? await buildPathUp(true)
    : await buildPathUp(false)
  return pathText || String(nodeId)
}

export async function upsertNodeVector(
  ai: Ai | undefined,
  vectorize: VectorizeIndex | undefined,
  db: D1Database,
  nodeId: number,
): Promise<void> {
  if (!ai || !vectorize) return

  const pathText = await getNodePathText(db, nodeId)

  const nodeRow = await db.prepare(
    `SELECT content, tree_id FROM nodes WHERE id = ?`
  ).bind(nodeId).first<{ content: string | null; tree_id: number }>()

  if (!nodeRow) return

  // コンテンツをチャンク分割し、各チャンクをパス文脈付きで個別ベクトル化する。
  const chunks = splitIntoChunks(nodeRow.content)
  const texts = chunks.map((chunk) => buildNodeVectorText(pathText, chunk))
  const embeddings = await generateEmbeddingsBatch(ai, texts)

  const vectors: VectorizeVector[] = []
  for (let i = 0; i < chunks.length; i++) {
    const embedding = embeddings[i]
    if (!embedding) continue
    vectors.push({
      id: chunkVectorId(nodeId, i),
      values: embedding,
      metadata: { node_id: nodeId, tree_id: nodeRow.tree_id, chunk_idx: i },
    })
  }

  if (vectors.length > 0) {
    await vectorize.upsert(vectors)
  }

  // 旧単一ベクトル（チャンク化前）と、今回のチャンク数を超える古いチャンクを掃除する。
  // 掃除の基準は「使用したチャンクスロット数（chunks.length）」であり、embedding 失敗で
  // 歯抜けになった vectors.length ではない（有効な高インデックスを誤削除しないため）。
  // 存在しない ID の削除は no-op のため安全。
  try {
    await vectorize.deleteByIds(staleChunkIds(nodeId, chunks.length))
  } catch (e) {
    console.error('[vectorize] stale chunk cleanup failed:', e)
  }
}

export async function deleteNodeVector(
  vectorize: VectorizeIndex | undefined,
  nodeId: number,
): Promise<void> {
  if (!vectorize) return
  try {
    // 全チャンク（＋旧単一ベクトル）を削除する。
    await vectorize.deleteByIds(allChunkIdsForDelete(nodeId))
  } catch (e) {
    console.error('[vectorize] delete failed:', e)
  }
}

// ============================================================
