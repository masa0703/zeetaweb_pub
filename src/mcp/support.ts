import { D1_IN_CLAUSE_BATCH } from '../utils/public-id'
import { buildNodeImageFileUrl } from '../utils/node-images'
import { storeNodeImage, validateNodeImage, type NodeImageRejection } from '../services/node-images'

export type RelationTypeName = 'STRUCTURAL' | 'REFERENCE'

export const NODE_CHILD_SORT_MODES = new Set(['manual', 'created_at', 'updated_at', 'title'])
export const NODE_CHILD_SORT_DIRECTIONS = new Set(['asc', 'desc'])

export type McpNodeRow = {
  id: number
  title: string
  content: string | null
  author: string | null
  created_at: string
  updated_at: string
  version: number
  child_sort_mode: string
  child_sort_direction: string
}

export function toMcpNode(row: McpNodeRow) {
  return {
    id: row.id,
    title: row.title,
    content: row.content || '',
    author: row.author || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
    child_sort_mode: row.child_sort_mode || 'manual',
    child_sort_direction: row.child_sort_direction || 'asc',
  }
}

export type McpNodeImageMeta = {
  id: number
  filename: string
  content_type: string
}

export async function listMcpNodeImageMetadata(
  db: D1Database,
  treeId: number,
  nodeIds: number[],
): Promise<Map<number, McpNodeImageMeta[]>> {
  const uniqueNodeIds = [...new Set(nodeIds)]
  const imagesByNodeId = new Map<number, McpNodeImageMeta[]>()
  if (uniqueNodeIds.length === 0) return imagesByNodeId

  // D1 のバインド変数上限（100/クエリ）を超えないよう分割して取得する。
  // get_children の limit=100 + include_images=true で tree_id 1個 + 100件 = 101バインドになり
  // "too many SQL variables" で失敗していた。
  for (let i = 0; i < uniqueNodeIds.length; i += D1_IN_CLAUSE_BATCH) {
    const slice = uniqueNodeIds.slice(i, i + D1_IN_CLAUSE_BATCH)
    const placeholders = slice.map(() => '?').join(', ')
    const { results } = await db.prepare(
      `SELECT node_id, id, file_name, mime_type
       FROM node_images
       WHERE tree_id = ? AND node_id IN (${placeholders})
       ORDER BY node_id, serial_no ASC`
    ).bind(treeId, ...slice).all<{
      node_id: number
      id: number
      file_name: string
      mime_type: string
    }>()

    for (const row of results || []) {
      const items = imagesByNodeId.get(row.node_id) || []
      items.push({
        id: row.id,
        filename: row.file_name,
        content_type: row.mime_type,
      })
      imagesByNodeId.set(row.node_id, items)
    }
  }

  return imagesByNodeId
}

export async function createMcpNodeImage(
  db: D1Database,
  imageBucket: R2Bucket,
  treeId: number,
  nodeId: number,
  nodePublicId: string,
  filenameRaw: string,
  contentTypeRaw: string,
  bytes: Uint8Array,
  actorUserId: number,
): Promise<{ image_id: number; url: string }> {
  const validation = validateNodeImage(bytes.byteLength, contentTypeRaw, filenameRaw, bytes)
  if (!validation.ok) {
    throw new Error(MCP_IMAGE_REJECTION_MESSAGES[validation.reason])
  }

  const inserted = await storeNodeImage(db, imageBucket, {
    treeId,
    nodeId,
    fileNameRaw: filenameRaw,
    mimeType: validation.mimeType,
    fileExt: validation.fileExt,
    bytes,
    actorUserId,
  })
  if (!inserted) {
    throw new Error('Failed to save image metadata')
  }

  return {
    image_id: inserted.id,
    url: buildNodeImageFileUrl(treeId, nodePublicId, inserted.id),
  }
}

const MCP_IMAGE_REJECTION_MESSAGES: Record<NodeImageRejection, string> = {
  empty: 'data_base64 is empty',
  too_large: 'Image is too large (max 5MB)',
  unsupported_mime: 'Only image content_type is allowed',
  unknown_ext: 'Failed to determine file extension',
  invalid_content: 'Image content does not match its MIME type',
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

export function base64ToUint8Array(base64Raw: string): Uint8Array | null {
  try {
    const normalized = String(base64Raw || '').trim()
    if (!normalized) return null
    const binary = atob(normalized)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  } catch {
    return null
  }
}

export function relationTypeNameFromId(relationTypeId: number): RelationTypeName {
  if (relationTypeId === 3) return 'REFERENCE'
  return 'STRUCTURAL'
}

export function resolveRelationTypeId(
  relationType: unknown,
  relationTypeIdRaw: unknown,
): number | null {
  if (relationType !== undefined) {
    if (relationType === null) return 1
    const normalized = String(relationType).trim().toUpperCase()
    if (!normalized || normalized === 'STRUCTURAL') return 1
    if (normalized === 'REFERENCE') return 3
    return null
  }

  if (relationTypeIdRaw === undefined || relationTypeIdRaw === null || relationTypeIdRaw === '') {
    return 1
  }

  const relationTypeId = parseInt(String(relationTypeIdRaw))
  if (![1, 3].includes(relationTypeId)) {
    return null
  }
  return relationTypeId
}

export function toRelationTypeName(relationTypeId: number | null | undefined, relationTypeName: string | null | undefined): string {
  const normalizedName = String(relationTypeName || '').trim().toUpperCase()
  if (normalizedName === 'REFERENCE' || normalizedName === 'STRUCTURAL') {
    return normalizedName
  }
  if (relationTypeId === 3) return 'REFERENCE'
  return 'STRUCTURAL'
}

function buildSearchPathIndex(
  startNodeId: number,
  nodesById: Map<number, SearchScopeNodeRow>,
  relations: SearchScopeRelationRow[],
  structuralOnly: boolean,
): Map<number, SearchPathInfo> {
  const mode: SearchPathInfo['mode'] = structuralOnly ? 'structural_only' : 'fallback_non_structural'
  const adjacency = new Map<number, Array<{ childId: number; relationTypeName: string; relationTypeId: number | null }>>()

  relations.forEach((rel) => {
    const relName = toRelationTypeName(rel.relation_type_id, rel.relation_type_name)
    if (structuralOnly && relName !== 'STRUCTURAL') return
    const list = adjacency.get(rel.parent_node_id) || []
    list.push({
      childId: rel.child_node_id,
      relationTypeName: relName,
      relationTypeId: rel.relation_type_id,
    })
    adjacency.set(rel.parent_node_id, list)
  })

  adjacency.forEach((list) => {
    list.sort((a, b) => {
      const aTitle = nodesById.get(a.childId)?.title || ''
      const bTitle = nodesById.get(b.childId)?.title || ''
      if (aTitle === bTitle) return a.childId - b.childId
      return aTitle.localeCompare(bTitle, 'ja')
    })
  })

  const startTitle = nodesById.get(startNodeId)?.title || `(id:${startNodeId})`
  // path の各セグメントには「タイトル (id:公開ID)」を付ける。public_id が取れない
  // ノード（データ不整合時）はタイトルのみで耐える
  const formatSegment = (nodeId: number, title: string): string => {
    const publicId = nodesById.get(nodeId)?.public_id
    return publicId ? `${title} (id:${publicId})` : title
  }
  const best = new Map<number, SearchPathInfo>()
  best.set(startNodeId, {
    depth: 0,
    path: formatSegment(startNodeId, startTitle),
    titlePath: startTitle,
    relationTypeName: 'STRUCTURAL',
    mode,
  })

  const queue: number[] = [startNodeId]
  let cursor = 0
  while (cursor < queue.length) {
    const currentNodeId = queue[cursor++]
    const current = best.get(currentNodeId)
    if (!current) continue
    const children = adjacency.get(currentNodeId) || []
    children.forEach((edge) => {
      const childTitle = nodesById.get(edge.childId)?.title || `(id:${edge.childId})`
      const candidateDepth = current.depth + 1
      const candidateTitlePath = `${current.titlePath} > ${childTitle}`
      const candidatePath = `${current.path} > ${formatSegment(edge.childId, childTitle)}`
      const existing = best.get(edge.childId)
      // タイブレークは (id:...) を含まないタイトル連結で行う。id付きで比較すると
      // 同名タイトル経路の選択結果が変わるため
      if (
        !existing ||
        candidateDepth < existing.depth ||
        (candidateDepth === existing.depth && candidateTitlePath.localeCompare(existing.titlePath, 'ja') < 0)
      ) {
        best.set(edge.childId, {
          depth: candidateDepth,
          path: candidatePath,
          titlePath: candidateTitlePath,
          relationTypeName: edge.relationTypeName,
          mode,
        })
        queue.push(edge.childId)
      }
    })
  }

  return best
}

// targetNodeIds の祖先（startNodeId より上は辿らない）を親方向の再帰で集める。
// start → 対象ノードの経路は必ず対象ノードの祖先だけを通るので、この部分グラフで
// buildSearchPathIndex を回せば、ツリー全体で回した場合と同じ経路が選ばれる。
// 2026-11-05: 以前はツリー全体（子孫方向の再帰CTEを2回JOIN）を毎回読んでおり、
// 1,958ノードのツリーで1回あたり約423万行を読んで D1 を overloaded にしていた。
const ANCESTORS_CTE = `WITH RECURSIVE anc(id) AS (
       SELECT value FROM json_each(?1)
       UNION
       SELECT nr.parent_node_id
       FROM node_relations nr
       JOIN anc a ON nr.child_node_id = a.id
       WHERE a.id <> ?2
     )`

export async function buildAncestorPathMaps(
  db: D1Database,
  startNodeId: number,
  targetNodeIds: number[],
): Promise<SearchPathMaps> {
  // json_each で1変数にまとめ、D1 のバインド変数上限（100）を避ける
  const targetsJson = JSON.stringify(Array.from(new Set([startNodeId, ...targetNodeIds])))
  const [nodesResult, relationsResult] = await db.batch([
    db.prepare(
      `${ANCESTORS_CTE}
       SELECT n.id, n.title, n.public_id
       FROM nodes n
       JOIN anc a ON a.id = n.id`
    ).bind(targetsJson, startNodeId),
    db.prepare(
      `${ANCESTORS_CTE}
       SELECT nr.parent_node_id, nr.child_node_id, nr.relation_type_id, COALESCE(rt.name, 'STRUCTURAL') AS relation_type_name
       FROM node_relations nr
       JOIN anc a ON a.id = nr.child_node_id
       LEFT JOIN relation_types rt ON rt.id = nr.relation_type_id
       WHERE nr.child_node_id <> ?2`
    ).bind(targetsJson, startNodeId),
  ])

  const nodesById = new Map<number, SearchScopeNodeRow>()
    ; ((nodesResult.results || []) as SearchScopeNodeRow[]).forEach((row) => nodesById.set(row.id, row))
  const relationRows = (relationsResult.results || []) as SearchScopeRelationRow[]

  return {
    structuralPathMap: buildSearchPathIndex(startNodeId, nodesById, relationRows, true),
    fallbackPathMap: buildSearchPathIndex(startNodeId, nodesById, relationRows, false),
  }
}

export function resolveNodePathInfo(
  nodeId: number,
  fallbackTitle: string,
  pathMaps: SearchPathMaps,
  fallbackPublicId?: string | null,
): { path: string; path_relation_mode: SearchPathInfo['mode']; relation_type_name: string } {
  const structuralPath = pathMaps.structuralPathMap.get(nodeId)
  const pathInfo = structuralPath || pathMaps.fallbackPathMap.get(nodeId)
  const fallbackSegment = fallbackPublicId
    ? `${fallbackTitle} (id:${fallbackPublicId})`
    : fallbackTitle || `(id:${nodeId})`
  return {
    relation_type_name: pathInfo?.relationTypeName || 'STRUCTURAL',
    path: pathInfo?.path || fallbackSegment,
    path_relation_mode: pathInfo?.mode || 'fallback_non_structural',
  }
}

type SearchScopeNodeRow = {
  id: number
  title: string
  public_id: string | null
}

type SearchScopeRelationRow = {
  parent_node_id: number
  child_node_id: number
  relation_type_id: number | null
  relation_type_name: string | null
}

export type SearchPathInfo = {
  depth: number
  path: string
  // 経路選定のタイブレーク用。セグメントに (id:...) を含まないタイトルのみの連結
  titlePath: string
  relationTypeName: string
  mode: 'structural_only' | 'fallback_non_structural'
}

export type SearchPathMaps = {
  structuralPathMap: Map<number, SearchPathInfo>
  fallbackPathMap: Map<number, SearchPathInfo>
}
