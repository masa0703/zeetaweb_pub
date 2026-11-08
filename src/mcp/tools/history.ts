import type { McpToolContext } from '../tool-context'
import { McpNodeRow, toMcpNode } from '../support'
import { isValidPublicNodeId, resolvePublicNodeId } from '../../utils/public-id'
import {
  countNodeSnapshots,
  nodeSnapshotInsertStatement,
  readNodeSnapshots,
  schedulePurgeNodeSnapshots,
} from '../../utils/node-snapshots'
import { upsertNodeVector } from '../../utils/vector'

export async function readNodeHistory(ctx: McpToolContext) {
  const { id, args, db, principal, treeRow, accessibleSet, queueAuditLog, makeRpcResponse, toToolResult, toolError } = ctx
  const nodeIdRaw = args.node_id
  if (!isValidPublicNodeId(nodeIdRaw)) {
    return makeRpcResponse({ id, result: toolError('node_id is required') })
  }
  const nodeId = await resolvePublicNodeId(db, treeRow.tree_id, String(nodeIdRaw))
  if (!nodeId || !accessibleSet.has(nodeId)) {
    return makeRpcResponse({ id, result: toolError('Node not found') })
  }
  const limit = args.limit === undefined ? 20 : Number(args.limit)
  if (!Number.isInteger(limit) || limit < 1) {
    return makeRpcResponse({ id, result: toolError('limit must be a positive integer') })
  }
  const snapshots = await readNodeSnapshots(db, nodeId, limit)
  const currentNode = await db.prepare('SELECT version FROM nodes WHERE id = ?').bind(nodeId).first<{ version: number }>()

  // アクター情報は行ごとに引かず1クエリでまとめる（20件で最大40クエリのN+1になる）
  const actorIds = [...new Set(snapshots.map((s) => s.user_id).filter((v): v is number => v != null))]
  const clientIds = [...new Set(snapshots.map((s) => s.client_id).filter((v): v is string => v != null))]
  const actorMap = new Map<number, { display_name: string | null; email: string | null }>()
  if (actorIds.length > 0) {
    const { results } = await db.prepare(
      `SELECT id, display_name, email FROM users WHERE id IN (${actorIds.map(() => '?').join(',')})`
    ).bind(...actorIds).all<{ id: number; display_name: string | null; email: string | null }>()
    for (const row of results || []) {
      actorMap.set(row.id, { display_name: row.display_name, email: row.email })
    }
  }
  const clientMap = new Map<string, string | null>()
  if (clientIds.length > 0) {
    const { results } = await db.prepare(
      `SELECT client_id, client_name FROM mcp_oauth_clients WHERE client_id IN (${clientIds.map(() => '?').join(',')})`
    ).bind(...clientIds).all<{ client_id: string; client_name: string | null }>()
    for (const row of results || []) {
      clientMap.set(row.client_id, row.client_name)
    }
  }

  // node_snapshots.id は返さない。
  // これはテーブル全体で共有する AUTOINCREMENT なので、1ノードの履歴だけを
  // 見れば必ず飛ぶ（他ノードの更新が採番を進める）。他の全ツールで id は
  // 「6文字 base58 の公開ノードID」を意味するため、履歴だけ整数の行番号を
  // 同じ名前で返すと版の識別子と誤読され、欠番をバグとして報告される。
  // 復元キーは node_version であり、id は API 上どこからも参照されない。
  const items = snapshots.map((snapshot) => {
    const actor = snapshot.user_id != null ? actorMap.get(snapshot.user_id) : undefined
    return {
      node_version: snapshot.node_version,
      replaced_at: snapshot.created_at,
      source: snapshot.source,
      actor: {
        user_id: snapshot.user_id,
        display_name: actor?.display_name ?? null,
        email: actor?.email ?? null,
        client_name: snapshot.client_id != null ? clientMap.get(snapshot.client_id) ?? null : null,
      },
      ...(args.include_content === true ? { content: snapshot.content } : {}),
    }
  })

  // total は保持総数。limit は最大100に丸められるため、
  // 返却件数だけでは purge が効いているか判定できない
  const total = await countNodeSnapshots(db, nodeId)
  queueAuditLog({ userId: principal.user_id, action: 'mcp.read.node_history', targetType: 'node', targetId: nodeId, treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({ id, result: toToolResult({ node_id: String(nodeIdRaw), current_version: currentNode?.version ?? null, total, limit, returned: items.length, items }) })
}

export async function restoreNodeVersion(ctx: McpToolContext) {
  const { id, args, db, env, principal, treeRow, accessibleSet, executionCtx, queueAuditLog, makeRpcResponse, toToolResult, toolError, toolErrorWithData } = ctx
  const nodeIdRaw = args.node_id
  const nodeVersion = args.node_version === undefined ? undefined : Number(args.node_version)
  const ifVersion = args.if_version === undefined ? undefined : Number(args.if_version)
  if (!isValidPublicNodeId(nodeIdRaw)) return makeRpcResponse({ id, result: toolError('node_id is required') })
  if (!Number.isInteger(nodeVersion) || nodeVersion < 1) return makeRpcResponse({ id, result: toolError('node_version must be a positive integer') })
  if (!Number.isInteger(ifVersion) || ifVersion < 1) return makeRpcResponse({ id, result: toolError('if_version is required and must be a positive integer') })
  const nodeId = await resolvePublicNodeId(db, treeRow.tree_id, String(nodeIdRaw))
  if (!nodeId || !accessibleSet.has(nodeId)) return makeRpcResponse({ id, result: toolError('Node not found') })
  const current = await db.prepare('SELECT id, tree_id, title, content, version FROM nodes WHERE id = ?').bind(nodeId).first<{ id: number; tree_id: number; title: string; content: string | null; version: number }>()
  if (!current || current.tree_id !== treeRow.tree_id) return makeRpcResponse({ id, result: toolError('Node not found') })
  if (current.version !== ifVersion) {
    const currentData = await db.prepare(
      `SELECT n.id, n.title, n.content, u_author.display_name AS author,
              n.created_at, n.updated_at, n.version, n.child_sort_mode, n.child_sort_direction
       FROM nodes n LEFT JOIN users u_author ON u_author.id = n.author_user_id WHERE n.id = ?`
    ).bind(nodeId).first<McpNodeRow>()
    return makeRpcResponse({ id, result: toolErrorWithData({
      error: 'Version conflict', current_version: current.version,
      server_data: currentData ? { ...toMcpNode(currentData), id: String(nodeIdRaw) } : null,
    }) })
  }
  const snapshot = await db.prepare(
    'SELECT content FROM node_snapshots WHERE node_id = ? AND node_version = ? ORDER BY id DESC LIMIT 1'
  ).bind(nodeId, nodeVersion).first<{ content: string | null }>()
  if (!snapshot) return makeRpcResponse({ id, result: toolError('Snapshot version not found') })
  // INSERT と UPDATE は同一 batch。別々に await すると、version ガードで
  // UPDATE が0行になったときスナップショットだけが残る
  const restoreWrites = await db.batch([
    nodeSnapshotInsertStatement(db, {
      nodeId, content: current.content, nodeVersion: current.version,
      userId: principal.user_id, source: 'mcp', clientId: principal.client_id,
    }),
    db.prepare(
      `UPDATE nodes SET content = ?, updated_by_user_id = ?, updated_by_client_id = ?, version = version + 1,
         updated_at = CURRENT_TIMESTAMP WHERE id = ? AND version = ? RETURNING version, updated_at`
    ).bind(snapshot.content, principal.user_id, principal.client_id, nodeId, ifVersion),
  ])
  const updated = restoreWrites[1].results?.[0] as { version: number; updated_at: string } | undefined
  if (!updated) return makeRpcResponse({ id, result: toolError('Failed to restore node') })
  await schedulePurgeNodeSnapshots(db, nodeId, executionCtx?.waitUntil?.bind(executionCtx))
  if (executionCtx?.waitUntil) executionCtx.waitUntil(upsertNodeVector(env?.AI, env?.VECTORIZE, db, nodeId))
  queueAuditLog({ userId: principal.user_id, action: 'mcp.node.restore_content', targetType: 'node', targetId: nodeId, treeId: treeRow.tree_id, source: 'mcp' })
  return makeRpcResponse({ id, result: toToolResult({ success: true, node_id: String(nodeIdRaw), version: updated.version, updated_at: updated.updated_at }) })
}
