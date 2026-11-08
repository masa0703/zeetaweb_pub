import type { McpToolContext } from '../tool-context'
import {
  RelationTypeName,
  relationTypeNameFromId,
  resolveRelationTypeId,
} from '../support'
import { encodeNodeIds, isValidPublicNodeId, resolvePublicNodeId, resolvePublicNodeIds } from '../../utils/public-id'
import { CIRCULAR_CHECK_INDETERMINATE_MESSAGE, checkCircularReference } from '../../utils/node-relations'
import {
  appendRelation,
  checkNewRelation,
  checkRelationRemoval,
  LAST_STRUCTURAL_PARENT_ERROR,
  normalizeSoleParentStatement,
  removeRelation,
  setRelationType,
  type NewRelationRejection,
  type RelationRemovalRejection,
} from '../../services/relations'

const MCP_LINK_REJECTION_MESSAGES: Record<NewRelationRejection, string> = {
  self_reference: 'Cannot self-link node',
  cycle_detected: 'Circular reference detected',
  cycle_indeterminate: CIRCULAR_CHECK_INDETERMINATE_MESSAGE,
  already_exists: 'Relation already exists',
}

const MCP_UNLINK_REJECTION_MESSAGES: Record<RelationRemovalRejection, string> = {
  not_found: 'Relation not found',
  last_parent: 'Cannot remove the last parent from a node: a node must keep at least one parent. Use move_node to relocate it, or trash_node to delete it.',
}

export async function linkNode(ctx: McpToolContext) {
  const { id, args, db, principal, treeRow, accessibleSet, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  if (!isValidPublicNodeId(args.child_id) || !isValidPublicNodeId(args.parent_id)) {
    return makeRpcResponse({ id, result: toolError('child_id, parent_id are required') })
  }
  const childId = await resolvePublicNodeId(db, treeRow.tree_id, String(args.child_id))
  const parentId = await resolvePublicNodeId(db, treeRow.tree_id, String(args.parent_id))
  const relationTypeId = resolveRelationTypeId(args.relation_type, args.relation_type_id)

  if (!childId || !parentId) {
    return makeRpcResponse({ id, result: toolError('child_id or parent_id not found') })
  }
  if (!relationTypeId) {
    return makeRpcResponse({ id, result: toolError('Invalid relation_type (STRUCTURAL/REFERENCE)') })
  }
  if (!accessibleSet.has(childId) || !accessibleSet.has(parentId)) {
    return makeRpcResponse({ id, result: toolError('child_id or parent_id is outside scope') })
  }
  const rejection = await checkNewRelation(db, parentId, childId, {
    route: 'mcp:link_node',
    parentId,
    childId,
  })
  if (rejection) {
    return makeRpcResponse({ id, result: toolError(MCP_LINK_REJECTION_MESSAGES[rejection]) })
  }

  await appendRelation(db, parentId, childId, relationTypeId)

  const publicIdMap = await encodeNodeIds(db, [parentId, childId])
  queueAuditLog({ userId: principal.user_id, action: 'mcp.link_node', targetType: 'relation', targetId: `${parentId}:${childId}`, treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({
    id,
    result: toToolResult({
      parent_id: publicIdMap.get(parentId) ?? String(parentId),
      child_id: publicIdMap.get(childId) ?? String(childId),
      relation_type_name: relationTypeNameFromId(relationTypeId),
    }),
  })
}

export async function linkNodes(ctx: McpToolContext) {
  const { id, args, db, principal, treeRow, accessibleSet, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  const linksRaw = Array.isArray(args.links) ? args.links : []
  if (linksRaw.length === 0) {
    return makeRpcResponse({ id, result: toolError('links is required') })
  }

  const publicIdsToResolve = new Set<string>()
  for (const linkRaw of linksRaw) {
    const childIdRaw = (linkRaw as any).child_id
    const parentIdRaw = (linkRaw as any).parent_id
    if (isValidPublicNodeId(childIdRaw)) publicIdsToResolve.add(String(childIdRaw))
    if (isValidPublicNodeId(parentIdRaw)) publicIdsToResolve.add(String(parentIdRaw))
  }
  const idMap = await resolvePublicNodeIds(db, treeRow.tree_id, Array.from(publicIdsToResolve))

  const results: Array<{ parent_id: string; child_id: string; relation_type_name: string; status: string; error?: string }> = []
  const statements: D1PreparedStatement[] = []
  const fail = (parentPublicId: string, childPublicId: string, relationTypeId: number | null, error: string) => {
    const relationTypeName = relationTypeId ? relationTypeNameFromId(relationTypeId) : 'STRUCTURAL'
    results.push({ parent_id: parentPublicId, child_id: childPublicId, relation_type_name: relationTypeName, status: 'failed', error })
  }

  for (const linkRaw of linksRaw) {
    const childPublicId = String((linkRaw as any).child_id || '')
    const parentPublicId = String((linkRaw as any).parent_id || '')
    const relationTypeId = resolveRelationTypeId((linkRaw as any).relation_type, (linkRaw as any).relation_type_id)

    if (!isValidPublicNodeId(childPublicId) || !isValidPublicNodeId(parentPublicId)) {
      fail(parentPublicId, childPublicId, relationTypeId, 'child_id and parent_id are required')
      continue
    }
    const childId = idMap.get(childPublicId)
    const parentId = idMap.get(parentPublicId)
    if (!childId || !parentId) {
      fail(parentPublicId, childPublicId, relationTypeId, 'child_id or parent_id not found')
      continue
    }
    if (!relationTypeId) {
      fail(parentPublicId, childPublicId, relationTypeId, 'Invalid relation_type')
      continue
    }
    if (!accessibleSet.has(childId) || !accessibleSet.has(parentId)) {
      fail(parentPublicId, childPublicId, relationTypeId, 'out of scope')
      continue
    }
    if (childId === parentId) {
      fail(parentPublicId, childPublicId, relationTypeId, 'Cannot self-link node')
      continue
    }

    const cycleCheck = await checkCircularReference(db, parentId, childId, {
      route: 'mcp:link_nodes',
      parentId,
      childId,
    })
    if (cycleCheck === 'cycle_detected') {
      fail(parentPublicId, childPublicId, relationTypeId, 'Circular reference detected')
      continue
    }
    if (cycleCheck === 'indeterminate') {
      fail(parentPublicId, childPublicId, relationTypeId, CIRCULAR_CHECK_INDETERMINATE_MESSAGE)
      continue
    }

    const exists = await db.prepare(
      'SELECT 1 AS exists_flag FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?'
    ).bind(parentId, childId).first<{ exists_flag: number }>()
    if (exists?.exists_flag === 1) {
      fail(parentPublicId, childPublicId, relationTypeId, 'Relation already exists')
      continue
    }

    const maxPos = await db.prepare(
      'SELECT COALESCE(MAX(position), -1) AS max_pos FROM node_relations WHERE parent_node_id = ?'
    ).bind(parentId).first<{ max_pos: number }>()
    const newPos = (maxPos?.max_pos ?? -1) + 1
    statements.push(
      db.prepare(
        `INSERT INTO node_relations (parent_node_id, child_node_id, position, relation_type_id)
         VALUES (?, ?, ?, ?)`
      ).bind(parentId, childId, newPos, relationTypeId)
    )
    results.push({
      parent_id: parentPublicId,
      child_id: childPublicId,
      relation_type_name: relationTypeNameFromId(relationTypeId),
      status: 'linked',
    })
  }

  if (results.some(r => r.status === 'failed')) {
    const failedPayload = {
      message: 'link_nodes failed and rolled back',
      total: linksRaw.length,
      linked: 0,
      failed: linksRaw.length,
      rolled_back: true,
      results,
    }
    return makeRpcResponse({
      id,
      result: {
        isError: true,
        ...toToolResult(failedPayload),
      },
    })
  }

  await db.batch(statements)
  queueAuditLog({ userId: principal.user_id, action: 'mcp.link_nodes', targetType: 'relation', treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({
    id,
    result: toToolResult({
      total: linksRaw.length,
      linked: results.filter(r => r.status === 'linked').length,
      failed: 0,
      rolled_back: false,
      results,
    }),
  })
}

export async function unlinkNode(ctx: McpToolContext) {
  const { id, args, db, principal, treeRow, accessibleSet, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  if (!isValidPublicNodeId(args.child_id) || !isValidPublicNodeId(args.parent_id)) {
    return makeRpcResponse({ id, result: toolError('child_id and parent_id are required') })
  }
  const childId = await resolvePublicNodeId(db, treeRow.tree_id, String(args.child_id))
  const parentId = await resolvePublicNodeId(db, treeRow.tree_id, String(args.parent_id))
  if (!childId || !parentId) {
    return makeRpcResponse({ id, result: toolError('child_id or parent_id not found') })
  }
  if (!accessibleSet.has(childId) || !accessibleSet.has(parentId)) {
    return makeRpcResponse({ id, result: toolError('child_id or parent_id is outside scope') })
  }

  const rejection = await checkRelationRemoval(db, parentId, childId)
  if (rejection) {
    return makeRpcResponse({ id, result: toolError(MCP_UNLINK_REJECTION_MESSAGES[rejection]) })
  }

  await removeRelation(db, parentId, childId)

  const publicIdMap = await encodeNodeIds(db, [parentId, childId])
  queueAuditLog({ userId: principal.user_id, action: 'mcp.unlink_node', targetType: 'relation', targetId: `${parentId}:${childId}`, treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({
    id,
    result: toToolResult({
      success: true,
      parent_id: publicIdMap.get(parentId) ?? String(parentId),
      child_id: publicIdMap.get(childId) ?? String(childId),
    }),
  })
}

export async function unlinkNodes(ctx: McpToolContext) {
  const { id, args, db, principal, treeRow, accessibleSet, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  const linksRaw = Array.isArray(args.links) ? args.links : []
  if (linksRaw.length === 0) {
    return makeRpcResponse({ id, result: toolError('links is required') })
  }

  const publicIdsToResolve = new Set<string>()
  for (const linkRaw of linksRaw) {
    const childIdRaw = (linkRaw as any).child_id
    const parentIdRaw = (linkRaw as any).parent_id
    if (isValidPublicNodeId(childIdRaw)) publicIdsToResolve.add(String(childIdRaw))
    if (isValidPublicNodeId(parentIdRaw)) publicIdsToResolve.add(String(parentIdRaw))
  }
  const idMap = await resolvePublicNodeIds(db, treeRow.tree_id, Array.from(publicIdsToResolve))

  const results: Array<{ parent_id: string; child_id: string; status: string; error?: string }> = []
  const statements: D1PreparedStatement[] = []
  const childIds = new Set<number>()
  for (const linkRaw of linksRaw) {
    const childPublicId = String((linkRaw as any).child_id || '')
    const parentPublicId = String((linkRaw as any).parent_id || '')
    if (!isValidPublicNodeId(childPublicId) || !isValidPublicNodeId(parentPublicId)) {
      results.push({ parent_id: parentPublicId, child_id: childPublicId, status: 'failed', error: 'child_id and parent_id are required' })
      continue
    }
    const childId = idMap.get(childPublicId)
    const parentId = idMap.get(parentPublicId)
    if (!childId || !parentId) {
      results.push({ parent_id: parentPublicId, child_id: childPublicId, status: 'failed', error: 'child_id or parent_id not found' })
      continue
    }
    if (!accessibleSet.has(childId) || !accessibleSet.has(parentId)) {
      results.push({ parent_id: parentPublicId, child_id: childPublicId, status: 'failed', error: 'out of scope' })
      continue
    }
    if (childIds.has(childId)) {
      results.push({ parent_id: parentPublicId, child_id: childPublicId, status: 'failed', error: 'same child_id cannot be modified twice in one batch' })
      continue
    }
    childIds.add(childId)

    const [relationRow, parentCountRow] = await db.batch([
      db.prepare('SELECT 1 AS exists_flag FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?')
        .bind(parentId, childId),
      db.prepare('SELECT COUNT(*) AS parent_count FROM node_relations WHERE child_node_id = ?')
        .bind(childId),
    ])

    const existsFlag = (relationRow.results?.[0] as { exists_flag: number } | undefined)?.exists_flag
    if (existsFlag !== 1) {
      results.push({ parent_id: parentPublicId, child_id: childPublicId, status: 'failed', error: 'Relation not found' })
      continue
    }

    const parentCount = Number((parentCountRow.results?.[0] as { parent_count: number } | undefined)?.parent_count || 0)
    if (parentCount <= 1) {
      results.push({ parent_id: parentPublicId, child_id: childPublicId, status: 'failed', error: 'Cannot remove the last parent from a node: a node must keep at least one parent. Use move_node to relocate it, or trash_node to delete it.' })
      continue
    }

    statements.push(
      db.prepare('DELETE FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?')
        .bind(parentId, childId),
      normalizeSoleParentStatement(db, childId),
    )
    results.push({ parent_id: parentPublicId, child_id: childPublicId, status: 'unlinked' })
  }

  if (results.some(r => r.status === 'failed')) {
    return makeRpcResponse({
      id,
      result: {
        isError: true,
        ...toToolResult({
          total: linksRaw.length,
          unlinked: 0,
          failed: linksRaw.length,
          rolled_back: true,
          results,
        }),
      },
    })
  }

  await db.batch(statements)
  queueAuditLog({ userId: principal.user_id, action: 'mcp.unlink_nodes', targetType: 'relation', treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({
    id,
    result: toToolResult({
      total: linksRaw.length,
      unlinked: results.filter(r => r.status === 'unlinked').length,
      failed: 0,
      rolled_back: false,
      results,
    }),
  })
}

export async function moveNode(ctx: McpToolContext) {
  const { id, args, db, principal, treeRow, accessibleSet, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  if (!isValidPublicNodeId(args.child_id) || !isValidPublicNodeId(args.from_parent_id) || !isValidPublicNodeId(args.to_parent_id)) {
    return makeRpcResponse({ id, result: toolError('child_id, from_parent_id and to_parent_id are required') })
  }
  const childId = await resolvePublicNodeId(db, treeRow.tree_id, String(args.child_id))
  const fromParentId = await resolvePublicNodeId(db, treeRow.tree_id, String(args.from_parent_id))
  const toParentId = await resolvePublicNodeId(db, treeRow.tree_id, String(args.to_parent_id))
  if (!childId || !fromParentId || !toParentId) {
    return makeRpcResponse({ id, result: toolError('child_id, from_parent_id or to_parent_id not found') })
  }
  if (!accessibleSet.has(childId) || !accessibleSet.has(fromParentId) || !accessibleSet.has(toParentId)) {
    return makeRpcResponse({ id, result: toolError('child_id, from_parent_id or to_parent_id is outside scope') })
  }
  if (childId === toParentId) {
    return makeRpcResponse({ id, result: toolError('Cannot move a node under itself') })
  }
  if (fromParentId === toParentId) {
    return makeRpcResponse({ id, result: toolError('from_parent_id and to_parent_id are the same') })
  }

  const [oldRelationRow, newRelationRow] = await db.batch([
    db.prepare('SELECT relation_type_id FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?')
      .bind(fromParentId, childId),
    db.prepare('SELECT 1 AS exists_flag FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?')
      .bind(toParentId, childId),
  ])

  const oldRelation = oldRelationRow.results?.[0] as { relation_type_id: number } | undefined
  if (!oldRelation) {
    return makeRpcResponse({ id, result: toolError('Relation not found (child_id is not linked to from_parent_id)') })
  }
  const destExists = (newRelationRow.results?.[0] as { exists_flag: number } | undefined)?.exists_flag
  if (destExists === 1) {
    return makeRpcResponse({ id, result: toolError('Relation already exists (child_id is already linked to to_parent_id)') })
  }
  const relationTypeId = Number(oldRelation.relation_type_id) || 1

  const cycleCheck = await checkCircularReference(db, toParentId, childId, {
    route: 'mcp:move_node',
    treeId: treeRow.tree_id,
    parentId: toParentId,
    childId,
  })
  if (cycleCheck === 'cycle_detected') {
    return makeRpcResponse({ id, result: toolError('Circular reference detected') })
  }
  if (cycleCheck === 'indeterminate') {
    return makeRpcResponse({ id, result: toolError(CIRCULAR_CHECK_INDETERMINATE_MESSAGE) })
  }

  await db.batch([
    db.prepare(
      `INSERT INTO node_relations (parent_node_id, child_node_id, position, relation_type_id)
       VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM node_relations WHERE parent_node_id = ?), ?)`
    ).bind(toParentId, childId, toParentId, relationTypeId),
    db.prepare('DELETE FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?')
      .bind(fromParentId, childId),
  ])

  const publicIdMap = await encodeNodeIds(db, [fromParentId, toParentId, childId])
  queueAuditLog({ userId: principal.user_id, action: 'mcp.move_node', targetType: 'relation', targetId: `${fromParentId}->${toParentId}:${childId}`, treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({
    id,
    result: toToolResult({
      success: true,
      child_id: publicIdMap.get(childId) ?? String(childId),
      from_parent_id: publicIdMap.get(fromParentId) ?? String(fromParentId),
      to_parent_id: publicIdMap.get(toParentId) ?? String(toParentId),
      relation_type_name: relationTypeNameFromId(relationTypeId),
    }),
  })
}

export async function moveNodes(ctx: McpToolContext) {
  const { id, args, db, principal, treeRow, accessibleSet, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  const movesRaw = Array.isArray(args.moves) ? args.moves : []
  if (movesRaw.length === 0) {
    return makeRpcResponse({ id, result: toolError('moves is required') })
  }

  const publicIdsToResolve = new Set<string>()
  for (const moveRaw of movesRaw) {
    const childIdRaw = (moveRaw as any).child_id
    const fromRaw = (moveRaw as any).from_parent_id
    const toRaw = (moveRaw as any).to_parent_id
    if (isValidPublicNodeId(childIdRaw)) publicIdsToResolve.add(String(childIdRaw))
    if (isValidPublicNodeId(fromRaw)) publicIdsToResolve.add(String(fromRaw))
    if (isValidPublicNodeId(toRaw)) publicIdsToResolve.add(String(toRaw))
  }
  const idMap = await resolvePublicNodeIds(db, treeRow.tree_id, Array.from(publicIdsToResolve))

  const results: Array<{ child_id: string; from_parent_id: string; to_parent_id: string; status: string; relation_type_name?: RelationTypeName; error?: string }> = []
  const statements: D1PreparedStatement[] = []
  const childIds = new Set<number>()
  for (const moveRaw of movesRaw) {
    const childPublicId = String((moveRaw as any).child_id || '')
    const fromPublicId = String((moveRaw as any).from_parent_id || '')
    const toPublicId = String((moveRaw as any).to_parent_id || '')
    if (!isValidPublicNodeId(childPublicId) || !isValidPublicNodeId(fromPublicId) || !isValidPublicNodeId(toPublicId)) {
      results.push({ child_id: childPublicId, from_parent_id: fromPublicId, to_parent_id: toPublicId, status: 'failed', error: 'child_id, from_parent_id and to_parent_id are required' })
      continue
    }
    const childId = idMap.get(childPublicId)
    const fromParentId = idMap.get(fromPublicId)
    const toParentId = idMap.get(toPublicId)
    if (!childId || !fromParentId || !toParentId) {
      results.push({ child_id: childPublicId, from_parent_id: fromPublicId, to_parent_id: toPublicId, status: 'failed', error: 'child_id, from_parent_id or to_parent_id not found' })
      continue
    }
    if (!accessibleSet.has(childId) || !accessibleSet.has(fromParentId) || !accessibleSet.has(toParentId)) {
      results.push({ child_id: childPublicId, from_parent_id: fromPublicId, to_parent_id: toPublicId, status: 'failed', error: 'out of scope' })
      continue
    }
    if (childId === toParentId) {
      results.push({ child_id: childPublicId, from_parent_id: fromPublicId, to_parent_id: toPublicId, status: 'failed', error: 'Cannot move a node under itself' })
      continue
    }
    if (fromParentId === toParentId) {
      results.push({ child_id: childPublicId, from_parent_id: fromPublicId, to_parent_id: toPublicId, status: 'failed', error: 'from_parent_id and to_parent_id are the same' })
      continue
    }
    if (childIds.has(childId)) {
      results.push({ child_id: childPublicId, from_parent_id: fromPublicId, to_parent_id: toPublicId, status: 'failed', error: 'same child_id cannot be moved twice in one batch' })
      continue
    }
    childIds.add(childId)

    const [oldRelationRow, newRelationRow] = await db.batch([
      db.prepare('SELECT relation_type_id FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?')
        .bind(fromParentId, childId),
      db.prepare('SELECT 1 AS exists_flag FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?')
        .bind(toParentId, childId),
    ])

    const oldRelation = oldRelationRow.results?.[0] as { relation_type_id: number } | undefined
    if (!oldRelation) {
      results.push({ child_id: childPublicId, from_parent_id: fromPublicId, to_parent_id: toPublicId, status: 'failed', error: 'Relation not found (child_id is not linked to from_parent_id)' })
      continue
    }
    const destExists = (newRelationRow.results?.[0] as { exists_flag: number } | undefined)?.exists_flag
    if (destExists === 1) {
      results.push({ child_id: childPublicId, from_parent_id: fromPublicId, to_parent_id: toPublicId, status: 'failed', error: 'Relation already exists (child_id is already linked to to_parent_id)' })
      continue
    }
    const relationTypeId = Number(oldRelation.relation_type_id) || 1

    const cycleCheck = await checkCircularReference(db, toParentId, childId, {
      route: 'mcp:move_nodes',
      treeId: treeRow.tree_id,
      parentId: toParentId,
      childId,
    })
    if (cycleCheck === 'cycle_detected') {
      results.push({ child_id: childPublicId, from_parent_id: fromPublicId, to_parent_id: toPublicId, status: 'failed', error: 'Circular reference detected' })
      continue
    }
    if (cycleCheck === 'indeterminate') {
      results.push({ child_id: childPublicId, from_parent_id: fromPublicId, to_parent_id: toPublicId, status: 'failed', error: CIRCULAR_CHECK_INDETERMINATE_MESSAGE })
      continue
    }

    statements.push(
      db.prepare(
        `INSERT INTO node_relations (parent_node_id, child_node_id, position, relation_type_id)
         VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM node_relations WHERE parent_node_id = ?), ?)`
      ).bind(toParentId, childId, toParentId, relationTypeId),
    )
    statements.push(
      db.prepare('DELETE FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?')
        .bind(fromParentId, childId),
    )
    results.push({ child_id: childPublicId, from_parent_id: fromPublicId, to_parent_id: toPublicId, status: 'moved', relation_type_name: relationTypeNameFromId(relationTypeId) })
  }

  if (results.some(r => r.status === 'failed')) {
    return makeRpcResponse({
      id,
      result: {
        isError: true,
        ...toToolResult({
          total: movesRaw.length,
          moved: 0,
          failed: movesRaw.length,
          rolled_back: true,
          results,
        }),
      },
    })
  }

  await db.batch(statements)
  queueAuditLog({ userId: principal.user_id, action: 'mcp.move_nodes', targetType: 'relation', treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({
    id,
    result: toToolResult({
      total: movesRaw.length,
      moved: results.filter(r => r.status === 'moved').length,
      failed: 0,
      rolled_back: false,
      results,
    }),
  })
}

export async function updateLinkRelationType(ctx: McpToolContext) {
  const { id, args, db, principal, treeRow, accessibleSet, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  if (!isValidPublicNodeId(args.child_id) || !isValidPublicNodeId(args.parent_id)) {
    return makeRpcResponse({ id, result: toolError('child_id and parent_id are required') })
  }
  const childId = await resolvePublicNodeId(db, treeRow.tree_id, String(args.child_id))
  const parentId = await resolvePublicNodeId(db, treeRow.tree_id, String(args.parent_id))
  const relationTypeId = resolveRelationTypeId(args.relation_type, args.relation_type_id)
  if (!childId || !parentId) {
    return makeRpcResponse({ id, result: toolError('child_id or parent_id not found') })
  }
  if (!relationTypeId) {
    return makeRpcResponse({ id, result: toolError('Invalid relation_type (STRUCTURAL/REFERENCE)') })
  }
  if (!accessibleSet.has(childId) || !accessibleSet.has(parentId)) {
    return makeRpcResponse({ id, result: toolError('child_id or parent_id is outside scope') })
  }

  const relationExists = await db.prepare(
    'SELECT 1 AS exists_flag FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?'
  ).bind(parentId, childId).first<{ exists_flag: number }>()
  if (relationExists?.exists_flag !== 1) {
    return makeRpcResponse({ id, result: toolError('Relation not found') })
  }

  const change = await setRelationType(db, parentId, childId, relationTypeId)
  if (change.status === 'not_found') {
    return makeRpcResponse({ id, result: toolError('Relation not found') })
  }
  if (change.status === 'last_structural') {
    return makeRpcResponse({ id, result: toolError(LAST_STRUCTURAL_PARENT_ERROR) })
  }

  const publicIdMap = await encodeNodeIds(db, [parentId, childId, ...change.demotedParentIds])
  queueAuditLog({ userId: principal.user_id, action: 'mcp.update_link_relation_type', targetType: 'relation', targetId: `${parentId}:${childId}`, treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({
    id,
    result: toToolResult({
      parent_id: publicIdMap.get(parentId) ?? String(parentId),
      child_id: publicIdMap.get(childId) ?? String(childId),
      relation_type_name: relationTypeNameFromId(relationTypeId),
      demoted_parent_ids: change.demotedParentIds.map((demotedId) => publicIdMap.get(demotedId) ?? String(demotedId)),
    }),
  })
}
