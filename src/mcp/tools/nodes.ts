import type { McpToolContext } from '../tool-context'
import {
  NODE_CHILD_SORT_DIRECTIONS,
  NODE_CHILD_SORT_MODES,
  RelationTypeName,
  McpNodeRow,
  McpNodeImageMeta,
  buildAncestorPathMaps,
  listMcpNodeImageMetadata,
  relationTypeNameFromId,
  resolveNodePathInfo,
  resolveRelationTypeId,
  toMcpNode,
} from '../support'
import {
  NODE_CONTENT_MAX_LENGTH,
  NODE_TITLE_MAX_LENGTH,
  validateTextLimit,
  assertNodeQuota,
} from '../../utils/request-safety'
import {
  encodeNodeIds,
  isValidPublicNodeId,
  resolvePublicNodeId,
  resolvePublicNodeIds,
  withPublicIdRetry,
} from '../../utils/public-id'
import { nodeSnapshotInsertStatement, schedulePurgeNodeSnapshots } from '../../utils/node-snapshots'
import { deleteNodeVector, upsertNodeVector } from '../../utils/vector'

export async function getRootNodeId(ctx: McpToolContext) {
  const { id, db, principal, treeRow, queueAuditLog, makeRpcResponse, toToolResult } = ctx
  const publicIdMap = await encodeNodeIds(db, [principal.root_node_id])
  queueAuditLog({ userId: principal.user_id, action: 'mcp.read.root_node_id', targetType: 'tree', targetId: principal.root_node_id, treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({
    id,
    result: toToolResult({ id: publicIdMap.get(principal.root_node_id) ?? principal.root_node_id }),
  })
}

export async function readNode(ctx: McpToolContext) {
  const { id, args, db, principal, treeRow, accessibleSet, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  const nodeIdRaw = args.node_id
  const includeImages = args.include_images === true
  const contentOffset = args.content_offset === undefined ? undefined : Number(args.content_offset)
  const contentLimit = args.content_limit === undefined ? undefined : Number(args.content_limit)
  if (!isValidPublicNodeId(nodeIdRaw)) {
    return makeRpcResponse({ id, result: toolError('Invalid node_id') })
  }
  const nodeId = await resolvePublicNodeId(db, treeRow.tree_id, String(nodeIdRaw))
  if (!nodeId) {
    return makeRpcResponse({ id, result: toolError('Node not found') })
  }
  if (!accessibleSet.has(nodeId)) {
    return makeRpcResponse({ id, result: toolError('Access denied to node') })
  }
  if (contentOffset !== undefined && (!Number.isInteger(contentOffset) || contentOffset < 0)) {
    return makeRpcResponse({ id, result: toolError('content_offset must be a non-negative integer') })
  }
  if (contentLimit !== undefined && (!Number.isInteger(contentLimit) || contentLimit < 1)) {
    return makeRpcResponse({ id, result: toolError('content_limit must be a positive integer') })
  }

  const node = await db.prepare(
    `SELECT n.id, n.title, n.content, u_author.display_name AS author,
            n.created_at, n.updated_at, n.version, n.child_sort_mode, n.child_sort_direction
     FROM nodes n
     LEFT JOIN users u_author ON u_author.id = n.author_user_id
     WHERE n.id = ? AND n.tree_id = ?`
  ).bind(nodeId, treeRow.tree_id).first<McpNodeRow>()
  if (!node) {
    return makeRpcResponse({ id, result: toolError('Node not found') })
  }

  const childRows = await db.prepare(
    `SELECT n.id, n.title, n.content, u_author.display_name AS author,
            n.created_at, n.updated_at, n.version, n.child_sort_mode, n.child_sort_direction,
            COALESCE(rt.name, 'STRUCTURAL') AS relation_type_name
     FROM node_relations nr
     JOIN nodes n ON n.id = nr.child_node_id
     LEFT JOIN relation_types rt ON rt.id = nr.relation_type_id
     LEFT JOIN users u_author ON u_author.id = n.author_user_id
     WHERE nr.parent_node_id = ? AND n.tree_id = ?
     ORDER BY nr.position, n.created_at`
  ).bind(nodeId, treeRow.tree_id).all<McpNodeRow & { relation_type_name: string }>()

  const parentRows = await db.prepare(
    `SELECT n.id, n.title, n.content, u_author.display_name AS author,
            n.created_at, n.updated_at, n.version, n.child_sort_mode, n.child_sort_direction,
            COALESCE(rt.name, 'STRUCTURAL') AS relation_type_name
     FROM node_relations nr
     JOIN nodes n ON n.id = nr.parent_node_id
     LEFT JOIN relation_types rt ON rt.id = nr.relation_type_id
     LEFT JOIN users u_author ON u_author.id = n.author_user_id
     WHERE nr.child_node_id = ? AND n.tree_id = ?
     ORDER BY n.created_at`
  ).bind(nodeId, treeRow.tree_id).all<McpNodeRow & { relation_type_name: string }>()

  const relatedInternalIds = [
    nodeId,
    ...(childRows.results || []).map((r) => r.id),
    ...(parentRows.results || []).map((r) => r.id),
  ]
  const publicIdMap = await encodeNodeIds(db, relatedInternalIds)

  const children = (childRows.results || [])
    .filter((row) => accessibleSet.has(row.id))
    .map((row) => ({
      id: publicIdMap.get(row.id) ?? String(row.id),
      title: row.title,
      relation_type_name: row.relation_type_name || 'STRUCTURAL',
    }))
  const parents = (parentRows.results || [])
    .filter((row) => accessibleSet.has(row.id))
    .map((row) => ({
      id: publicIdMap.get(row.id) ?? String(row.id),
      title: row.title,
      relation_type_name: row.relation_type_name || 'STRUCTURAL',
    }))
  const pathMaps = await buildAncestorPathMaps(db, principal.root_node_id, [node.id])
  const pathInfo = resolveNodePathInfo(node.id, node.title, pathMaps, publicIdMap.get(nodeId))
  const contentLines = node.content == null || node.content === '' ? [] : node.content.split('\n')
  const contentTotalLines = contentLines.length
  const contentIsSliced = contentOffset !== undefined || contentLimit !== undefined
  const contentForResponse = contentIsSliced
    ? contentLines.slice(contentOffset ?? 0, (contentOffset ?? 0) + (contentLimit ?? contentLines.length)).join('\n')
    : node.content || ''
  const imagesByNodeId = includeImages
    ? await listMcpNodeImageMetadata(db, treeRow.tree_id, [nodeId])
    : new Map<number, McpNodeImageMeta[]>()
  queueAuditLog({ userId: principal.user_id, action: 'mcp.read.node', targetType: 'node', targetId: nodeId, treeId: treeRow.tree_id, source: 'mcp' })

  return makeRpcResponse({
    id,
    result: toToolResult({
      ...toMcpNode(node),
      content: contentForResponse,
      content_total_lines: contentTotalLines,
      ...(contentIsSliced ? { content_offset: contentOffset ?? 0, ...(contentLimit !== undefined ? { content_limit: contentLimit } : {}) } : {}),
      id: publicIdMap.get(nodeId) ?? String(nodeId),
      children,
      parents,
      path: pathInfo.path,
      path_relation_mode: pathInfo.path_relation_mode,
      ...(includeImages ? { images: imagesByNodeId.get(nodeId) || [] } : {}),
    }),
  })
}

export async function findInNode(ctx: McpToolContext) {
  const { id, args, db, principal, treeRow, accessibleSet, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  const nodeIdRaw = args.node_id
  const keyword = args.keyword === undefined ? '' : String(args.keyword)
  const limit = args.limit === undefined ? 20 : Number(args.limit)
  if (!isValidPublicNodeId(nodeIdRaw)) return makeRpcResponse({ id, result: toolError('Invalid node_id') })
  if (keyword.length === 0) return makeRpcResponse({ id, result: toolError('keyword is required') })
  if (!Number.isInteger(limit) || limit < 1) return makeRpcResponse({ id, result: toolError('limit must be a positive integer') })
  const nodeId = await resolvePublicNodeId(db, treeRow.tree_id, String(nodeIdRaw))
  if (!nodeId || !accessibleSet.has(nodeId)) return makeRpcResponse({ id, result: toolError('Node not found') })
  const node = await db.prepare('SELECT content FROM nodes WHERE id = ? AND tree_id = ?')
    .bind(nodeId, treeRow.tree_id).first<{ content: string | null }>()
  if (!node) return makeRpcResponse({ id, result: toolError('Node not found') })
  const lines = node.content == null || node.content === '' ? [] : node.content.split('\n')
  const matches = lines.flatMap((line, index) => line.includes(keyword) ? [{ line: index + 1, text: line }] : [])
  const items = matches.slice(0, Math.min(limit, 100))
  queueAuditLog({ userId: principal.user_id, action: 'mcp.read.find_in_node', targetType: 'node', targetId: nodeId, treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({ id, result: toToolResult({ node_id: String(nodeIdRaw), keyword, total: matches.length, limit, returned: items.length, items }) })
}

export async function getChildren(ctx: McpToolContext) {
  const { id, args, db, principal, treeRow, accessibleSet, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  const nodeIdRaw = args.node_id
  const includeImages = args.include_images === true
  if (!isValidPublicNodeId(nodeIdRaw)) {
    return makeRpcResponse({ id, result: toolError('Invalid node_id') })
  }
  const nodeId = await resolvePublicNodeId(db, treeRow.tree_id, String(nodeIdRaw))
  if (!nodeId) {
    return makeRpcResponse({ id, result: toolError('Node not found') })
  }
  if (!accessibleSet.has(nodeId)) {
    return makeRpcResponse({ id, result: toolError('Access denied to node') })
  }

  const limitRaw = args.limit === undefined ? 20 : parseInt(String(args.limit), 10)
  const offsetRaw = args.offset === undefined ? 0 : parseInt(String(args.offset), 10)
  if (!Number.isFinite(limitRaw) || limitRaw <= 0) {
    return makeRpcResponse({ id, result: toolError('Invalid limit') })
  }
  if (!Number.isFinite(offsetRaw) || offsetRaw < 0) {
    return makeRpcResponse({ id, result: toolError('Invalid offset') })
  }
  const limit = Math.min(limitRaw, 100)
  const offset = offsetRaw

  const { results: childRows } = await db.prepare(
    `WITH RECURSIVE accessible(id) AS (
       SELECT ?
       UNION
       SELECT nr.child_node_id
       FROM node_relations nr
       JOIN accessible a ON nr.parent_node_id = a.id
     ),
     paged_children AS (
       SELECT n.id, n.title, n.content, u_author.display_name AS author,
              n.created_at, n.updated_at, n.version, n.child_sort_mode, n.child_sort_direction,
              COALESCE(rt.name, 'STRUCTURAL') AS relation_type_name,
              nr.position
       FROM node_relations nr
       JOIN nodes n ON n.id = nr.child_node_id
       JOIN accessible a ON a.id = n.id
       LEFT JOIN relation_types rt ON rt.id = nr.relation_type_id
       LEFT JOIN users u_author ON u_author.id = n.author_user_id
       WHERE nr.parent_node_id = ? AND n.tree_id = ?
       ORDER BY nr.position, n.created_at
       LIMIT ? OFFSET ?
     )
     SELECT id, title, content, author, created_at, updated_at, version, child_sort_mode, child_sort_direction, relation_type_name
     FROM paged_children`
  ).bind(principal.root_node_id, nodeId, treeRow.tree_id, limit + 1, offset).all<McpNodeRow & { relation_type_name: string }>()

  const hasMore = (childRows || []).length > limit
  const visibleRows = hasMore ? (childRows || []).slice(0, limit) : (childRows || [])
  const pathMaps = await buildAncestorPathMaps(db, principal.root_node_id, visibleRows.map((r) => r.id))
  const publicIdMap = await encodeNodeIds(db, visibleRows.map((r) => r.id))
  const imagesByNodeId = includeImages
    ? await listMcpNodeImageMetadata(db, treeRow.tree_id, visibleRows.map((r) => r.id))
    : new Map<number, McpNodeImageMeta[]>()
  queueAuditLog({ userId: principal.user_id, action: 'mcp.read.children', targetType: 'node', targetId: nodeId, treeId: treeRow.tree_id, source: 'mcp' })

  return makeRpcResponse({
    id,
    result: toToolResult({
      items: visibleRows.map((row) => {
        const pathInfo = resolveNodePathInfo(row.id, row.title, pathMaps, publicIdMap.get(row.id))
        return {
          ...toMcpNode(row),
          id: publicIdMap.get(row.id) ?? String(row.id),
          relation_type_name: row.relation_type_name || 'STRUCTURAL',
          path: pathInfo.path,
          path_relation_mode: pathInfo.path_relation_mode,
          ...(includeImages ? { images: imagesByNodeId.get(row.id) || [] } : {}),
        }
      }),
      limit,
      offset,
      returned: visibleRows.length,
      has_more: hasMore,
      ...(hasMore ? { next_offset: offset + visibleRows.length } : {}),
    }),
  })
}

export async function getParents(ctx: McpToolContext) {
  const { id, args, db, principal, treeRow, accessibleSet, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  const nodeIdRaw = args.node_id
  if (!isValidPublicNodeId(nodeIdRaw)) {
    return makeRpcResponse({ id, result: toolError('Invalid node_id') })
  }
  const nodeId = await resolvePublicNodeId(db, treeRow.tree_id, String(nodeIdRaw))
  if (!nodeId) {
    return makeRpcResponse({ id, result: toolError('Node not found') })
  }
  if (!accessibleSet.has(nodeId)) {
    return makeRpcResponse({ id, result: toolError('Access denied to node') })
  }

  const limitRaw = args.limit === undefined ? 20 : parseInt(String(args.limit), 10)
  const offsetRaw = args.offset === undefined ? 0 : parseInt(String(args.offset), 10)
  if (!Number.isFinite(limitRaw) || limitRaw <= 0) {
    return makeRpcResponse({ id, result: toolError('Invalid limit') })
  }
  if (!Number.isFinite(offsetRaw) || offsetRaw < 0) {
    return makeRpcResponse({ id, result: toolError('Invalid offset') })
  }
  const limit = Math.min(limitRaw, 100)
  const offset = offsetRaw

  const { results: parentRows } = await db.prepare(
    `WITH RECURSIVE accessible(id) AS (
       SELECT ?
       UNION
       SELECT nr.child_node_id
       FROM node_relations nr
       JOIN accessible a ON nr.parent_node_id = a.id
     ),
     paged_parents AS (
       SELECT n.id, n.title, n.content, u_author.display_name AS author,
              n.created_at, n.updated_at, n.version, n.child_sort_mode, n.child_sort_direction,
              COALESCE(rt.name, 'STRUCTURAL') AS relation_type_name
       FROM node_relations nr
       JOIN nodes n ON n.id = nr.parent_node_id
       JOIN accessible a ON a.id = n.id
       LEFT JOIN relation_types rt ON rt.id = nr.relation_type_id
       LEFT JOIN users u_author ON u_author.id = n.author_user_id
       WHERE nr.child_node_id = ? AND n.tree_id = ?
       ORDER BY n.created_at
       LIMIT ? OFFSET ?
     )
     SELECT id, title, content, author, created_at, updated_at, version, child_sort_mode, child_sort_direction, relation_type_name
     FROM paged_parents`
  ).bind(principal.root_node_id, nodeId, treeRow.tree_id, limit + 1, offset).all<McpNodeRow & { relation_type_name: string }>()

  const hasMore = (parentRows || []).length > limit
  const visibleRows = hasMore ? (parentRows || []).slice(0, limit) : (parentRows || [])
  const pathMaps = await buildAncestorPathMaps(db, principal.root_node_id, visibleRows.map((r) => r.id))
  const publicIdMap = await encodeNodeIds(db, visibleRows.map((r) => r.id))
  queueAuditLog({ userId: principal.user_id, action: 'mcp.read.parents', targetType: 'node', targetId: nodeId, treeId: treeRow.tree_id, source: 'mcp' })

  return makeRpcResponse({
    id,
    result: toToolResult({
      items: visibleRows.map((row) => {
        const pathInfo = resolveNodePathInfo(row.id, row.title, pathMaps, publicIdMap.get(row.id))
        return {
          ...toMcpNode(row),
          id: publicIdMap.get(row.id) ?? String(row.id),
          relation_type_name: row.relation_type_name || 'STRUCTURAL',
          path: pathInfo.path,
          path_relation_mode: pathInfo.path_relation_mode,
        }
      }),
      limit,
      offset,
      returned: visibleRows.length,
      has_more: hasMore,
      ...(hasMore ? { next_offset: offset + visibleRows.length } : {}),
    }),
  })
}

export async function createNode(ctx: McpToolContext) {
  const { id, args, db, env, principal, treeRow, accessibleSet, executionCtx, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  const title = String(args.title || '').trim()
  const content = args.content === undefined ? '' : String(args.content)
  const createdAt = args.created_at === undefined ? undefined : String(args.created_at)
  const updatedAt = args.updated_at === undefined ? undefined : String(args.updated_at)
  const childSortMode = args.child_sort_mode === undefined ? undefined : String(args.child_sort_mode)
  const childSortDirection = args.child_sort_direction === undefined ? undefined : String(args.child_sort_direction)
  const parentIdsRaw = Array.isArray(args.parent_ids) ? args.parent_ids : []
  const invalidParentIds = parentIdsRaw.filter((idVal) => !isValidPublicNodeId(idVal))
  if (invalidParentIds.length > 0) {
    return makeRpcResponse({ id, result: toolError('parent_ids contains invalid public node ID') })
  }
  const parentPublicIds = parentIdsRaw.map((idVal) => String(idVal))
  const parentIdMap = await resolvePublicNodeIds(db, treeRow.tree_id, parentPublicIds)
  const missingParentIds = parentPublicIds.filter((pid) => !parentIdMap.has(pid))
  if (missingParentIds.length > 0) {
    return makeRpcResponse({ id, result: toolError(`parent_ids not found: ${missingParentIds.join(', ')}`) })
  }
  const parentIds = parentPublicIds.map((pid) => parentIdMap.get(pid)!)
  const relationTypeId = resolveRelationTypeId(args.relation_type, args.relation_type_id)

  if (!title) {
    return makeRpcResponse({ id, result: toolError('title is required') })
  }
  const validTitle = validateTextLimit(title, 'title', NODE_TITLE_MAX_LENGTH, { required: true })
  if (!validTitle.ok) return makeRpcResponse({ id, result: toolError(validTitle.error) })
  const validContent = validateTextLimit(content, 'content', NODE_CONTENT_MAX_LENGTH)
  if (!validContent.ok) return makeRpcResponse({ id, result: toolError(validContent.error) })
  if (parentIds.length === 0) {
    return makeRpcResponse({ id, result: toolError('parent_ids is required') })
  }
  if (!relationTypeId) {
    return makeRpcResponse({ id, result: toolError('Invalid relation_type (STRUCTURAL/REFERENCE)') })
  }
  if (childSortMode !== undefined && !NODE_CHILD_SORT_MODES.has(childSortMode)) {
    return makeRpcResponse({ id, result: toolError('Invalid child_sort_mode') })
  }
  if (childSortDirection !== undefined && !NODE_CHILD_SORT_DIRECTIONS.has(childSortDirection)) {
    return makeRpcResponse({ id, result: toolError('Invalid child_sort_direction') })
  }
  if (parentIds.some((pid) => !accessibleSet.has(pid))) {
    return makeRpcResponse({ id, result: toolError('parent_ids contains inaccessible node') })
  }

  try {
    await assertNodeQuota(db, treeRow.tree_id, 1)
  } catch (error) {
    return makeRpcResponse({ id, result: toolError(error instanceof Error ? error.message : 'Node quota exceeded') })
  }

  const insertColumns = ['tree_id', 'title', 'content', 'author_user_id', 'created_by_user_id', 'updated_by_user_id', 'updated_by_client_id', 'version']
  const insertValues: unknown[] = [treeRow.tree_id, validTitle.value, validContent.value, principal.user_id, principal.user_id, principal.user_id, principal.client_id, 1]
  if (createdAt !== undefined) {
    insertColumns.push('created_at')
    insertValues.push(createdAt)
  }
  if (updatedAt !== undefined) {
    insertColumns.push('updated_at')
    insertValues.push(updatedAt)
  }
  if (childSortMode !== undefined) {
    insertColumns.push('child_sort_mode')
    insertValues.push(childSortMode)
  }
  if (childSortDirection !== undefined) {
    insertColumns.push('child_sort_direction')
    insertValues.push(childSortDirection)
  }
  insertColumns.push('public_id')

  const createdNode = await withPublicIdRetry(async (publicId) => {
    const batch = await db.batch([
      db.prepare(
      `INSERT INTO nodes (${insertColumns.join(', ')})
       VALUES (${insertColumns.map(() => '?').join(', ')})
       RETURNING id, public_id`
      ).bind(...insertValues, publicId),
      db.prepare('UPDATE trees SET node_count = node_count + 1 WHERE id = ?').bind(treeRow.tree_id),
    ])
    return batch[0].results[0] as { id: number; public_id: string } | undefined
  })

  if (!createdNode) {
    return makeRpcResponse({ id, result: toolError('Failed to create node') })
  }

  for (const parentId of parentIds) {
    const maxPos = await db.prepare(
      'SELECT COALESCE(MAX(position), -1) AS max_pos FROM node_relations WHERE parent_node_id = ?'
    ).bind(parentId).first<{ max_pos: number }>()
    const newPos = (maxPos?.max_pos ?? -1) + 1
    await db.prepare(
      `INSERT INTO node_relations (parent_node_id, child_node_id, position, relation_type_id)
       VALUES (?, ?, ?, ?)`
    ).bind(parentId, createdNode.id, newPos, relationTypeId).run()
  }

  const createdNodeFull = await db.prepare(
    `SELECT n.id, n.title, n.content, u_author.display_name AS author,
            n.created_at, n.updated_at, n.version, n.child_sort_mode, n.child_sort_direction
     FROM nodes n
     LEFT JOIN users u_author ON u_author.id = n.author_user_id
     WHERE n.id = ?`
  ).bind(createdNode.id).first<McpNodeRow>()

  if (!createdNodeFull) {
    return makeRpcResponse({ id, result: toolError('Failed to load created node') })
  }
  const pathMaps = await buildAncestorPathMaps(db, principal.root_node_id, [createdNodeFull.id])
  const pathInfo = resolveNodePathInfo(createdNodeFull.id, createdNodeFull.title, pathMaps, createdNode.public_id)

  if (executionCtx?.waitUntil) {
    executionCtx.waitUntil(upsertNodeVector(env?.AI, env?.VECTORIZE, db, createdNodeFull.id))
  }
  queueAuditLog({ userId: principal.user_id, action: 'mcp.node.create', targetType: 'node', targetId: createdNodeFull.id, treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({
    id,
    result: toToolResult({
      id: createdNode.public_id,
      author: createdNodeFull.author || null,
      created_at: createdNodeFull.created_at,
      updated_at: createdNodeFull.updated_at,
      child_sort_mode: createdNodeFull.child_sort_mode,
      child_sort_direction: createdNodeFull.child_sort_direction,
      version: createdNodeFull.version,
      relation_type_name: relationTypeNameFromId(relationTypeId),
      path: pathInfo.path,
      path_relation_mode: pathInfo.path_relation_mode,
    }),
  })
}

export async function createNodeTree(ctx: McpToolContext) {
  const { id, args, db, env, principal, treeRow, accessibleSet, executionCtx, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  const parentNodeIdRaw = args.parent_node_id
  const inputNodes = Array.isArray(args.nodes) ? args.nodes : null

  if (!isValidPublicNodeId(parentNodeIdRaw)) {
    return makeRpcResponse({ id, result: toolError('Invalid parent_node_id') })
  }
  const parentNodeId = await resolvePublicNodeId(db, treeRow.tree_id, String(parentNodeIdRaw))
  if (!parentNodeId) {
    return makeRpcResponse({ id, result: toolError('parent_node_id not found') })
  }
  if (!accessibleSet.has(parentNodeId)) {
    return makeRpcResponse({ id, result: toolError('parent_node_id is outside scope') })
  }
  if (!inputNodes || inputNodes.length === 0) {
    return makeRpcResponse({ id, result: toolError('nodes is required and must be non-empty array') })
  }

  const countInputNodes = (nodes: NodeInput[]): number => nodes.reduce((sum, node) => sum + 1 + (Array.isArray(node.children) ? countInputNodes(node.children) : 0), 0)

  type NodeInput = {
    title: string
    content?: string
    child_sort_mode?: string
    child_sort_direction?: string
    relation_type?: RelationTypeName | null
    relation_type_id?: number
    children?: NodeInput[]
  }

  const requestedCount = countInputNodes(inputNodes as NodeInput[])
  try {
    await assertNodeQuota(db, treeRow.tree_id, requestedCount)
  } catch (error) {
    return makeRpcResponse({ id, result: toolError(error instanceof Error ? error.message : 'Node quota exceeded') })
  }

  type CreatedNodeEntry = McpNodeRow & { internal_id: number; parent_id: number; relation_type_name: string; public_id: string }
  const createdNodes: CreatedNodeEntry[] = []

  const createRecursively = async (currentParentId: number, nodes: NodeInput[]) => {
    for (const rawNode of nodes) {
      const title = String(rawNode?.title || '').trim()
      const content = rawNode?.content === undefined ? '' : String(rawNode.content)
      const childSortMode = rawNode?.child_sort_mode === undefined ? undefined : String(rawNode.child_sort_mode)
      const childSortDirection = rawNode?.child_sort_direction === undefined ? undefined : String(rawNode.child_sort_direction)
      const relationTypeId = resolveRelationTypeId(rawNode?.relation_type, rawNode?.relation_type_id)

      if (!title) {
        throw new Error('Each node.title is required')
      }
      if (!relationTypeId) {
        throw new Error('Invalid relation_type in node tree')
      }
      if (childSortMode !== undefined && !NODE_CHILD_SORT_MODES.has(childSortMode)) {
        throw new Error('Invalid child_sort_mode in node tree')
      }
      if (childSortDirection !== undefined && !NODE_CHILD_SORT_DIRECTIONS.has(childSortDirection)) {
        throw new Error('Invalid child_sort_direction in node tree')
      }

      const insertedNode = await withPublicIdRetry(async (publicId) => {
        const batch = await db.batch([
          db.prepare(
          `INSERT INTO nodes (
             tree_id, title, content, author_user_id, created_by_user_id, updated_by_user_id, updated_by_client_id,
             version, child_sort_mode, child_sort_direction, public_id
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
           RETURNING id, public_id`
          ).bind(
          treeRow.tree_id,
          title,
          content,
          principal.user_id,
          principal.user_id,
          principal.user_id,
          principal.client_id,
          childSortMode || 'manual',
          childSortDirection || 'asc',
          publicId,
          ),
          db.prepare('UPDATE trees SET node_count = node_count + 1 WHERE id = ?').bind(treeRow.tree_id),
        ])
        return batch[0].results[0] as { id: number; public_id: string } | undefined
      })

      if (!insertedNode) {
        throw new Error('Failed to create node in create_node_tree')
      }

      const maxPos = await db.prepare(
        'SELECT COALESCE(MAX(position), -1) AS max_pos FROM node_relations WHERE parent_node_id = ?'
      ).bind(currentParentId).first<{ max_pos: number }>()
      const newPos = (maxPos?.max_pos ?? -1) + 1

      await db.prepare(
        `INSERT INTO node_relations (parent_node_id, child_node_id, position, relation_type_id)
         VALUES (?, ?, ?, ?)`
      ).bind(currentParentId, insertedNode.id, newPos, relationTypeId).run()

      const insertedNodeFull = await db.prepare(
        `SELECT n.id, n.title, n.content, u_author.display_name AS author,
                n.created_at, n.updated_at, n.child_sort_mode, n.child_sort_direction
         FROM nodes n
         LEFT JOIN users u_author ON u_author.id = n.author_user_id
         WHERE n.id = ?`
      ).bind(insertedNode.id).first<McpNodeRow>()

      if (!insertedNodeFull) {
        throw new Error('Failed to load created node in create_node_tree')
      }

      if (executionCtx?.waitUntil) {
        executionCtx.waitUntil(upsertNodeVector(env?.AI, env?.VECTORIZE, db, insertedNode.id))
      }

      createdNodes.push({
        ...toMcpNode(insertedNodeFull),
        internal_id: insertedNode.id,
        public_id: insertedNode.public_id,
        parent_id: currentParentId,
        relation_type_name: relationTypeNameFromId(relationTypeId),
      })

      const children = Array.isArray(rawNode.children) ? rawNode.children : []
      if (children.length > 0) {
        await createRecursively(insertedNode.id, children)
      }
    }
  }

  await createRecursively(parentNodeId, inputNodes as NodeInput[])

  const publicIdMap = await encodeNodeIds(db, [parentNodeId, ...createdNodes.map((n) => n.internal_id)])
  queueAuditLog({ userId: principal.user_id, action: 'mcp.create_node_tree', targetType: 'node', targetId: createdNodes[0].internal_id, treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({
    id,
    result: toToolResult({
      created_count: createdNodes.length,
      created_nodes: createdNodes.map((n) => ({
        id: n.public_id,
        title: n.title,
        content: n.content,
        author: n.author,
        created_at: n.created_at,
        updated_at: n.updated_at,
        child_sort_mode: n.child_sort_mode,
        child_sort_direction: n.child_sort_direction,
        parent_id: publicIdMap.get(n.parent_id) ?? String(n.parent_id),
        relation_type_name: n.relation_type_name,
      })),
    }),
  })
}

export async function updateNode(ctx: McpToolContext) {
  const { id, args, db, env, principal, treeRow, accessibleSet, executionCtx, queueAuditLog, makeRpcResponse, toToolResult, toolError, toolErrorWithData } = ctx
  const nodeIdRaw = args.node_id
  const title = args.title === undefined ? undefined : String(args.title)
  const content = args.content === undefined ? undefined : String(args.content)
  const ifVersion = args.if_version === undefined ? undefined : Number(args.if_version)
  const createdAt = args.created_at === undefined ? undefined : String(args.created_at)
  const updatedAt = args.updated_at === undefined ? undefined : String(args.updated_at)
  const childSortMode = args.child_sort_mode === undefined ? undefined : String(args.child_sort_mode)
  const childSortDirection = args.child_sort_direction === undefined ? undefined : String(args.child_sort_direction)
  if (!isValidPublicNodeId(nodeIdRaw)) {
    return makeRpcResponse({ id, result: toolError('node_id is required') })
  }
  // content の全文置換だけが上書き事故を起こすため、そこだけ必須にする。
  // 「未指定」と「不正な値」は別のエラーとして返す（競合と混同させない）。
  if (content !== undefined && ifVersion === undefined) {
    return makeRpcResponse({ id, result: toolError('if_version is required when content is provided') })
  }
  if (ifVersion !== undefined && (!Number.isInteger(ifVersion) || ifVersion < 1)) {
    return makeRpcResponse({ id, result: toolError('if_version must be a positive integer') })
  }
  if (title !== undefined) {
    const validTitle = validateTextLimit(title, 'title', NODE_TITLE_MAX_LENGTH, { required: true, trim: true })
    if (!validTitle.ok) return makeRpcResponse({ id, result: toolError(validTitle.error) })
  }
  if (content !== undefined) {
    const validContent = validateTextLimit(content, 'content', NODE_CONTENT_MAX_LENGTH)
    if (!validContent.ok) return makeRpcResponse({ id, result: toolError(validContent.error) })
  }
  const nodeId = await resolvePublicNodeId(db, treeRow.tree_id, String(nodeIdRaw))
  if (!nodeId) {
    return makeRpcResponse({ id, result: toolError('Node not found') })
  }
  if (
    title === undefined &&
    content === undefined &&
    createdAt === undefined &&
    updatedAt === undefined &&
    childSortMode === undefined &&
    childSortDirection === undefined
  ) {
    return makeRpcResponse({ id, result: toolError('title, content, created_at, updated_at, child_sort_mode or child_sort_direction is required') })
  }
  if (childSortMode !== undefined && !NODE_CHILD_SORT_MODES.has(childSortMode)) {
    return makeRpcResponse({ id, result: toolError('Invalid child_sort_mode') })
  }
  if (childSortDirection !== undefined && !NODE_CHILD_SORT_DIRECTIONS.has(childSortDirection)) {
    return makeRpcResponse({ id, result: toolError('Invalid child_sort_direction') })
  }
  if (!accessibleSet.has(nodeId)) {
    return makeRpcResponse({ id, result: toolError('Access denied to node') })
  }

  const existingNode = await db.prepare(
    'SELECT id, tree_id, title, content, version FROM nodes WHERE id = ?'
  ).bind(nodeId).first<{ id: number; tree_id: number; title: string; content: string; version: number }>()
  if (!existingNode || existingNode.tree_id !== treeRow.tree_id) {
    return makeRpcResponse({ id, result: toolError('Node not found') })
  }
  if (ifVersion !== undefined && existingNode.version !== ifVersion) {
    const current = await db.prepare(
      `SELECT n.id, n.title, n.content, u_author.display_name AS author,
              n.created_at, n.updated_at, n.version, n.child_sort_mode, n.child_sort_direction
       FROM nodes n LEFT JOIN users u_author ON u_author.id = n.author_user_id WHERE n.id = ?`
    ).bind(nodeId).first<McpNodeRow>()
    const currentData = current ? { ...toMcpNode(current), id: String(args.node_id) } : null
    return makeRpcResponse({
      id,
      result: toolErrorWithData({
        error: 'Version conflict',
        current_version: current?.version ?? null,
        server_data: currentData,
      }),
    })
  }

  // content が実際に変わるときだけ積む（同一内容の書き戻しは undo 対象にならない）。
  //
  // クライアント種別による除外はしない。当初 copy_tree（生成直後のID張り替え）を
  // スキップする案があったが、判定に使える値が DCR でクライアントが自己申告する
  // client_name しかなく、**誰でも copy_tree を名乗って undo 保護を無効化できた**。
  // 設計上 skip_snapshot パラメータを却下した理由（クライアント申告に安全性を
  // 委ねない）と同じ穴なので、除外そのものを廃止した（2026-09-05 承認）。
  // copy_tree が積む無駄は purge（1ノード100件）で有界。
  const takesSnapshot = content !== undefined && content !== existingNode.content

  const setClauses = ['title = ?', 'content = ?', 'updated_by_user_id = ?', 'updated_by_client_id = ?', 'version = version + 1']
  const setValues: unknown[] = [
    title === undefined ? existingNode.title : title,
    content === undefined ? existingNode.content : content,
    principal.user_id,
    principal.client_id,
  ]
  if (updatedAt !== undefined) {
    setClauses.push('updated_at = ?')
    setValues.push(updatedAt)
  } else {
    setClauses.push('updated_at = CURRENT_TIMESTAMP')
  }
  if (createdAt !== undefined) {
    setClauses.push('created_at = ?')
    setValues.push(createdAt)
  }
  if (childSortMode !== undefined) {
    setClauses.push('child_sort_mode = ?')
    setValues.push(childSortMode)
  }
  if (childSortDirection !== undefined) {
    setClauses.push('child_sort_direction = ?')
    setValues.push(childSortDirection)
  }

  // スナップショットと UPDATE は同一 batch。別々に await すると、version ガードで
  // UPDATE が0行になったとき（競合に負けたとき）スナップショットだけが残る
  const updateWrites = await db.batch([
    ...(takesSnapshot ? [nodeSnapshotInsertStatement(db, {
      nodeId,
      content: existingNode.content,
      nodeVersion: existingNode.version,
      userId: principal.user_id,
      source: 'mcp',
      clientId: principal.client_id,
    })] : []),
    db.prepare(
      `UPDATE nodes
       SET ${setClauses.join(', ')}
       WHERE id = ? AND (? IS NULL OR version = ?)
       RETURNING updated_at, version`
    ).bind(...setValues, nodeId, ifVersion ?? null, ifVersion ?? null),
  ])
  const updateResult = updateWrites[takesSnapshot ? 1 : 0].results?.[0] as { updated_at: string; version: number } | undefined

  if (!updateResult) {
    return makeRpcResponse({ id, result: toolError('Failed to update node') })
  }

  if (takesSnapshot) {
    await schedulePurgeNodeSnapshots(db, nodeId, executionCtx?.waitUntil?.bind(executionCtx))
  }

  if (executionCtx?.waitUntil) {
    executionCtx.waitUntil(upsertNodeVector(env?.AI, env?.VECTORIZE, db, nodeId))
  }
  queueAuditLog({ userId: principal.user_id, action: 'mcp.node.update', targetType: 'node', targetId: nodeId, treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({
    id,
    result: toToolResult({
      success: true,
      updated_at: updateResult.updated_at,
      version: updateResult.version,
    }),
  })
}

export async function updateNodeTitle(ctx: McpToolContext) {
  const { id, args, db, env, principal, treeRow, accessibleSet, executionCtx, queueAuditLog, makeRpcResponse, toToolResult, toolError, toolErrorWithData } = ctx
  const nodeIdRaw = args.node_id
  const title = args.title === undefined ? undefined : String(args.title)
  const ifVersion = args.if_version === undefined ? undefined : Number(args.if_version)
  if (!isValidPublicNodeId(nodeIdRaw)) {
    return makeRpcResponse({ id, result: toolError('node_id is required') })
  }
  if (title === undefined) {
    return makeRpcResponse({ id, result: toolError('title is required') })
  }
  // 不正な if_version を「競合」として返さない（引数エラーと競合は別物）
  if (ifVersion !== undefined && (!Number.isInteger(ifVersion) || ifVersion < 1)) {
    return makeRpcResponse({ id, result: toolError('if_version must be a positive integer') })
  }
  const nodeId = await resolvePublicNodeId(db, treeRow.tree_id, String(nodeIdRaw))
  if (!nodeId) {
    return makeRpcResponse({ id, result: toolError('Node not found') })
  }
  if (!accessibleSet.has(nodeId)) {
    return makeRpcResponse({ id, result: toolError('Access denied to node') })
  }

  const existingNode = await db.prepare(
    'SELECT id, tree_id, version FROM nodes WHERE id = ?'
  ).bind(nodeId).first<{ id: number; tree_id: number; version: number }>()
  if (!existingNode || existingNode.tree_id !== treeRow.tree_id) {
    return makeRpcResponse({ id, result: toolError('Node not found') })
  }
  if (ifVersion !== undefined && existingNode.version !== ifVersion) {
    const current = await db.prepare(
      `SELECT n.id, n.title, n.content, u_author.display_name AS author,
              n.created_at, n.updated_at, n.version, n.child_sort_mode, n.child_sort_direction
       FROM nodes n LEFT JOIN users u_author ON u_author.id = n.author_user_id WHERE n.id = ?`
    ).bind(nodeId).first<McpNodeRow>()
    const currentData = current ? { ...toMcpNode(current), id: String(args.node_id) } : null
    return makeRpcResponse({
      id,
      result: toolErrorWithData({
        error: 'Version conflict',
        current_version: current?.version ?? null,
        server_data: currentData,
      }),
    })
  }

  const updateResult = await db.prepare(
    `UPDATE nodes
     SET title = ?, updated_by_user_id = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND (? IS NULL OR version = ?)
     RETURNING updated_at, version`
  ).bind(title, principal.user_id, nodeId, ifVersion ?? null, ifVersion ?? null).first<{ updated_at: string; version: number }>()

  if (!updateResult) {
    return makeRpcResponse({ id, result: toolError('Failed to update node title') })
  }

  if (executionCtx?.waitUntil) {
    executionCtx.waitUntil(upsertNodeVector(env?.AI, env?.VECTORIZE, db, nodeId))
  }
  queueAuditLog({ userId: principal.user_id, action: 'mcp.node.update_title', targetType: 'node', targetId: nodeId, treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({
    id,
    result: toToolResult({
      success: true,
      updated_at: updateResult.updated_at,
      version: updateResult.version,
    }),
  })
}

export async function appendNodeContent(ctx: McpToolContext) {
  const { id, args, db, env, principal, treeRow, accessibleSet, executionCtx, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  const nodeIdRaw = args.node_id
  const appendContent = args.content === undefined ? '' : String(args.content)
  if (!isValidPublicNodeId(nodeIdRaw)) {
    return makeRpcResponse({ id, result: toolError('node_id is required') })
  }
  const nodeId = await resolvePublicNodeId(db, treeRow.tree_id, String(nodeIdRaw))
  if (!nodeId) {
    return makeRpcResponse({ id, result: toolError('Node not found') })
  }
  if (appendContent.length === 0) {
    return makeRpcResponse({ id, result: toolError('content is required') })
  }
  if (!accessibleSet.has(nodeId)) {
    return makeRpcResponse({ id, result: toolError('Access denied to node') })
  }

  const existingNode = await db.prepare(
    'SELECT id, tree_id, content, version FROM nodes WHERE id = ?'
  ).bind(nodeId).first<{ id: number; tree_id: number; content: string | null; version: number }>()
  if (!existingNode || existingNode.tree_id !== treeRow.tree_id) {
    return makeRpcResponse({ id, result: toolError('Node not found') })
  }

  const separatorLength = existingNode.content ? 1 : 0
  if ((existingNode.content?.length || 0) + separatorLength + appendContent.length > NODE_CONTENT_MAX_LENGTH) {
    return makeRpcResponse({ id, result: toolError(`content must be ${NODE_CONTENT_MAX_LENGTH} characters or fewer`) })
  }

  // スナップショットと UPDATE は同一 batch。UPDATE が失敗したときに
  // スナップショットだけが残ると、現在の内容と同一の undo 候補が積まれる
  await db.batch([
    nodeSnapshotInsertStatement(db, {
      nodeId,
      content: existingNode.content,
      nodeVersion: existingNode.version,
      userId: principal.user_id,
      source: 'mcp',
      clientId: principal.client_id,
    }),
    db.prepare(
      `UPDATE nodes
       SET content = CASE
         WHEN content IS NULL OR content = '' THEN ?
         ELSE content || '\n' || ?
       END,
       updated_by_user_id = ?,
       updated_by_client_id = ?,
       version = version + 1,
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).bind(appendContent, appendContent, principal.user_id, principal.client_id, nodeId),
  ])
  await schedulePurgeNodeSnapshots(db, nodeId, executionCtx?.waitUntil?.bind(executionCtx))

  const updated = await db.prepare(
    `SELECT n.id, n.title, n.content, u_author.display_name AS author,
            n.created_at, n.updated_at, n.version, n.child_sort_mode, n.child_sort_direction
     FROM nodes n
     LEFT JOIN users u_author ON u_author.id = n.author_user_id
     WHERE n.id = ?`
  ).bind(nodeId).first<McpNodeRow>()
  if (!updated) {
    return makeRpcResponse({ id, result: toolError('Failed to load updated node') })
  }
  const pathMaps = await buildAncestorPathMaps(db, principal.root_node_id, [updated.id])
  const publicIdMap = await encodeNodeIds(db, [nodeId])
  const pathInfo = resolveNodePathInfo(updated.id, updated.title, pathMaps, publicIdMap.get(nodeId))

  if (executionCtx?.waitUntil) {
    executionCtx.waitUntil(upsertNodeVector(env?.AI, env?.VECTORIZE, db, nodeId))
  }
  queueAuditLog({ userId: principal.user_id, action: 'mcp.node.append_content', targetType: 'node', targetId: nodeId, treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({
    id,
    result: toToolResult({
      ...toMcpNode(updated),
      id: publicIdMap.get(nodeId) ?? String(nodeId),
      path: pathInfo.path,
      path_relation_mode: pathInfo.path_relation_mode,
    }),
  })
}

export async function editNodeContent(ctx: McpToolContext) {
  const { id, args, db, env, principal, treeRow, accessibleSet, executionCtx, queueAuditLog, makeRpcResponse, toToolResult, toolError, toolErrorWithData } = ctx
  const nodeIdRaw = args.node_id
  const hasEdits = Object.prototype.hasOwnProperty.call(args, 'edits')
  const hasScalar = Object.prototype.hasOwnProperty.call(args, 'old_str') || Object.prototype.hasOwnProperty.call(args, 'new_str') || Object.prototype.hasOwnProperty.call(args, 'replace_all')
  if (hasEdits === hasScalar) return makeRpcResponse({ id, result: toolError('provide either edits[] or scalar old_str/new_str, but not both') })
  let edits: Array<{ oldStr: string; newStr: string; replaceAll: boolean }>
  if (hasEdits) {
    if (!Array.isArray(args.edits) || args.edits.length === 0) return makeRpcResponse({ id, result: toolError('edits must be a non-empty array') })
    edits = args.edits.map((edit: any) => ({ oldStr: edit?.old_str === undefined ? '' : String(edit.old_str), newStr: edit?.new_str === undefined ? '' : String(edit.new_str), replaceAll: edit?.replace_all === true }))
  } else {
    if (!Object.prototype.hasOwnProperty.call(args, 'old_str') || !Object.prototype.hasOwnProperty.call(args, 'new_str')) return makeRpcResponse({ id, result: toolError('old_str and new_str are required') })
    edits = [{ oldStr: args.old_str === undefined ? '' : String(args.old_str), newStr: args.new_str === undefined ? '' : String(args.new_str), replaceAll: args.replace_all === true }]
  }
  const ifVersion = args.if_version === undefined ? undefined : Number(args.if_version)
  if (!isValidPublicNodeId(nodeIdRaw)) return makeRpcResponse({ id, result: toolError('node_id is required') })
  if (ifVersion !== undefined && (!Number.isInteger(ifVersion) || ifVersion < 1)) return makeRpcResponse({ id, result: toolError('if_version must be a positive integer') })
  const nodeId = await resolvePublicNodeId(db, treeRow.tree_id, String(nodeIdRaw))
  if (!nodeId) return makeRpcResponse({ id, result: toolError('Node not found') })
  if (!accessibleSet.has(nodeId)) return makeRpcResponse({ id, result: toolError('Access denied to node') })
  const existingNode = await db.prepare('SELECT id, tree_id, content, version FROM nodes WHERE id = ?')
    .bind(nodeId).first<{ id: number; tree_id: number; content: string | null; version: number }>()
  if (!existingNode || existingNode.tree_id !== treeRow.tree_id) return makeRpcResponse({ id, result: toolError('Node not found') })
  if (ifVersion !== undefined && existingNode.version !== ifVersion) {
    const current = await db.prepare(
      `SELECT n.id, n.title, n.content, u_author.display_name AS author, n.created_at, n.updated_at,
              n.version, n.child_sort_mode, n.child_sort_direction
       FROM nodes n LEFT JOIN users u_author ON u_author.id = n.author_user_id WHERE n.id = ?`
    ).bind(nodeId).first<McpNodeRow>()
    return makeRpcResponse({ id, result: toolErrorWithData({ error: 'Version conflict', current_version: current?.version ?? null, server_data: current ? { ...toMcpNode(current), id: String(nodeIdRaw) } : null }) })
  }
  // 空の old_str は「一致しなかった」ではなく引数エラー。
  // No match として返すと、呼び出し側が「本文を読み直して正しい文字列を探す」
  // という誤った次の行動に誘導される
  const emptyIndex = edits.findIndex((edit) => edit.oldStr.length === 0)
  if (emptyIndex >= 0) {
    return makeRpcResponse({
      id,
      result: toolErrorWithData({
        edit_index: emptyIndex,
        error: 'Invalid argument',
        message: 'old_str is required and must not be empty',
      }),
    })
  }
  const original = existingNode.content || ''
  let workingContent = original
  const matchCounts: number[] = []
  for (let editIndex = 0; editIndex < edits.length; editIndex += 1) {
    const { oldStr, newStr, replaceAll } = edits[editIndex]
    const matchLines: number[] = []
    if (oldStr.length > 0) {
      let cursor = 0
      while (cursor <= workingContent.length - oldStr.length) {
        const found = workingContent.indexOf(oldStr, cursor)
        if (found < 0) break
        matchLines.push(workingContent.slice(0, found).split('\n').length)
        cursor = found + oldStr.length
      }
    }
    const matchCount = matchLines.length
    matchCounts.push(matchCount)
    if (matchCount === 0 || (matchCount > 1 && !replaceAll)) {
      // error は機械可読な固定コードにする（他の tool error と揃える）。
      // 人向けの説明は message へ。複数一致のときは「old_str を広げる」という
      // 次の行動を明示する — それがエージェントに一意化を強制する仕掛けなので
      return makeRpcResponse({
        id,
        result: toolErrorWithData({
          edit_index: editIndex,
          error: matchCount === 0 ? 'No match' : 'Multiple matches',
          message: matchCount === 0
            ? 'old_str did not match any part of the content. Read the node (or use find_in_node) and copy the exact text.'
            : `old_str matched ${matchCount} times (lines ${matchLines.join(', ')}). Widen old_str with surrounding lines until it is unique, or pass replace_all=true.`,
          match_count: matchCount,
          match_lines: matchLines,
        }),
      })
    }
    const firstIndex = workingContent.indexOf(oldStr)
    workingContent = replaceAll
      ? workingContent.split(oldStr).join(newStr)
      : workingContent.slice(0, firstIndex) + newStr + workingContent.slice(firstIndex + oldStr.length)
  }
  if (workingContent.length > NODE_CONTENT_MAX_LENGTH) {
    return makeRpcResponse({ id, result: toolError(`content must be ${NODE_CONTENT_MAX_LENGTH} characters or fewer`) })
  }
  const updated = await db.batch([
    nodeSnapshotInsertStatement(db, { nodeId, content: existingNode.content, nodeVersion: existingNode.version, userId: principal.user_id, source: 'mcp', clientId: principal.client_id }),
    db.prepare(
      `UPDATE nodes SET content = ?, updated_by_user_id = ?, updated_by_client_id = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND (? IS NULL OR version = ?) RETURNING version, updated_at`
    ).bind(workingContent, principal.user_id, principal.client_id, nodeId, ifVersion ?? null, ifVersion ?? null),
  ])
  const updatedRow = updated[1].results?.[0] as { version: number; updated_at: string } | undefined
  if (!updatedRow) return makeRpcResponse({ id, result: toolError('Failed to edit node content') })
  await schedulePurgeNodeSnapshots(db, nodeId, executionCtx?.waitUntil?.bind(executionCtx))
  if (executionCtx?.waitUntil) executionCtx.waitUntil(upsertNodeVector(env?.AI, env?.VECTORIZE, db, nodeId))
  queueAuditLog({ userId: principal.user_id, action: 'mcp.node.edit_content', targetType: 'node', targetId: nodeId, treeId: treeRow.tree_id, source: 'mcp' })
  // match_count はスカラ形（1編集）のときだけ返す。バッチで最後の編集の値だけを
  // 返すと集約として意味を持たないため、編集ごとの配列 match_counts で返す
  return makeRpcResponse({
    id,
    result: toToolResult({
      success: true,
      node_id: String(nodeIdRaw),
      version: updatedRow.version,
      updated_at: updatedRow.updated_at,
      applied: edits.length,
      match_counts: matchCounts,
      ...(hasEdits ? {} : { match_count: matchCounts[0] }),
    }),
  })
}

export async function trashNode(ctx: McpToolContext) {
  const { id, args, db, env, principal, treeRow, accessibleSet, executionCtx, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  const nodeIdRaw = args.node_id
  if (!isValidPublicNodeId(nodeIdRaw)) {
    return makeRpcResponse({ id, result: toolError('node_id is required') })
  }
  const nodeId = await resolvePublicNodeId(db, treeRow.tree_id, String(nodeIdRaw))
  if (!nodeId) {
    return makeRpcResponse({ id, result: toolError('Node not found') })
  }
  if (!treeRow.trash_root_node_id) {
    return makeRpcResponse({ id, result: toolError('trash root is not configured') })
  }
  if (!accessibleSet.has(nodeId)) {
    return makeRpcResponse({ id, result: toolError('Access denied to node') })
  }
  if (nodeId === treeRow.root_node_id || nodeId === treeRow.trash_root_node_id) {
    return makeRpcResponse({ id, result: toolError('root/trash root node cannot be trashed') })
  }

  const existingNode = await db.prepare('SELECT id, tree_id FROM nodes WHERE id = ?')
    .bind(nodeId)
    .first<{ id: number; tree_id: number }>()
  if (!existingNode || existingNode.tree_id !== treeRow.tree_id) {
    return makeRpcResponse({ id, result: toolError('Node not found') })
  }

  const trashRootId = treeRow.trash_root_node_id
  await db.batch([
    db.prepare('DELETE FROM node_relations WHERE child_node_id = ?').bind(nodeId),
    db.prepare(
      `INSERT OR IGNORE INTO node_relations (parent_node_id, child_node_id, position, relation_type_id)
       VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM node_relations WHERE parent_node_id = ?), 1)`
    ).bind(trashRootId, nodeId, trashRootId),
    db.prepare('UPDATE nodes SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').bind(nodeId),
  ])

  const updated = await db.prepare('SELECT deleted_at FROM nodes WHERE id = ?')
    .bind(nodeId)
    .first<{ deleted_at: string | null }>()

  const publicIdMap = await encodeNodeIds(db, [nodeId])
  if (executionCtx?.waitUntil) {
    executionCtx.waitUntil(deleteNodeVector(env?.VECTORIZE, nodeId))
  }
  queueAuditLog({ userId: principal.user_id, action: 'mcp.trash_node', targetType: 'node', targetId: nodeId, treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({
    id,
    result: toToolResult({
      success: true,
      node_id: publicIdMap.get(nodeId) ?? String(nodeId),
      status: 'moved_to_trash',
      deleted_at: updated?.deleted_at || null,
    }),
  })
}
