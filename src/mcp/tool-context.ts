import type { McpPermissionPreset } from './tool-registry'
import type { Bindings } from '../bindings'
import type { AuditLogParams } from '../utils/audit'

/**
 * MCP リクエストの実行主体。
 *
 * - `rate_limit_key`: レート制限のキー（`oauth:<token row id>`）
 */
export type McpPrincipal = {
  user_id: number
  root_node_id: number
  permission_preset: McpPermissionPreset
  credential_type: 'oauth'
  rate_limit_key: string
  client_id: string | null
}

export type McpProtocolEra = 'legacy' | 'modern'

export type ExecutionCtxLike = {
  waitUntil(promise: Promise<unknown>): void
}

/** handleMcpRpc が trees テーブルから解決するスコープツリー行 */
export type McpTreeRow = {
  tree_id: number
  root_node_id: number
  trash_root_node_id: number | null
}

/**
 * MCP ツールハンドラへの実行コンテキスト。handleMcpRpc が組立て、
 * MCP_TOOL_HANDLERS に登録された各ハンドラが消費する。
 */
export type McpToolContext = {
  id: unknown
  args: Record<string, unknown>
  db: D1Database
  env: Pick<Bindings, 'AI' | 'VECTORIZE' | 'NODE_IMAGES'> | undefined
  principal: McpPrincipal
  treeRow: McpTreeRow
  accessibleSet: Set<number>
  era: McpProtocolEra
  executionCtx: ExecutionCtxLike | undefined
  queueAuditLog: (params: AuditLogParams) => void
  makeRpcResponse: (payload: Record<string, unknown>) => Record<string, unknown>
  makeRpcError: (id: unknown, code: number, message: string, data?: unknown) => Record<string, unknown>
  toToolResult: (data: unknown) => { content: Array<{ type: string; text: string }>; structuredContent: unknown }
  toolError: (message: string) => { isError: boolean; content: Array<{ type: string; text: string }> }
  toolErrorWithData: (data: Record<string, unknown>) => { isError: boolean; content: Array<{ type: string; text: string }>; structuredContent: unknown }
}

export type McpToolHandler = (ctx: McpToolContext) => Promise<Record<string, unknown> | null>
