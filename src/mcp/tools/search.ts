import type { McpToolContext } from '../tool-context'
import { buildAncestorPathMaps, resolveNodePathInfo } from '../support'
import { parseSearchQuery } from '../../services/search'
import { withTimeout } from '../../utils/async'
import { getAccessibleNodeIds } from '../../utils/node-relations'
import { encodeNodeIds, isValidPublicNodeId, resolvePublicNodeId } from '../../utils/public-id'
import { buildLikeClause } from '../../utils/search-like'
import { generateEmbedding, vectorSearch } from '../../utils/vector'

export async function searchNodes(ctx: McpToolContext) {
  const { id, args, db, env, principal, treeRow, accessibleSet, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  const rawKeywordArg = args.keyword !== undefined ? args.keyword : args.query
  if (rawKeywordArg === undefined || String(rawKeywordArg).trim() === '') {
    return makeRpcResponse({ id, result: toolError('keyword is required (query is accepted as alias)') })
  }
  const { normalized: keyword, terms } = parseSearchQuery(rawKeywordArg)
  const { terms: excludeTerms } = parseSearchQuery(args.exclude_keywords || '')
  const matchModeRaw = args.match_mode === undefined ? 'and' : String(args.match_mode).toLowerCase()
  // only_title=true はタイトルのみを検索対象にする（ベクトル検索もスキップ）
  const onlyTitleRaw = args.only_title === undefined ? 'false' : String(args.only_title).toLowerCase()
  if (onlyTitleRaw !== 'true' && onlyTitleRaw !== 'false') {
    return makeRpcResponse({ id, result: toolError('Invalid only_title (boolean)') })
  }
  const onlyTitle = onlyTitleRaw === 'true'
  const sortByRaw = args.sort_by === undefined ? 'updated_at' : String(args.sort_by).toLowerCase()
  const sortOrderRaw = args.sort_order === undefined ? 'desc' : String(args.sort_order).toLowerCase()
  const limitRaw = args.limit === undefined ? 20 : parseInt(String(args.limit), 10)
  const offsetRaw = args.offset === undefined ? 0 : parseInt(String(args.offset), 10)
  if (matchModeRaw !== 'and' && matchModeRaw !== 'or') {
    return makeRpcResponse({ id, result: toolError('Invalid match_mode (and/or)') })
  }
  if (sortByRaw !== 'created_at' && sortByRaw !== 'updated_at') {
    return makeRpcResponse({ id, result: toolError('Invalid sort_by (created_at/updated_at)') })
  }
  if (sortOrderRaw !== 'asc' && sortOrderRaw !== 'desc') {
    return makeRpcResponse({ id, result: toolError('Invalid sort_order (asc/desc)') })
  }
  if (!Number.isFinite(limitRaw) || limitRaw <= 0) {
    return makeRpcResponse({ id, result: toolError('Invalid limit') })
  }
  if (!Number.isFinite(offsetRaw) || offsetRaw < 0) {
    return makeRpcResponse({ id, result: toolError('Invalid offset') })
  }
  const limit = Math.min(limitRaw, 100)
  const offset = offsetRaw

  const parentNodeIdRaw = args.parent_node_id
  let startNodeId = principal.root_node_id
  if (parentNodeIdRaw !== undefined) {
    if (!isValidPublicNodeId(parentNodeIdRaw)) {
      return makeRpcResponse({ id, result: toolError('Invalid parent_node_id') })
    }
    const resolvedParent = await resolvePublicNodeId(db, treeRow.tree_id, String(parentNodeIdRaw))
    if (!resolvedParent) {
      return makeRpcResponse({ id, result: toolError('parent_node_id not found') })
    }
    if (!accessibleSet.has(resolvedParent)) {
      return makeRpcResponse({ id, result: toolError('Access denied to parent_node_id') })
    }
    startNodeId = resolvedParent
  }

  if (terms.length === 0) {
    return makeRpcResponse({
      id,
      result: toToolResult({
        items: [],
        limit,
        offset,
        returned: 0,
        has_more: false,
      }),
    })
  }

  const includeJoiner = matchModeRaw === 'or' ? ' OR ' : ' AND '
  // 長い検索語は D1 の LIKE パターン長制限(約50バイト)を超えないよう分割して AND 条件化する
  const include = buildLikeClause(terms, includeJoiner, false, onlyTitle)
  const includeBinds = include.binds
  const exclude = buildLikeClause(excludeTerms, ' AND ', true, onlyTitle)
  const excludeBinds = exclude.binds
  const whereClause = [`(${include.clause})`, ...(exclude.clause ? [exclude.clause] : [])].join(' AND ')
  const sortColumn = sortByRaw === 'created_at' ? 'n.created_at' : 'n.updated_at'
  const sortDirection = sortOrderRaw === 'asc' ? 'ASC' : 'DESC'

  const wordSearchPromise = db.prepare(
    `WITH RECURSIVE scoped(id) AS (
       SELECT ?
       UNION
       SELECT nr.child_node_id
       FROM node_relations nr
       JOIN scoped s ON nr.parent_node_id = s.id
     ),
     filtered AS (
       SELECT n.id, n.title, n.created_at, n.updated_at, n.version
       FROM nodes n
       JOIN scoped s ON s.id = n.id
       WHERE ${whereClause}
       ORDER BY ${sortColumn} ${sortDirection}, n.id ASC
       LIMIT ? OFFSET ?
     )
     SELECT * FROM filtered`
  ).bind(startNodeId, ...includeBinds, ...excludeBinds, limit + 1, offset).all<{
    id: number
    title: string
    created_at: string
    updated_at: string
    version: number
  }>().catch((e) => {
    // ワード検索の失敗（例: D1 の LIKE 制限）で検索全体を殺さず、ベクトル結果だけでも返す
    console.error('[search_nodes] word search failed:', e)
    return { results: [] as { id: number; title: string; created_at: string; updated_at: string }[] }
  })

  // ベクトル検索（API キースコープのツリーで tree_id フィルタ・アクセス制御は D1 側でも多層防御）
  const vectorSearchMcpPromise = (async (): Promise<number[]> => {
    // only_title 指定時は本文の意味マッチを結果に混ぜない
    if (onlyTitle) return []
    if (!env?.AI || !env?.VECTORIZE || !keyword) return []
    const emb = await withTimeout(generateEmbedding(env.AI, keyword), 5000, null)
    if (!emb) return []
    return withTimeout(vectorSearch(env.VECTORIZE, emb, treeRow.tree_id, 20), 5000, [] as number[])
  })()

  // parent_node_id（配下スコープ）の子孫ID集合。vectorSearch は tree_id でしか
  // 絞れないため、ここで取得した子孫集合とベクトル結果の積を取って配下外を除外する。
  // startNodeId が principal.root_node_id と同じ（配下指定なし）場合は accessibleSet と
  // 一致するが、正しさを優先して都度計算する。
  const scopedIdsPromise = getAccessibleNodeIds(db, startNodeId)

  const [{ results: pagedRows }, vectorNodeIds, scopedIds] = await Promise.all([
    wordSearchPromise,
    vectorSearchMcpPromise,
    scopedIdsPromise,
  ])
  const scopedSet = new Set(scopedIds)

  const hasMore = (pagedRows || []).length > limit
  const visibleRows = hasMore ? (pagedRows || []).slice(0, limit) : (pagedRows || [])

  queueAuditLog({ userId: principal.user_id, action: 'mcp.read.search', targetType: 'tree', targetId: startNodeId, treeId: treeRow.tree_id, source: 'mcp' })

  const wordIdSet = new Set(visibleRows.map((r) => r.id))
  // accessibleSet で他ツリーのノードを、scopedSet で配下外のノードを除外してからベクトル専用IDを絞る
  const vectorOnlyIds = vectorNodeIds.filter((id) => !wordIdSet.has(id) && accessibleSet.has(id) && scopedSet.has(id))

  // 公開IDへの一括変換
  const allInternalIds = new Set<number>(visibleRows.map((r) => r.id))
  vectorOnlyIds.forEach((id) => allInternalIds.add(id))
  const publicIdMap = await encodeNodeIds(db, Array.from(allInternalIds))
  // path は返却する全ノード（語句ヒット＋ベクトル専用）の祖先だけから組み立てる
  const pathMaps = await buildAncestorPathMaps(db, startNodeId, Array.from(allInternalIds))

  // ベクトル専用ノードの詳細を D1 から取得
  let vectorOnlyItems: any[] = []
  if (vectorOnlyIds.length > 0) {
    const placeholders = vectorOnlyIds.map(() => '?').join(',')
    const { results: vectorRows } = await db.prepare(
       `SELECT n.id, n.title, n.created_at, n.updated_at, n.version
       FROM nodes n WHERE n.id IN (${placeholders})`
    ).bind(...vectorOnlyIds).all<{ id: number; title: string; created_at: string; updated_at: string; version: number }>()
    const rowMap = new Map((vectorRows || []).map((r) => [r.id, r]))
    vectorOnlyItems = vectorOnlyIds
      .map((id) => {
        const row = rowMap.get(id)
        if (!row) return null
        const pathInfo = resolveNodePathInfo(row.id, row.title, pathMaps, publicIdMap.get(row.id))
        return {
          id: publicIdMap.get(row.id) ?? String(row.id),
          title: row.title,
          relation_type_name: pathInfo.relation_type_name,
          path: pathInfo.path,
          created_at: row.created_at,
          updated_at: row.updated_at,
          version: row.version,
          path_relation_mode: pathInfo.path_relation_mode,
        }
      })
      .filter(Boolean)
  }

  const wordItems = visibleRows.map((row) => {
    const pathInfo = resolveNodePathInfo(row.id, row.title, pathMaps, publicIdMap.get(row.id))
    return {
      id: publicIdMap.get(row.id) ?? String(row.id),
      title: row.title,
      relation_type_name: pathInfo.relation_type_name,
      path: pathInfo.path,
      created_at: row.created_at,
      updated_at: row.updated_at,
      version: row.version,
      path_relation_mode: pathInfo.path_relation_mode,
    }
  })

  return makeRpcResponse({
    id,
    result: toToolResult({
      word: wordItems,
      vector: vectorOnlyItems,
      items: [...wordItems, ...vectorOnlyItems],
      word_count: wordItems.length,
      vector_count: vectorOnlyItems.length,
      limit,
      offset,
      returned: wordItems.length + vectorOnlyItems.length,
      has_more: hasMore,
      ...(hasMore ? { next_offset: offset + visibleRows.length } : {}),
    }),
  })
}
