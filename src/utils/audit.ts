/**
 * Audit logging utilities
 *
 * Best-effort helpers for recording security and activity events without
 * interfering with the primary request flow.
 */

import type { Context } from 'hono'

export type AuditAction =
  // auth
  | 'auth.login'
  | 'auth.logout'
  // api_key（APIキー方式は廃止。過去ログの参照のため型定義のみ残置）
  | 'api_key.create'
  | 'api_key.delete'
  // profile
  | 'profile.update'
  // tree
  | 'tree.create'
  | 'tree.update'
  | 'tree.delete'
  // member
  | 'member.add'
  | 'member.remove'
  | 'member.role_change'
  // invitation
  | 'invitation.create'
  | 'invitation.accept'
  | 'invitation.cancel'
  // node
  | 'node.create'
  | 'node.update'
  | 'node.restore_content'
  | 'node.duplicate'
  | 'node.delete'
  | 'node.restore'
  | 'node.permanent_delete'
  | 'node.image_upload'
  | 'node.image_delete'
  // relation
  | 'relation.create'
  | 'relation.delete'
  | 'relation.move'
  | 'relation.reorder'
  | 'relation.position_update'
  | 'relation.type_update'
  // read
  | 'read.node'
  | 'read.tree'
  | 'read.api_keys' // 廃止済み。過去ログ参照用に残置
  | 'read.profile'
  | 'read.search'
  // mcp write
  | 'mcp.node.create'
  | 'mcp.node.update'
  | 'mcp.node.update_title'
  | 'mcp.node.append_content'
  | 'mcp.node.edit_content'
  | 'mcp.node.restore_content'
  | 'mcp.node.image_create'
  | 'mcp.link_node'
  | 'mcp.link_nodes'
  | 'mcp.unlink_node'
  | 'mcp.unlink_nodes'
  | 'mcp.move_node'
  | 'mcp.move_nodes'
  | 'mcp.create_node_tree'
  | 'mcp.update_link_relation_type'
  | 'mcp.trash_node'
  // mcp oauth
  | 'mcp_oauth.client_register'
  | 'mcp_oauth.authorize'
  | 'mcp_oauth.deny'
  | 'mcp_oauth.token_issue'
  | 'mcp_oauth.token_refresh'
  | 'mcp_oauth.token_revoke'
  | 'mcp_oauth.membership_revoked'
  // mcp oauth failures（エラーコードは target_id に格納）
  | 'mcp_oauth.token_error'
  | 'mcp_oauth.request_unauthorized'
  | 'mcp_oauth.server_error'
  // mcp read
  | 'mcp.read.node'
  | 'mcp.read.children'
  | 'mcp.read.parents'
  | 'mcp.read.search'
  | 'mcp.read.root_node_id'
  | 'mcp.read.node_image'
  | 'mcp.read.node_history'
  | 'mcp.read.find_in_node'

export type AuditTargetType =
  | 'user'
  | 'tree'
  | 'node'
  | 'relation'
  | 'api_key' // 廃止済み。過去ログ参照用に残置
  | 'invitation'
  | 'oauth_client'

export type AuditSource = 'api' | 'mcp'

export interface AuditLogParams {
  userId: number | null
  action: AuditAction
  targetType: AuditTargetType
  targetId?: string | number
  treeId?: number
  ipAddress?: string
  userAgent?: string
  source?: AuditSource
}

function truncateUserAgent(userAgent: string | undefined): string | null {
  if (!userAgent) {
    return null
  }
  return userAgent.slice(0, 128)
}

/**
 * Best-effort audit logging.
 * Never throws — failures are intentionally swallowed so primary requests
 * continue even if D1 logging is unavailable.
 */
export async function logAudit(db: D1Database, params: AuditLogParams): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO audit_logs
         (user_id, api_key_id, action, target_type, target_id, tree_id, ip_address, user_agent, source, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      )
      .bind(
        params.userId ?? null,
        params.action,
        params.targetType,
        params.targetId != null ? String(params.targetId) : null,
        params.treeId ?? null,
        params.ipAddress ?? null,
        truncateUserAgent(params.userAgent),
        params.source ?? 'api'
      )
      .run()
  } catch {
    // Best-effort: ignore audit logging failures.
  }
}

type AuditContextLike = Pick<Context, 'req' | 'env'> & {
  executionCtx?: {
    waitUntil(promise: Promise<unknown>): void
  }
}

/**
 * Convenience wrapper for Hono handlers.
 *
 * Reads DB from the Cloudflare context, enriches the log with request IP and
 * user agent, then queues the write with waitUntil when available.
 */
export function logAuditFromContext(
  c: AuditContextLike,
  params: Omit<AuditLogParams, 'ipAddress' | 'userAgent'>
): void {
  const db = (c.env as { DB?: D1Database } | undefined)?.DB
  if (!db) {
    return
  }

  const promise = logAudit(db, {
    ...params,
    ipAddress: c.req.header('cf-connecting-ip') ?? undefined,
    userAgent: c.req.header('user-agent') ?? undefined,
  }).catch(() => {})

  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(promise)
    return
  }

  void promise
}
