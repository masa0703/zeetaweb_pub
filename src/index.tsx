import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import { setCookie, getCookie } from 'hono/cookie'
import { resolveLocaleFromRequest, serverT } from './utils/i18n'
import jaDict from '../public/static/i18n/ja.json'
import enDict from '../public/static/i18n/en.json'
import { getOAuthConfig, normalizeGoogleUser, normalizeGitHubUser, pickPrimaryGithubEmail, OAuthUserInfo } from './config/oauth'
import { generateJWT, verifyJWT } from './utils/jwt'
import type { JWTPayload } from './utils/jwt'
import { upsertOAuthUser, createSession, deleteSession } from './utils/database'
import { authMiddleware, getCurrentUser } from './middleware/auth'
import { findActiveSession } from './utils/session-auth'
import { logAudit, logAuditFromContext } from './utils/audit'
import { withPublicIdRetry, resolvePublicNodeId, resolvePublicNodeIds, encodeNodeIds, isValidPublicNodeId, resolvePublicNodeIdForScope, D1_IN_CLAUSE_BATCH } from './utils/public-id'
import { splitIntoChunks, chunkVectorId } from './utils/vector-chunk'
import { buildLikeClause } from './utils/search-like'
import { getUserTrees, getTreeById, createTree, updateTree, deleteTree, getTreeStats } from './utils/trees'
import {
  getUserRole,
  canViewTree,
  canEditTree,
  canUpdateTreeMetadata,
  canDeleteTree,
  canManageMembers,
  isTreeOwner,
  getTreeMembers,
  addTreeMember,
  removeTreeMember,
  updateMemberRole
} from './utils/permissions'
import {
  createInvitation,
  getInvitationByToken,
  acceptInvitation,
  getTreeInvitations,
  cancelInvitation
} from './utils/invitations'
import { sendInvitationEmail } from './services/email'
import {
  findMcpToolDefinition,
  getAllowedMcpTools,
  isMcpPermissionPreset,
  isToolAllowedForPreset,
} from './mcp/tool-registry'
import {
  MCP_OAUTH_SCOPE_READ,
  MCP_OAUTH_SCOPE_WRITE,
  MCP_OAUTH_SUPPORTED_SCOPES,
  MCP_RESOURCE_PATH_PREFIX,
  buildAuthorizationServerMetadata,
  buildMcpResourceUrl,
  buildProtectedResourceMetadata,
  buildWwwAuthenticateHeader,
  clientGrantTypes,
  clientRedirectUris,
  consumeAuthorizationCode,
  consumeAuthorizationRequest,
  createAuthorizationRequest,
  findTokenRow,
  getActiveTree,
  getOAuthClient,
  grantedScopeForRole,
  isRefreshFamilyAlive,
  isTokenRowUsable,
  issueAuthorizationCode,
  issueTokenPair,
  parseScopeParam,
  parseTreeIdFromResource,
  permissionPresetForOAuth,
  registerOAuthClient,
  MCP_OAUTH_REGISTER_MAX_BODY_BYTES,
  revokeRefreshTokenFamily,
  revokeTokenByValue,
  revokeTokensForUserTree,
  rotateRefreshToken,
  scopeIncludes,
  toSqlDatetime,
  touchAccessToken,
  verifyPkceS256,
} from './oauth/mcp-oauth'
import { renderConsentPage, renderOAuthErrorPage } from './oauth/consent-page'
import { nodeSnapshotInsertStatement, schedulePurgeNodeSnapshots, readNodeSnapshots, countNodeSnapshots, purgeNodeSnapshotsForNodes } from './utils/node-snapshots'
import {
  NODE_CONTENT_MAX_LENGTH,
  NODE_TITLE_MAX_LENGTH,
  QuotaExceededError,
  assertNodeQuota,
  TREE_DESCRIPTION_MAX_LENGTH,
  TREE_NAME_MAX_LENGTH,
  disabledOperatorHttpRoute,
  requestBodyIsTooLarge,
  requestBodyExceedsLimit,
  MCP_JSON_MAX_BYTES,
  isTestBackdoorEnvironmentAllowed,
  safeSameAppRedirect,
  validateTextLimit,
  validateTreeColor,
  validateTreeIcon,
} from './utils/request-safety'
import type { Bindings } from './bindings'
import { MCP_TOOL_HANDLERS } from './mcp/dispatch'
import type { ExecutionCtxLike, McpPrincipal, McpProtocolEra } from './mcp/tool-context'
import { withTimeout } from './utils/async'
import {
  CIRCULAR_CHECK_INDETERMINATE_MESSAGE,
  checkCircularReference,
  getAccessibleNodeIds,
} from './utils/node-relations'
import { storeNodeImage, validateNodeImage, type NodeImageRejection } from './services/node-images'
import { parseSearchQuery } from './services/search'
import {
  appendRelation,
  checkNewRelation,
  checkRelationRemoval,
  LAST_STRUCTURAL_PARENT_ERROR,
  normalizeSoleParentStatement,
  removeRelation,
  setRelationType,
  type NewRelationRejection,
} from './services/relations'
import {
  buildNodeImageFileUrl,
  stripNodeImageMarkdownReferences,
  buildStoredImageFileName,
  normalizeImageBaseName,
  resolveImageExt,
  splitFileNameAndExt,
} from './utils/node-images'
import {
  buildNodeVectorText,
  deleteNodeVector,
  generateEmbedding,
  generateEmbeddingsBatch,
  getNodePathText,
  upsertNodeVector,
  vectorSearch,
} from './utils/vector'

// ビルド日時（MMDD-HHMM）のグローバル型定義
declare const __BUILD_STAMP__: string

const app = new Hono<{ Bindings: Bindings }>()

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function relationIconFromType(iconType: number | null | undefined): string {
  if (iconType === 3) return '→'
  return '•'
}

type DuplicateSourceImageRow = {
  id: number
  serial_no: number
  file_name: string
  file_ext: string
  mime_type: string
  file_size: number
  r2_key: string
}

type DuplicatedImageMapping = {
  oldUrl: string
  newUrl: string
  imageId: number
  r2Key: string
}

function replaceDuplicateImageUrls(contentRaw: string | null | undefined, mappings: DuplicatedImageMapping[]): string {
  let content = String(contentRaw || '')
  if (!content || mappings.length === 0) return content
  for (const mapping of mappings) {
    if (!mapping.oldUrl || mapping.oldUrl === mapping.newUrl) continue
    content = content.split(mapping.oldUrl).join(mapping.newUrl)
  }
  return content
}

async function copyImagesForDuplicatedNode(
  db: D1Database,
  imageBucket: R2Bucket,
  treeId: number,
  sourceNodeId: number,
  targetNodeId: number,
  sourceNodePublicId: string,
  targetNodePublicId: string,
  sourceImages: DuplicateSourceImageRow[],
  actorUserId: number
): Promise<DuplicatedImageMapping[]> {
  const mappings: DuplicatedImageMapping[] = []

  for (const sourceImage of sourceImages) {
    const sourceObject = await imageBucket.get(sourceImage.r2_key)
    if (!sourceObject) {
      throw new Error(`Source image object not found: image_id=${sourceImage.id}`)
    }

    const sourceBytes = await sourceObject.arrayBuffer()
    const extFromName = splitFileNameAndExt(sourceImage.file_name).ext
    const ext = String(sourceImage.file_ext || extFromName || resolveImageExt(sourceImage.file_name, sourceImage.mime_type) || '').toLowerCase()
    if (!ext) {
      throw new Error(`Failed to resolve extension for source image: image_id=${sourceImage.id}`)
    }
    const { baseName } = splitFileNameAndExt(sourceImage.file_name)
    const normalizedBaseName = normalizeImageBaseName(baseName)

    const serialRow = await db.prepare(
      'SELECT COALESCE(MAX(serial_no), 0) AS max_serial FROM node_images WHERE node_id = ?'
    )
      .bind(targetNodeId)
      .first<{ max_serial: number }>()
    const serialNo = Number(serialRow?.max_serial || 0) + 1

    let fileName = buildStoredImageFileName(normalizedBaseName, ext, 1)
    let fileNameSerial = 1
    while (true) {
      const existsRow = await db.prepare(
        'SELECT id FROM node_images WHERE tree_id = ? AND node_id = ? AND file_name = ? LIMIT 1'
      )
        .bind(treeId, targetNodeId, fileName)
        .first<{ id: number }>()
      if (!existsRow) break
      fileNameSerial += 1
      fileName = buildStoredImageFileName(normalizedBaseName, ext, fileNameSerial)
    }

    const targetR2Key = `tree_${treeId}/node_${targetNodeId}/${fileName}`
    await imageBucket.put(targetR2Key, sourceBytes, {
      httpMetadata: { contentType: sourceImage.mime_type || 'application/octet-stream' },
    })

    try {
      const inserted = await db.prepare(
        `INSERT INTO node_images (
           tree_id, node_id, serial_no, file_name, file_ext, mime_type, file_size, r2_key, created_by_user_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      )
        .bind(
          treeId,
          targetNodeId,
          serialNo,
          fileName,
          ext,
          sourceImage.mime_type,
          sourceImage.file_size,
          targetR2Key,
          actorUserId,
        )
        .first<{ id: number }>()

      if (!inserted?.id) {
        await imageBucket.delete(targetR2Key)
        throw new Error(`Failed to insert duplicated node image metadata: source_image_id=${sourceImage.id}`)
      }

      mappings.push({
        oldUrl: buildNodeImageFileUrl(treeId, sourceNodePublicId, sourceImage.id),
        newUrl: buildNodeImageFileUrl(treeId, targetNodePublicId, inserted.id),
        imageId: inserted.id,
        r2Key: targetR2Key,
      })
    } catch (error) {
      await imageBucket.delete(targetR2Key)
      throw error
    }
  }

  return mappings
}

async function cleanupDuplicatedNodeFailure(
  env: Bindings,
  treeId: number,
  duplicatedNodeId: number | null,
  copiedImageR2Keys: string[]
) {
  for (const r2Key of copiedImageR2Keys) {
    try {
      await env.NODE_IMAGES.delete(r2Key)
    } catch (error) {
      console.error('Failed to cleanup duplicated image object:', { treeId, duplicatedNodeId, r2Key, error })
    }
  }

  if (!duplicatedNodeId) return

  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM node_images WHERE tree_id = ? AND node_id = ?').bind(treeId, duplicatedNodeId),
      env.DB.prepare('DELETE FROM node_relations WHERE child_node_id = ?').bind(duplicatedNodeId),
      env.DB.prepare('DELETE FROM nodes WHERE id = ? AND tree_id = ?').bind(duplicatedNodeId, treeId),
      env.DB.prepare('UPDATE trees SET node_count = MAX(0, node_count - 1) WHERE id = ?').bind(treeId),
    ])
  } catch (error) {
    console.error('Failed to cleanup duplicated node records:', { treeId, duplicatedNodeId, error })
  }
}

function parsePositiveInt(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = parseInt(String(value), 10)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

const MCP_MODERN_PROTOCOL_VERSION = '2026-07-28'
const MCP_LEGACY_PROTOCOL_VERSION = '2025-11-25'
const MCP_SUPPORTED_PROTOCOL_VERSIONS = [MCP_MODERN_PROTOCOL_VERSION, MCP_LEGACY_PROTOCOL_VERSION]
const MCP_SERVER_INFO = {
  name: 'zeetaweb-mcp',
  version: '1.2.0',
}
const MCP_TOOL_RATE_LIMIT_PER_MINUTE = 300
const mcpToolRateLimits = new Map<string, { windowStartedAt: number; count: number }>()

function consumeMcpToolRateLimit(rateLimitKey: string): boolean {
  const now = Date.now()
  const current = mcpToolRateLimits.get(rateLimitKey)
  if (!current || now - current.windowStartedAt >= 60_000) {
    mcpToolRateLimits.set(rateLimitKey, { windowStartedAt: now, count: 1 })
    return true
  }
  if (current.count >= MCP_TOOL_RATE_LIMIT_PER_MINUTE) {
    return false
  }
  current.count += 1
  return true
}

function createMcpResponseHelpers(requestIdFallback: string) {
  const makeRpcResponse = (payload: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    ...payload,
  })

  const makeRpcError = (id: unknown, code: number, message: string, data?: unknown) =>
    makeRpcResponse({
      id: id ?? requestIdFallback,
      error: data === undefined ? { code, message } : { code, message, data },
    })

  return { makeRpcResponse, makeRpcError }
}

function makeMcpProtocolError(id: unknown, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  }
}

function decodeMcpMirroredHeader(value: string): string | null {
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) {
    return value
  }

  try {
    const base64Value = value.slice('=?base64?'.length, -2)
    const bytes = Uint8Array.from(atob(base64Value), (character) => character.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function getMcpRequestName(rpcReq: any): string | null {
  const method = String(rpcReq?.method || '')
  if (method === 'tools/call' || method === 'prompts/get') {
    return typeof rpcReq?.params?.name === 'string' ? rpcReq.params.name : null
  }
  if (method === 'resources/read') {
    return typeof rpcReq?.params?.uri === 'string' ? rpcReq.params.uri : null
  }
  return null
}

function validateModernMcpHttpRequest(c: any, body: any): {
  era: McpProtocolEra
  error?: Record<string, unknown>
  status?: 400
} {
  const headerVersion = c.req.header('mcp-protocol-version')
  const bodyVersion = !Array.isArray(body)
    ? body?.params?._meta?.['io.modelcontextprotocol/protocolVersion']
    : undefined

  // `2026-07-28` の厳格な検証（header と `_meta` の相互ミラーリング）は、
  // クライアントが `params._meta` にバージョンを載せて明示的にその方式を
  // 選択したときにだけ適用する。
  //
  // `MCP-Protocol-Version` ヘッダーを送るだけの標準的なMCPクライアント
  // （Codex / Claude 等）は `_meta` へのミラーリングを行わない。ヘッダーの
  // 存在だけで modern 判定すると、正常なクライアントの `initialize` を
  // `-32020` / `-32601` で弾いてしまうため、legacy 互換パスで処理する。
  const usesModernMeta = typeof bodyVersion === 'string'
  const declaresModernHeader = headerVersion === MCP_MODERN_PROTOCOL_VERSION

  const id = Array.isArray(body) ? null : body?.id

  // batch は `2026-07-28` では禁止。`_meta` / ヘッダーのどちらで宣言していても拒否する
  if (Array.isArray(body) && (usesModernMeta || declaresModernHeader)) {
    return {
      era: 'modern',
      status: 400,
      error: makeMcpProtocolError(null, -32600, 'Invalid Request: batch messages are not supported'),
    }
  }

  if (!usesModernMeta) {
    return { era: 'legacy' }
  }

  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string' || body.id === null) {
    return {
      era: 'modern',
      status: 400,
      error: makeMcpProtocolError(id, -32600, 'Invalid Request'),
    }
  }
  const isNotification = body.id === undefined
  if (
    (isNotification && !body.method.startsWith('notifications/'))
    || (!isNotification && typeof body.id !== 'string' && typeof body.id !== 'number')
  ) {
    return {
      era: 'modern',
      status: 400,
      error: makeMcpProtocolError(id, -32600, 'Invalid Request: requests require a string or number id'),
    }
  }
  if (!headerVersion || headerVersion !== bodyVersion) {
    return {
      era: 'modern',
      status: 400,
      error: makeMcpProtocolError(id, -32020, 'Header mismatch: MCP-Protocol-Version must match request _meta', {
        header: headerVersion ?? null,
        meta: bodyVersion,
      }),
    }
  }
  if (bodyVersion !== MCP_MODERN_PROTOCOL_VERSION) {
    return {
      era: 'modern',
      status: 400,
      error: makeMcpProtocolError(id, -32022, 'Unsupported protocol version', {
        supported: MCP_SUPPORTED_PROTOCOL_VERSIONS,
        requested: bodyVersion,
      }),
    }
  }
  const clientCapabilities = body?.params?._meta?.['io.modelcontextprotocol/clientCapabilities']
  if (!clientCapabilities || typeof clientCapabilities !== 'object' || Array.isArray(clientCapabilities)) {
    return {
      era: 'modern',
      status: 400,
      error: makeMcpProtocolError(id, -32602, 'Invalid params: clientCapabilities is required in _meta'),
    }
  }

  const methodHeader = c.req.header('mcp-method')
  if (!methodHeader || methodHeader !== body.method) {
    return {
      era: 'modern',
      status: 400,
      error: makeMcpProtocolError(id, -32020, 'Header mismatch: Mcp-Method must match request method'),
    }
  }

  const expectedName = getMcpRequestName(body)
  if (body.method === 'tools/call' || body.method === 'resources/read' || body.method === 'prompts/get') {
    const encodedNameHeader = c.req.header('mcp-name')
    const decodedNameHeader = encodedNameHeader ? decodeMcpMirroredHeader(encodedNameHeader) : null
    if (expectedName === null || decodedNameHeader === null || decodedNameHeader !== expectedName) {
      return {
        era: 'modern',
        status: 400,
        error: makeMcpProtocolError(id, -32020, 'Header mismatch: Mcp-Name must match request name or URI'),
      }
    }
  }

  return { era: 'modern' }
}

function finalizeMcpRpcResponse(
  payload: Record<string, unknown> | null,
  era: McpProtocolEra,
  method: string,
): Record<string, unknown> | null {
  if (!payload || era !== 'modern' || !payload.result || typeof payload.result !== 'object') {
    return payload
  }

  const result = payload.result as Record<string, unknown>
  const resultMeta = result._meta && typeof result._meta === 'object'
    ? result._meta as Record<string, unknown>
    : {}
  const finalizedResult: Record<string, unknown> = {
    ...result,
    resultType: result.resultType || 'complete',
    _meta: {
      ...resultMeta,
      'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO,
    },
  }

  if (
    method === 'server/discover'
    || method === 'tools/list'
    || method === 'resources/list'
    || method === 'resources/templates/list'
    || method === 'resources/read'
  ) {
    finalizedResult.ttlMs ??= 300_000
    finalizedResult.cacheScope ??= 'private'
  }

  return { ...payload, result: finalizedResult }
}

async function handleMcpRpc(
  db: D1Database,
  principal: McpPrincipal,
  rpcReq: any,
  executionCtx?: ExecutionCtxLike,
  env?: Pick<Bindings, 'AI' | 'VECTORIZE' | 'NODE_IMAGES'>,
  era: McpProtocolEra = 'legacy',
): Promise<Record<string, unknown> | null> {
  const requestIdFallback = crypto.randomUUID()
  const { makeRpcResponse, makeRpcError } = createMcpResponseHelpers(requestIdFallback)
  const queueAuditLog = (params: Parameters<typeof logAudit>[1]) => {
    const promise = logAudit(db, params).catch(() => {})
    if (executionCtx?.waitUntil) {
      executionCtx.waitUntil(promise)
      return
    }
    void promise
  }

  const id = rpcReq?.id ?? requestIdFallback
  const isNotification = rpcReq?.id === undefined
  const method = String(rpcReq?.method || '')
  const params = rpcReq?.params || {}

  const toToolResult = (data: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  })

  const toolError = (message: string) => ({ isError: true, content: [{ type: 'text', text: message }] })

  /**
   * データを伴う tool error。
   *
   * 楽観ロックの競合では、クライアントが同じターン内でマージして再送できるよう
   * 現在の内容を返す必要がある。成功時の toToolResult と同じく text と
   * structuredContent の両方を埋める（text だけだと structuredContent を読む
   * クライアントに何も届かない）。
   */
  const toolErrorWithData = (data: Record<string, unknown>) => ({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  })

  const mcpSystemPrompt =
    "You are an agent operating 'zeetaweb', a knowledge base with a DAG (Directed Acyclic Graph) structure.\n\n" +
    "**Structure:**\n" +
    "- Nodes can have multiple parents.\n" +
    "- Relations have types:\n" +
    "  - **STRUCTURAL**: Parent-child ownership.\n" +
    "  - **REFERENCE**: Weak link / Cross-reference.\n\n" +
    "**Strategy:**\n" +
    '- When asked "Why?", look at the `parents` (reverse tree).\n' +
    "- A node has only one STRUCTURAL parent. Link any additional parents with `REFERENCE`."

  try {
    if (era === 'modern' && method === 'server/discover') {
      return makeRpcResponse({
        id,
        result: {
          supportedVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
          capabilities: {
            tools: {},
            resources: {},
          },
          instructions: mcpSystemPrompt,
        },
      })
    }

    if (era === 'legacy' && method === 'initialize') {
      const requestedVersion = String(params.protocolVersion || MCP_LEGACY_PROTOCOL_VERSION)
      return makeRpcResponse({
        id,
        result: {
          protocolVersion: requestedVersion,
          capabilities: {
            tools: {},
            resources: {},
          },
          serverInfo: MCP_SERVER_INFO,
        }
      })
    }

    if (era === 'legacy' && isNotification && method === 'notifications/initialized') {
      return null
    }

    if (method === 'tools/list') {
      return makeRpcResponse({
        id,
        result: {
          tools: getAllowedMcpTools(principal.permission_preset).map(({ accessLevel: _accessLevel, ...tool }) => tool)
        }
      })
    }

    // JSON-RPC notifications never return a response payload. A request whose
    // method merely starts with notifications/ is still a request when it has an id.
    if (isNotification && method.startsWith('notifications/')) {
      return null
    }

    const accessibleIds = await getAccessibleNodeIds(db, principal.root_node_id)
    const accessibleSet = new Set(accessibleIds)

    const treeRow = await db.prepare(
      `SELECT n.tree_id, t.root_node_id, t.trash_root_node_id
       FROM nodes n
       JOIN trees t ON t.id = n.tree_id
       WHERE n.id = ?`
    )
      .bind(principal.root_node_id)
      .first<{ tree_id: number; root_node_id: number; trash_root_node_id: number | null }>()
    if (!treeRow) {
      throw new Error('Scoped root node is missing')
    }

    if (method === 'resources/list') {
      return makeRpcResponse({
        id,
        result: {
          resources: [
            {
              uri: 'zeeta://system-prompt',
              name: 'zeetaweb system prompt',
              mimeType: 'text/plain',
            }
          ]
        }
      })
    }

    if (method === 'resources/read') {
      if (params?.uri !== 'zeeta://system-prompt') {
        if (era === 'modern') {
          return makeRpcError(id, -32602, 'Invalid params: resource not found')
        }
        return makeRpcResponse({ id, result: { contents: [] } })
      }
      return makeRpcResponse({
        id,
        result: {
          contents: [
            {
              uri: 'zeeta://system-prompt',
              mimeType: 'text/plain',
              text: mcpSystemPrompt,
            }
          ]
        }
      })
    }

    if (method === 'tools/call') {
      const toolName = String(params?.name || '')
      const args = (params?.arguments || {}) as Record<string, unknown>
      const toolDefinition = findMcpToolDefinition(toolName)

      if (!toolDefinition) {
        if (era === 'modern') {
          return makeRpcError(id, -32602, `Invalid params: unknown tool ${toolName}`)
        }
        return makeRpcResponse({ id, result: toolError(`Unknown tool: ${toolName}`) })
      }
      if (!isToolAllowedForPreset(principal.permission_preset, toolDefinition.accessLevel)) {
        return makeRpcResponse({ id, result: toolError('Tool not allowed for this API key') })
      }
      if (!consumeMcpToolRateLimit(principal.rate_limit_key)) {
        return makeRpcResponse({ id, result: toolError('Tool invocation rate limit exceeded; retry later') })
      }

      const handler = MCP_TOOL_HANDLERS[toolName]
      if (!handler) {
        return makeRpcError(id, -32601, `Method not found: ${method}`)
      }
      return handler({
        id,
        args,
        db,
        env,
        principal,
        treeRow,
        accessibleSet,
        era,
        executionCtx,
        queueAuditLog,
        makeRpcResponse,
        makeRpcError,
        toToolResult,
        toolError,
        toolErrorWithData,
      })
    }

    if (era === 'legacy' && method === 'ping') {
      return makeRpcResponse({ id, result: { ok: true } })
    }

    return makeRpcError(id, -32601, `Method not found: ${method}`)
  } catch (error) {
    console.error('MCP handler error:', error)
    return makeRpcError(id, -32603, 'Internal error')
  }
}

// セキュリティヘッダ + 検索エンジン拒否（③非公開・承認制要件）
// 全レスポンスに付与する。CSP は HTML レスポンスのみに付与（API には不要かつ余計な制約になる）
const CSP_DIRECTIVES = [
  "default-src 'self'",
  // 'unsafe-inline'/'unsafe-eval' は Tailwind CDN ランタイムと既存インライン onclick が必要としている。
  // インラインハンドラを廃止できれば 'unsafe-inline' を外せる。
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "font-src 'self' data: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  // Google アバター等の外部画像と base64 画像（ペースト時）を許容
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

app.use('*', async (c, next) => {
  await next()
  // 検索エンジン拒否
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  // クリックジャッキング防止
  c.header('X-Frame-Options', 'DENY')
  // MIME sniffing 防止
  c.header('X-Content-Type-Options', 'nosniff')
  // HTTPS 強制（プリロード対応）
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')
  // Referrer 漏洩抑制
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  // 不要な強力 API を無効化
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
  // Cross-origin policies
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
  c.header('Cross-Origin-Resource-Policy', 'same-site')
  // CSP は HTML レスポンスにのみ付与（API レスポンスには不要）
  // ルート側で個別に CSP を設定している場合（MCP OAuth 同意画面の form-action 等）は上書きしない
  const contentType = c.res.headers.get('content-type') || ''
  if (contentType.includes('text/html') && !c.res.headers.get('content-security-policy')) {
    c.header('Content-Security-Policy', CSP_DIRECTIVES)
  }
})

/**
 * 未処理例外（5xx）の監査ログ。MCP OAuth 関連パス（/oauth/*, /api/mcp/*）に限定して
 * mcp_oauth.server_error を記録する。例外の詳細（メッセージ等）はサイズと秘匿情報の
 * 理由で audit_logs には入れず console.error のみに出す。応答は Hono デフォルトと
 * 同じ 500 を返す（既存のクライアント挙動を変えない）。
 */
app.onError((error, c) => {
  const path = c.req.path
  if (path.startsWith('/oauth/') || path.startsWith('/api/mcp/')) {
    console.error(`[mcp_oauth.server_error] ${c.req.method} ${path}`, error)
    const treeIdMatch = path.match(new RegExp(`^${MCP_RESOURCE_PATH_PREFIX}([1-9][0-9]{0,17})`))
    logAuditFromContext(c, {
      userId: null,
      action: 'mcp_oauth.server_error',
      targetType: 'oauth_client',
      targetId: `unhandled_exception:${c.req.method} ${path}`.slice(0, 128),
      treeId: treeIdMatch ? Number(treeIdMatch[1]) : undefined,
    })
  }
  return c.text('Internal Server Error', 500)
})

// robots.txt（Cloudflare 自動生成 robots.txt より優先される）
app.get('/robots.txt', (c) => {
  return c.text('User-agent: *\nDisallow: /\n', 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  })
})

// CORS設定: ③要件のためアプリのオリジンに限定。同一オリジン fetch も Cookie を必要とするため credentials=true。
app.use('/api/*', cors({
  origin: (origin, c) => {
    const appUrl = (c.env as any)?.APP_URL || ''
    // 本番: APP_URL のみ許可
    if (origin && appUrl && origin === appUrl) return origin
    // 開発: localhost / 127.0.0.1 を許可（ポートは問わない）
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin
    // 同一オリジン fetch は Origin ヘッダが付かない場合がある（その場合は cors ミドルウェアは特に何もしない）
    return null
  },
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: [
    'Content-Type',
    'Authorization',
    'MCP-Protocol-Version',
    'Mcp-Method',
    'Mcp-Name',
  ],
}))

// 静的ファイル配信
app.use('/static/*', serveStatic({ root: './public' }))

// HTMLファイル配信
import loginHtml from '../public/login.html?raw'
import acceptInvitationHtml from '../public/accept-invitation.html?raw'
import profileHtml from '../public/profile.html?raw'
import helpHtml from '../public/help.html?raw'
import helpEnHtml from '../public/help.en.html?raw'
import mermaidViewerHtml from '../public/mermaid-viewer.html?raw'
import htmlViewerHtml from '../public/html-viewer.html?raw'
import imageViewerHtml from '../public/image-viewer.html?raw'
import treeRailHtml from './views/tree-rail.html?raw'
import treeModalsHtml from './views/tree-modals.html?raw'

const requestLocale = (c: Context) => resolveLocaleFromRequest(getCookie(c, 'lang'), c.req.header('accept-language'))

const localizedHtml = (c: Context, html: string, localeOverride?: 'ja' | 'en') => {
  const locale = localeOverride ?? requestLocale(c)
  const dictionary = locale === 'ja' ? jaDict : enDict
  const serializedDictionary = JSON.stringify(dictionary).replace(/</g, '\\u003c')
  let localized = html
  let langApplied = false
  let headApplied = false

  localized = localized.replace(/<html\b([^>]*)>/i, (_match, attributes: string) => {
    langApplied = true
    const attributesWithoutLang = attributes.replace(/\s+lang\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    return `<html${attributesWithoutLang} lang="${locale}">`
  })

  const injection = `<script>window.__LOCALE__=${JSON.stringify(locale)};window.__I18N__=${serializedDictionary};</script><script src="/static/i18n.js"></script>`
  localized = localized.replace(/<\/head>/i, () => {
    headApplied = true
    return `${injection}</head>`
  })

  if (!langApplied) console.error('[i18n] injection failed: html lang replacement')
  if (!headApplied) console.error('[i18n] injection failed: </head> injection')

  return localized
}

app.get('/login.html', (c) => c.html(localizedHtml(c, loginHtml)))
app.get('/login', (c) => c.html(localizedHtml(c, loginHtml)))
// マイページは廃止し、機能は編集画面の左バーへ移した。
// 古いブックマークやリンクを壊さないよう、編集画面へ転送する（着地先は画面側で決める）
const myPageRedirect = (c: Context) => c.redirect('/index.html', 302)
app.get('/my-page.html', myPageRedirect)
app.get('/my-page', myPageRedirect)
app.get('/accept-invitation.html', (c) => c.html(localizedHtml(c, acceptInvitationHtml)))
app.get('/accept-invitation', (c) => c.html(localizedHtml(c, acceptInvitationHtml)))
app.get('/profile.html', (c) => c.html(localizedHtml(c, profileHtml)))
app.get('/profile', (c) => c.html(localizedHtml(c, profileHtml)))
const localizedHelpHtml = (c: Context) => {
  const locale = requestLocale(c)
  return localizedHtml(c, locale === 'en' ? helpEnHtml : helpHtml, locale)
}

app.get('/help.html', (c) => c.html(localizedHelpHtml(c)))
app.get('/help', (c) => c.html(localizedHelpHtml(c)))
app.get('/terms', (c) => c.redirect('/help?tab=terms', 302))
app.get('/privacy', (c) => c.redirect('/help?tab=terms#privacy', 302))
app.get('/help.en', (c) => c.html(localizedHtml(c, helpEnHtml, 'en')))
app.get('/help.ja', (c) => c.html(localizedHtml(c, helpHtml, 'ja')))
app.get('/mermaid-viewer.html', (c) => c.html(localizedHtml(c, mermaidViewerHtml)))
app.get('/mermaid-viewer', (c) => c.html(localizedHtml(c, mermaidViewerHtml)))

// ノード本文のHTMLコードブロックを実際にレンダリングして見せるページ。
// 隔離は sandbox 属性（allow-same-origin なし = opaque origin）で担保する。CSP ではない。
//
// このルートだけ CSP を緩める理由:
//   1. グローバルCSPは frame-src 'none'（表示対象のiframeごと塞がれる）
//   2. srcdoc の子フレームは親ページのCSPを継承するため、default-src 'self' のままだと
//      ユーザーHTMLが外部CDN（Tailwind等）を一切読めず、従来のblob表示より劣化する
// 緩めても、ユーザーHTMLは opaque origin で動くので Zeeta の Cookie・API・localStorage
// には到達できない（/api/* を叩いてもクロスサイト扱いで SameSite=Lax のセッションは付かない）。
const HTML_VIEWER_CSP = [
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
  "script-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
  "style-src * data: blob: 'unsafe-inline'",
  "img-src * data: blob:",
  "font-src * data: blob:",
  "connect-src *",
  "frame-src * data: blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ')
const htmlViewerResponse = (c: Context) =>
  c.html(localizedHtml(c, htmlViewerHtml), 200, { 'Content-Security-Policy': HTML_VIEWER_CSP })
app.get('/html-viewer.html', htmlViewerResponse)
app.get('/html-viewer', htmlViewerResponse)

// ノード本文の画像を拡大表示するページ。グローバルCSPの img-src で /api の画像URLを
// 読み込めるため、mermaid-viewer と同じ扱い（CSPの個別緩和なし）。
const imageViewerResponse = (c: Context) => c.html(localizedHtml(c, imageViewerHtml))
app.get('/image-viewer.html', imageViewerResponse)
app.get('/image-viewer', imageViewerResponse)

// ===============================
// API Routes
// ===============================

// ===============================
// Authentication Routes
// ===============================

// Initiate OAuth login flow
app.get('/auth/login/:provider', (c) => {
  const provider = c.req.param('provider') as 'google' | 'github'

  if (provider !== 'google' && provider !== 'github') {
    return c.json({ success: false, error: 'Invalid provider' }, 400)
  }

  const config = getOAuthConfig(c.env)[provider]

  // Generate CSRF state token
  const state = crypto.randomUUID()

  // Store state in cookie (10 minutes expiration)
  setCookie(c, 'oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: 600,
    path: '/'
  })

  // Store redirect URL if provided (for returning after login)
  const redirectUrl = c.req.query('redirect')
  if (redirectUrl) {
    setCookie(c, 'oauth_redirect', safeSameAppRedirect(redirectUrl), {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 600,
      path: '/'
    })
  }

  // Build authorization URL
  const authUrl = new URL(config.authUrl)
  authUrl.searchParams.set('client_id', config.clientId)
  authUrl.searchParams.set('redirect_uri', config.redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', config.scope)
  authUrl.searchParams.set('state', state)

  // Redirect to OAuth provider
  return c.redirect(authUrl.toString())
})

// Handle OAuth callback
app.get('/auth/callback/:provider', async (c) => {
  try {
    const provider = c.req.param('provider') as 'google' | 'github'

    if (provider !== 'google' && provider !== 'github') {
      return c.json({ success: false, error: 'Invalid provider' }, 400)
    }

    const code = c.req.query('code')
    const state = c.req.query('state')
    const savedState = getCookie(c, 'oauth_state')

    // Validate state (CSRF protection)
    if (!state || !savedState || state !== savedState) {
      return c.json({ success: false, error: 'Invalid state parameter' }, 400)
    }

    if (!code) {
      return c.json({ success: false, error: 'No authorization code provided' }, 400)
    }

    const config = getOAuthConfig(c.env)[provider]

    // Exchange code for access token
    const tokenResponse = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code'
      })
    })

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text()
      console.error('Token exchange failed:', errorText)
      return c.json({ success: false, error: 'Failed to exchange authorization code' }, 500)
    }

    const tokenData = await tokenResponse.json() as any
    const accessToken = tokenData.access_token

    if (!accessToken) {
      return c.json({ success: false, error: 'No access token received' }, 500)
    }

    // Fetch user info from OAuth provider
    const userResponse = await fetch(config.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    })

    if (!userResponse.ok) {
      return c.json({ success: false, error: 'Failed to fetch user information' }, 500)
    }

    const userInfo = await userResponse.json() as any

    // Normalize user info based on provider
    let oauthUser: OAuthUserInfo
    if (provider === 'google') {
      oauthUser = normalizeGoogleUser(userInfo)
      if (!oauthUser) {
        return c.json({ success: false, error: 'Google email address is not verified' }, 400)
      }
    } else {
      oauthUser = normalizeGitHubUser(userInfo)
    }

    // GitHub は公開メール未設定だと /user の email が null になる（そのまま upsert すると
    // email NOT NULL 制約違反でログインが500になっていた）。user:email スコープで
    // /user/emails から primary アドレスを補完する。
    if (provider === 'github' && !oauthUser.email) {
      const emailsResponse = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json'
        }
      })
      if (emailsResponse.ok) {
        const resolvedEmail = pickPrimaryGithubEmail(await emailsResponse.json())
        if (resolvedEmail) {
          oauthUser = { ...oauthUser, email: resolvedEmail }
        }
      }
      if (!oauthUser.email) {
        return c.json({
          success: false,
          error: 'Email address could not be obtained from GitHub. Please set a primary email in your GitHub account settings.'
        }, 400)
      }
    }

    // Create or update user in database
    const user = await upsertOAuthUser(c.env.DB, oauthUser)

    // Generate JWT
    const sessionId = crypto.randomUUID()
    const token = await generateJWT(
      {
        id: user.id,
        email: user.email,
        display_name: user.display_name || '',
        avatar_url: user.avatar_url || undefined,
        oauth_provider: user.oauth_provider
      },
      c.env.JWT_SECRET,
      7 * 24 * 60 * 60,
      sessionId
    )

    // Create session record (③要件: セッション期限を 7 日に短縮)
    await createSession(c.env.DB, user.id, token, 7 * 24 * 60 * 60, sessionId)

    // Set session cookie
    setCookie(c, 'session', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 7 * 24 * 60 * 60,
      path: '/'
    })

    // Get redirect URL if stored (for invitation flow etc.)
    const redirectUrl = getCookie(c, 'oauth_redirect')

    // Clear OAuth cookies
    setCookie(c, 'oauth_state', '', {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 0,
      path: '/'
    })
    setCookie(c, 'oauth_redirect', '', {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 0,
      path: '/'
    })

    // Redirect to stored URL or My Page
    return c.redirect(safeSameAppRedirect(redirectUrl))
  } catch (error) {
    console.error('OAuth callback error:', error)
    // Include error details for debugging (remove in production later)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: 'Authentication failed' }, 500)
  }
})

// Logout
app.post('/auth/logout', async (c) => {
  const token = getCookie(c, 'session')
  let userId: number | null = null

  if (token) {
    const payload = await verifyJWT(token, c.env.JWT_SECRET)
    const session = payload?.session_id
      ? await c.env.DB.prepare('SELECT user_id FROM sessions WHERE id = ?').bind(payload.session_id).first<{ user_id: number }>()
      : await c.env.DB.prepare('SELECT user_id FROM sessions WHERE token = ?').bind(token).first<{ user_id: number }>()
    userId = session?.user_id ?? null
    if (payload?.session_id) {
      await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(payload.session_id).run()
    } else {
      await deleteSession(c.env.DB, token)
    }
  }

  // Clear session cookie
  c.header('Set-Cookie', 'session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/')

  logAuditFromContext(c, { userId, action: 'auth.logout', targetType: 'user', targetId: userId ?? undefined })

  return c.json({ success: true })
})

// Get current user info
app.get('/auth/me', authMiddleware, async (c) => {
  try {
    const jwtUser = getCurrentUser(c)

    // Fetch latest user data from database
    const user = await c.env.DB
      .prepare('SELECT id, email, display_name, avatar_url, oauth_provider FROM users WHERE id = ?')
      .bind(jwtUser.user_id)
      .first()

    if (!user) {
      return c.json({ success: false, error: 'User not found' }, 404)
    }

    return c.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        oauth_provider: user.oauth_provider
      }
    })
  } catch (error) {
    console.error('Failed to get current user:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ============================================
// System APIs
// ============================================

// 現在のデプロイのビルド日時（MMDD-HHMM）を返す。
// クライアント（version-check.js）がタブ再アクティブ時に自身のビルド日時と比較し、
// 不一致ならリロード確認を出すために使う。返すのはビルド日時のみなので認証は付けない。
// バッジ表示には使わない（バッジはサーバ側で直埋め。/api/version をロード時に
// 叩る往復は f605ee7 で廃止済みのため復活させない）
app.get('/api/version', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({ build: __BUILD_STAMP__ })
})

// ============================================
// Profile Management APIs
// ============================================

// Get relation types master
app.get('/api/relation-types', authMiddleware, async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, description, icon_type, is_system
       FROM relation_types
       ORDER BY id ASC`
    ).all()

    return c.json({ success: true, data: results })
  } catch (error) {
    console.error('Failed to get relation types:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// API key management for MCP integration
/**
 * MCP POST リクエストの共通レスポンス処理。
 * `/api/mcp/trees/:tree_id`（OAuth方式）で使う。
 */
async function respondMcpPost(c: any, principal: McpPrincipal, body: any, era: McpProtocolEra) {
  // Legacy revisions supported batch messages. The modern revision requires one POST per message.
  if (Array.isArray(body)) {
    const results: Record<string, unknown>[] = []
    for (const message of body) {
      const payload = await handleMcpRpc(c.env.DB, principal, message, safeExecutionCtx(c), c.env)
      if (payload) {
        results.push(payload)
      }
    }
    return c.json(results, 200, {
      'mcp-protocol-version': MCP_LEGACY_PROTOCOL_VERSION
    })
  }

  const rawResponsePayload = await handleMcpRpc(c.env.DB, principal, body, safeExecutionCtx(c), c.env, era)
  const responsePayload = finalizeMcpRpcResponse(rawResponsePayload, era, String(body?.method || ''))
  if (!responsePayload) {
    return c.body(null, 202, {
      'mcp-protocol-version': era === 'modern' ? MCP_MODERN_PROTOCOL_VERSION : MCP_LEGACY_PROTOCOL_VERSION
    })
  }

  if (era === 'modern') {
    const status = (responsePayload as any)?.error?.code === -32601 ? 404 : 200
    return c.json(responsePayload, status, {
      'mcp-protocol-version': MCP_MODERN_PROTOCOL_VERSION,
    })
  }

  // Legacy Streamable HTTP clients expect a protocol-level session id.
  const sessionId = c.req.header('mcp-session-id') || crypto.randomUUID()
  return c.json(responsePayload, 200, {
    'mcp-protocol-version': MCP_LEGACY_PROTOCOL_VERSION,
    'mcp-session-id': sessionId
  })
}

// ============================================
// MCP OAuth (OAuth 2.1 Authorization Server / Resource Server)
// ============================================

// 既存のMCP toolレート制限と同様、isolate内のbest-effort制限（IP単位）。
// 社内NAT等で複数ユーザーが同一IPになるケースを踏まえ、悪用抑止に足る範囲で余裕を持たせる。
const MCP_OAUTH_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
const MCP_OAUTH_REGISTER_LIMIT_PER_WINDOW = 100
const MCP_OAUTH_TOKEN_LIMIT_PER_WINDOW = 600
const mcpOAuthRateLimits = new Map<string, { windowStartedAt: number; count: number }>()

function consumeMcpOAuthRateLimit(key: string, limit: number): boolean {
  const now = Date.now()
  const current = mcpOAuthRateLimits.get(key)
  if (!current || now - current.windowStartedAt >= MCP_OAUTH_RATE_LIMIT_WINDOW_MS) {
    mcpOAuthRateLimits.set(key, { windowStartedAt: now, count: 1 })
    return true
  }
  if (current.count >= limit) {
    return false
  }
  current.count += 1
  return true
}

function oauthRequestOrigin(c: any): string {
  return new URL(c.req.url).origin
}

/**
 * Hono の `c.executionCtx` は ExecutionContext を持たない環境で例外を投げるため、
 * 取得を安全にラップする。
 */
function safeExecutionCtx(c: any): ExecutionCtxLike | undefined {
  try {
    return c.executionCtx
  } catch {
    return undefined
  }
}

function oauthClientIpKey(c: any): string {
  return c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown'
}

function isSameOriginRequest(c: any): boolean {
  const origin = c.req.header('origin')
  // MCPクライアント等 Origin を送らないケースは許容し、クロスオリジンの明示指定だけ拒否する
  if (!origin) return true
  return origin === oauthRequestOrigin(c)
}

async function getOAuthSessionUser(c: any): Promise<JWTPayload | null> {
  const token = getCookie(c, 'session')
  if (!token) return null
  const secret = c.env.JWT_SECRET
  if (!secret) return null
  const payload = await verifyJWT(token, secret)
  if (!payload) return null
  const activeSession = await findActiveSession(c.env.DB, token, payload)
  return activeSession ? payload : null
}

function buildOAuthRedirect(
  redirectUri: string,
  origin: string,
  params: Record<string, string | null | undefined>,
): string {
  const url = new URL(redirectUri)
  url.searchParams.set('iss', origin)
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      url.searchParams.set(key, value)
    }
  }
  return url.toString()
}

/**
 * 同意画面用CSP。form-action に redirect_uri のオリジンを含める必要がある
 * （フォーム送信直後のリダイレクト先をブラウザがブロックしないようにする）。
 */
function buildConsentCsp(redirectUri: string): string {
  let redirectOrigin = ''
  try {
    redirectOrigin = new URL(redirectUri).origin
  } catch {
    redirectOrigin = ''
  }
  return [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "script-src 'self'",
    `form-action 'self'${redirectOrigin ? ` ${redirectOrigin}` : ''}`,
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ')
}

const OAUTH_PUBLIC_CORS = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'MCP-Protocol-Version'],
  maxAge: 3600,
})

// 認可サーバー/リソースサーバーのメタデータとトークン系エンドポイントは
// Cookie を伴わない public エンドポイントなので、任意オリジンからの取得を許可する
app.use('/.well-known/*', OAUTH_PUBLIC_CORS)
app.use('/oauth/register', OAUTH_PUBLIC_CORS)
app.use('/oauth/token', OAUTH_PUBLIC_CORS)
app.use('/oauth/revoke', OAUTH_PUBLIC_CORS)

// --- Protected Resource Metadata (RFC 9728) ---
// ツリーの存在を漏らさないため、正の整数であればDBを引かずに文書を返す
app.get(`/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH_PREFIX}:tree_id`, (c) => {
  const treeIdRaw = c.req.param('tree_id')
  if (!/^[1-9][0-9]{0,17}$/.test(treeIdRaw)) {
    return c.json({ error: 'not_found' }, 404)
  }
  return c.json(buildProtectedResourceMetadata(oauthRequestOrigin(c), Number(treeIdRaw)), 200, {
    'Cache-Control': 'public, max-age=3600',
  })
})

// --- Authorization Server Metadata (RFC 8414) ---
app.get('/.well-known/oauth-authorization-server', (c) => {
  return c.json(buildAuthorizationServerMetadata(oauthRequestOrigin(c)), 200, {
    'Cache-Control': 'public, max-age=3600',
  })
})

// パス挿入型（`/.well-known/oauth-authorization-server/api/mcp/trees/1`）で問い合わせる
// クライアントにも同じ文書を返す（issuer はオリジン直下で固定）
app.get('/.well-known/oauth-authorization-server/*', (c) => {
  return c.json(buildAuthorizationServerMetadata(oauthRequestOrigin(c)), 200, {
    'Cache-Control': 'public, max-age=3600',
  })
})

// --- Dynamic Client Registration (RFC 7591) ---
app.post('/oauth/register', async (c) => {
  if (!consumeMcpOAuthRateLimit(`register:${oauthClientIpKey(c)}`, MCP_OAUTH_REGISTER_LIMIT_PER_WINDOW)) {
    return c.json({ error: 'too_many_requests', error_description: 'client registration rate limit exceeded' }, 429)
  }

  let body: any
  try {
    const rawBody = await c.req.raw.text()
    if (new TextEncoder().encode(rawBody).byteLength > MCP_OAUTH_REGISTER_MAX_BODY_BYTES) {
      return c.json({ error: 'request_entity_too_large', error_description: 'request body exceeds 16KB' }, 413)
    }
    body = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'invalid_client_metadata', error_description: 'request body must be JSON' }, 400)
  }

  const result = await registerOAuthClient(c.env.DB, {
    clientName: body?.client_name,
    clientUri: body?.client_uri,
    redirectUris: body?.redirect_uris,
    grantTypes: body?.grant_types,
    responseTypes: body?.response_types,
    tokenEndpointAuthMethod: body?.token_endpoint_auth_method,
    scope: body?.scope,
  })

  if (!result.ok) {
    const status = result.error === 'server_error' ? 500 : 400
    return c.json({ error: result.error, error_description: result.description }, status)
  }

  logAuditFromContext(c, {
    userId: null,
    action: 'mcp_oauth.client_register',
    targetType: 'user',
  })

  // RFC 7591 の任意メタデータは値が無いとき `null` を返さず**キーごと省略**する。
  // Claude Code の MCP SDK は登録レスポンスを Zod で検証し、client_uri / client_name を
  // `string` として扱うため、`null` を返すと認可フロー開始前に
  // 「Invalid input: expected string, received null」で失敗する（stageで検出、TC-MCP-OAUTH-002）。
  const registration: Record<string, unknown> = {
    client_id: result.client.client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: result.redirectUris,
    grant_types: clientGrantTypes(result.client),
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: result.client.scope || MCP_OAUTH_SUPPORTED_SCOPES.join(' '),
  }
  if (result.client.client_name) registration.client_name = result.client.client_name
  if (result.client.client_uri) registration.client_uri = result.client.client_uri

  return c.json(registration, 201, { 'Cache-Control': 'no-store' })
})

// --- Authorization Endpoint ---
app.get('/oauth/authorize', async (c) => {
  const origin = oauthRequestOrigin(c)
  const locale = resolveLocaleFromRequest(getCookie(c, 'lang'), c.req.header('accept-language'))
  const clientId = c.req.query('client_id') || ''
  const client = clientId ? await getOAuthClient(c.env.DB, clientId) : null

  // client_id / redirect_uri が確定できない場合はリダイレクトせず画面でエラーを示す
  if (!client) {
    return c.html(renderOAuthErrorPage({
      titleKey: 'oauthError.clientInvalidTitle',
      messageKey: 'oauthError.clientInvalidMessage',
    }, locale), 400)
  }

  const registeredUris = clientRedirectUris(client)
  const redirectUriRaw = c.req.query('redirect_uri')
  const redirectUri = redirectUriRaw !== undefined
    ? redirectUriRaw
    : (registeredUris.length === 1 ? registeredUris[0] : '')

  if (!redirectUri || !registeredUris.includes(redirectUri)) {
    return c.html(renderOAuthErrorPage({
      titleKey: 'oauthError.redirectInvalidTitle',
      messageKey: 'oauthError.redirectInvalidMessage',
      detailKey: 'oauthError.redirectInvalidDetail',
    }, locale), 400)
  }

  const state = c.req.query('state') ?? null
  const user = await getOAuthSessionUser(c)
  // 同意画面に到達する前のエラーは、ログイン有無にかかわらずクライアントへリダイレクトしない。
  // 未検証の第三者が登録した redirect_uri への踏み台（open redirect）にさせないため（RFC 6749 4.1.2.1 の redirect は任意）。
  const failToClient = (_error: string, _description: string) =>
    c.html(renderOAuthErrorPage({
      titleKey: 'oauthError.requestInvalidTitle',
      messageKey: 'oauthError.requestInvalidMessage',
    }, locale), 400)

  if (c.req.query('response_type') !== 'code') {
    return failToClient('unsupported_response_type', 'response_type must be code')
  }
  if (!clientGrantTypes(client).includes('authorization_code')) {
    return failToClient('unauthorized_client', 'client is not allowed to use the authorization_code grant')
  }

  const codeChallenge = c.req.query('code_challenge') || ''
  const codeChallengeMethod = c.req.query('code_challenge_method') || ''
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    return failToClient('invalid_request', 'code_challenge with code_challenge_method=S256 is required')
  }

  const resourceRaw = c.req.query('resource') || ''
  if (!resourceRaw) {
    return failToClient('invalid_target', 'resource parameter is required (tree-scoped MCP URL)')
  }
  const treeId = parseTreeIdFromResource(resourceRaw, origin)
  if (!treeId) {
    return failToClient('invalid_target', 'resource must be a tree-scoped MCP URL on this server')
  }
  const tree = await getActiveTree(c.env.DB, treeId)
  if (!tree) {
    return failToClient('invalid_target', 'tree not found')
  }

  const requestedScope = parseScopeParam(c.req.query('scope'))
  if (requestedScope === null) {
    return failToClient('invalid_scope', `scope must be a subset of: ${MCP_OAUTH_SUPPORTED_SCOPES.join(' ')}`)
  }

  if (!user) {
    const requestUrl = new URL(c.req.url)
    const target = `${requestUrl.pathname}${requestUrl.search}`
    return c.redirect(`/login?redirect=${encodeURIComponent(target)}`, 302)
  }

  const role = await getUserRole(c.env.DB, treeId, user.user_id)
  if (!role) {
    return c.html(renderOAuthErrorPage({
      titleKey: 'oauthError.requestInvalidTitle',
      messageKey: 'oauthError.requestInvalidMessage',
    }, locale), 400)
  }

  const scope = grantedScopeForRole(requestedScope, role)
  const requestId = await createAuthorizationRequest(c.env.DB, {
    clientId: client.client_id,
    userId: user.user_id,
    treeId,
    resource: buildMcpResourceUrl(origin, treeId),
    scope,
    redirectUri,
    state,
    codeChallenge,
    codeChallengeMethod,
  })

  return c.html(renderConsentPage({
    requestId,
    clientName: client.client_name,
    clientUri: client.client_uri,
    treeName: tree.name,
    role,
    scope,
    redirectUri,
    userEmail: user.email,
  }, locale), 200, {
    'Content-Security-Policy': buildConsentCsp(redirectUri),
    'Cache-Control': 'no-store',
  })
})

app.post('/oauth/authorize', async (c) => {
  if (!isSameOriginRequest(c)) {
    return c.text('Invalid Origin', 403)
  }

  const origin = oauthRequestOrigin(c)
  const locale = resolveLocaleFromRequest(getCookie(c, 'lang'), c.req.header('accept-language'))
  const form = await c.req.parseBody()
  const requestId = String(form.request_id || '')
  const decision = String(form.decision || '')

  const user = await getOAuthSessionUser(c)
  if (!user) {
    return c.html(renderOAuthErrorPage({
      titleKey: 'oauthError.loginRequiredTitle',
      messageKey: 'oauthError.loginRequiredMessage',
    }, locale), 401)
  }

  const request = await consumeAuthorizationRequest(c.env.DB, requestId)
  if (!request) {
    return c.html(renderOAuthErrorPage({
      titleKey: 'oauthError.requestInvalidTitle',
      messageKey: 'oauthError.requestInvalidMessage',
    }, locale), 400)
  }
  if (request.user_id !== user.user_id) {
    return c.html(renderOAuthErrorPage({
      titleKey: 'oauthError.accountMismatchTitle',
      messageKey: 'oauthError.accountMismatchMessage',
    }, locale), 403)
  }

  if (decision !== 'approve') {
    logAuditFromContext(c, {
      userId: user.user_id,
      action: 'mcp_oauth.deny',
      targetType: 'tree',
      targetId: request.tree_id,
      treeId: request.tree_id,
    })
    return c.redirect(buildOAuthRedirect(request.redirect_uri, origin, {
      error: 'access_denied',
      error_description: 'The user denied the authorization request',
      state: request.state,
    }), 302)
  }

  // 同意画面の表示中に role が変わっている可能性があるため再判定する
  const role = await getUserRole(c.env.DB, request.tree_id, user.user_id)
  if (!role) {
    return c.redirect(buildOAuthRedirect(request.redirect_uri, origin, {
      error: 'access_denied',
      error_description: 'You are not a member of the requested tree',
      state: request.state,
    }), 302)
  }

  const scope = grantedScopeForRole(parseScopeParam(request.scope) ?? undefined, role)
  const code = await issueAuthorizationCode(c.env.DB, {
    clientId: request.client_id,
    userId: user.user_id,
    treeId: request.tree_id,
    resource: request.resource,
    scope,
    redirectUri: request.redirect_uri,
    codeChallenge: request.code_challenge,
    codeChallengeMethod: request.code_challenge_method,
  })

  logAuditFromContext(c, {
    userId: user.user_id,
    action: 'mcp_oauth.authorize',
    targetType: 'tree',
    targetId: request.tree_id,
    treeId: request.tree_id,
  })

  return c.redirect(buildOAuthRedirect(request.redirect_uri, origin, {
    code,
    state: request.state,
  }), 302)
})

// --- Token Endpoint ---
app.post('/oauth/token', async (c) => {
  const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' }

  /**
   * エラー応答を返す全経路の監査ログ（mcp_oauth.token_error）を内蔵するヘルパー。
   * target_id には `<OAuth error>:<理由コード>` を格納し、code/refresh 行を
   * 引けた時点の user_id / tree_id を known で渡す。
   */
  const tokenError = (
    status: 400 | 401 | 429,
    error: string,
    description: string,
    reason: string,
    known?: { userId?: number | null; treeId?: number | null },
  ) => {
    logAuditFromContext(c, {
      userId: known?.userId ?? null,
      action: 'mcp_oauth.token_error',
      targetType: 'oauth_client',
      targetId: `${error}:${reason}`,
      treeId: known?.treeId ?? undefined,
    })
    return c.json({ error, error_description: description }, status, noStore)
  }

  if (!consumeMcpOAuthRateLimit(`token:${oauthClientIpKey(c)}`, MCP_OAUTH_TOKEN_LIMIT_PER_WINDOW)) {
    return tokenError(429, 'temporarily_unavailable', 'token endpoint rate limit exceeded', 'rate_limited')
  }

  const origin = oauthRequestOrigin(c)
  let form: Record<string, any>
  try {
    form = await c.req.parseBody()
  } catch {
    return tokenError(400, 'invalid_request', 'request body must be application/x-www-form-urlencoded', 'body_parse_failed')
  }

  const grantType = String(form.grant_type || '')
  const clientId = String(form.client_id || '')
  if (!clientId) {
    return tokenError(401, 'invalid_client', 'client_id is required', 'client_id_missing')
  }
  const client = await getOAuthClient(c.env.DB, clientId)
  if (!client) {
    return tokenError(401, 'invalid_client', 'unknown client_id', 'client_id_unknown')
  }
  if (form.client_secret !== undefined) {
    return tokenError(401, 'invalid_client', 'client authentication is not supported (public clients only)', 'client_secret_unsupported')
  }

  const resourceParam = form.resource === undefined ? '' : String(form.resource)

  if (grantType === 'authorization_code') {
    const code = String(form.code || '')
    const codeVerifier = String(form.code_verifier || '')
    const redirectUri = String(form.redirect_uri || '')
    if (!code || !codeVerifier || !redirectUri) {
      return tokenError(400, 'invalid_request', 'code, code_verifier and redirect_uri are required', 'missing_params')
    }

    const codeRow = await consumeAuthorizationCode(c.env.DB, code)
    if (!codeRow) {
      return tokenError(400, 'invalid_grant', 'authorization code is invalid, expired or already used', 'code_invalid')
    }
    const codeKnown = { userId: codeRow.user_id, treeId: codeRow.tree_id }
    if (codeRow.client_id !== clientId) {
      return tokenError(400, 'invalid_grant', 'authorization code was issued to another client', 'code_client_mismatch', codeKnown)
    }
    if (codeRow.redirect_uri !== redirectUri) {
      return tokenError(400, 'invalid_grant', 'redirect_uri does not match the authorization request', 'code_redirect_mismatch', codeKnown)
    }
    if (resourceParam && parseTreeIdFromResource(resourceParam, origin) !== codeRow.tree_id) {
      return tokenError(400, 'invalid_target', 'resource does not match the authorization request', 'code_resource_mismatch', codeKnown)
    }
    if (!(await verifyPkceS256(codeVerifier, codeRow.code_challenge))) {
      return tokenError(400, 'invalid_grant', 'PKCE verification failed', 'pkce_failed', codeKnown)
    }

    const role = await getUserRole(c.env.DB, codeRow.tree_id, codeRow.user_id)
    if (!role) {
      return tokenError(400, 'invalid_grant', 'tree membership is required', 'membership_lost', codeKnown)
    }

    const scope = grantedScopeForRole(parseScopeParam(codeRow.scope) ?? undefined, role)
    const issued = await issueTokenPair(c.env.DB, {
      clientId,
      userId: codeRow.user_id,
      treeId: codeRow.tree_id,
      resource: codeRow.resource,
      scope,
    })

    logAuditFromContext(c, {
      userId: codeRow.user_id,
      action: 'mcp_oauth.token_issue',
      targetType: 'tree',
      targetId: codeRow.tree_id,
      treeId: codeRow.tree_id,
    })

    return c.json({
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: issued.expiresIn,
      refresh_token: issued.refreshToken,
      scope: issued.scope,
    }, 200, noStore)
  }

  if (grantType === 'refresh_token') {
    const refreshToken = String(form.refresh_token || '')
    if (!refreshToken) {
      return tokenError(400, 'invalid_request', 'refresh_token is required', 'missing_params')
    }

    const refreshRow = await findTokenRow(c.env.DB, refreshToken, 'refresh')
    if (!refreshRow || refreshRow.client_id !== clientId) {
      return tokenError(400, 'invalid_grant', 'refresh token is invalid', 'refresh_invalid')
    }
    const refreshKnown = { userId: refreshRow.user_id, treeId: refreshRow.tree_id }

    // 失効済み refresh の提示。rotation chain がまだ生きていればリトライとして扱う。
    let isReplay = false
    if (refreshRow.revoked_at) {
      const familyAlive = await isRefreshFamilyAlive(c.env.DB, refreshRow.id)
      if (!familyAlive) {
        // family 全体が死んでいる（明示 revoke / メンバー解除）。追加の失効はしない
        logAuditFromContext(c, {
          userId: refreshRow.user_id,
          action: 'mcp_oauth.token_reuse_detected',
          targetType: 'tree',
          targetId: refreshRow.tree_id,
          treeId: refreshRow.tree_id,
        })
        return tokenError(400, 'invalid_grant', 'refresh token is revoked', 'refresh_revoked', refreshKnown)
      }
      isReplay = true
    }
    if (refreshRow.expires_at <= toSqlDatetime(new Date())) {
      return tokenError(400, 'invalid_grant', 'refresh token is expired', 'refresh_expired', refreshKnown)
    }
    if (resourceParam && parseTreeIdFromResource(resourceParam, origin) !== refreshRow.tree_id) {
      return tokenError(400, 'invalid_target', 'resource does not match the refresh token', 'refresh_resource_mismatch', refreshKnown)
    }

    const requestedScope = parseScopeParam(form.scope === undefined ? undefined : String(form.scope))
    if (requestedScope === null) {
      return tokenError(400, 'invalid_scope', `scope must be a subset of: ${MCP_OAUTH_SUPPORTED_SCOPES.join(' ')}`, 'scope_invalid', refreshKnown)
    }
    if (requestedScope && requestedScope.some((item) => !scopeIncludes(refreshRow.scope, item))) {
      return tokenError(400, 'invalid_scope', 'requested scope exceeds the scope of the refresh token', 'scope_exceeds', refreshKnown)
    }

    const role = await getUserRole(c.env.DB, refreshRow.tree_id, refreshRow.user_id)
    if (!role) {
      await revokeTokensForUserTree(c.env.DB, { userId: refreshRow.user_id, treeId: refreshRow.tree_id })
      return tokenError(400, 'invalid_grant', 'tree membership is required', 'membership_lost', refreshKnown)
    }

    const baseScope = requestedScope ?? (parseScopeParam(refreshRow.scope) ?? undefined)
    const scope = grantedScopeForRole(baseScope, role)

    // 旧refreshの失効・新token対の発行・古い生存者のprune を1つのDBトランザクションで行う。
    // 逐次awaitに分けると、途中の例外で「旧だけ失効・新が未発行」の復旧不能な状態が生じうる
    const issued = await rotateRefreshToken(c.env.DB, {
      oldRefreshTokenId: refreshRow.id,
      rotationRootId: refreshRow.rotation_root_id ?? refreshRow.id,
      clientId,
      userId: refreshRow.user_id,
      treeId: refreshRow.tree_id,
      resource: refreshRow.resource,
      scope,
    })

    logAuditFromContext(c, {
      userId: refreshRow.user_id,
      action: isReplay ? 'mcp_oauth.token_refresh_replay' : 'mcp_oauth.token_refresh',
      targetType: 'tree',
      targetId: refreshRow.tree_id,
      treeId: refreshRow.tree_id,
    })

    return c.json({
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: issued.expiresIn,
      refresh_token: issued.refreshToken,
      scope: issued.scope,
    }, 200, noStore)
  }

  return tokenError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token', 'unsupported_grant_type')
})

// --- Revocation Endpoint (RFC 7009) ---
app.post('/oauth/revoke', async (c) => {
  let form: Record<string, any>
  try {
    form = await c.req.parseBody()
  } catch {
    return c.json({ error: 'invalid_request' }, 400, { 'Cache-Control': 'no-store' })
  }

  const token = String(form.token || '')
  const clientId = form.client_id === undefined ? null : String(form.client_id)
  if (!token) {
    return c.json({ error: 'invalid_request', error_description: 'token is required' }, 400, { 'Cache-Control': 'no-store' })
  }

  const refreshRow = await findTokenRow(c.env.DB, token, 'refresh')
  if (refreshRow && (!clientId || refreshRow.client_id === clientId)) {
    // refresh を失効させる場合は派生 access token も同時に失効させる
    await revokeRefreshTokenFamily(c.env.DB, refreshRow.id)
    logAuditFromContext(c, {
      userId: refreshRow.user_id,
      action: 'mcp_oauth.token_revoke',
      targetType: 'tree',
      targetId: refreshRow.tree_id,
      treeId: refreshRow.tree_id,
    })
  } else {
    await revokeTokenByValue(c.env.DB, token, clientId)
  }

  // RFC 7009: 未知トークンでも 200 を返す
  return c.body(null, 200, { 'Cache-Control': 'no-store' })
})

// ============================================
// MCP resource endpoint (tree-scoped, OAuth)
// ============================================

type McpTreeAuthResult =
  | { ok: true; principal: McpPrincipal; scope: string; credentialType: 'oauth' }
  | { ok: false; status: 401 | 403; error: string; description: string; challenge?: string }

async function resolveMcpTreePrincipal(c: any, treeId: number): Promise<McpTreeAuthResult> {
  const origin = oauthRequestOrigin(c)
  const authHeader = c.req.header('Authorization') || ''
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''

  const challenge = (error?: 'invalid_token' | 'insufficient_scope' | 'invalid_request', description?: string, scope?: string) =>
    buildWwwAuthenticateHeader({ origin, treeId, error, errorDescription: description, scope })

  /**
   * 認証失敗（401/403）を mcp_oauth.request_unauthorized として監査ログに残してから
   * 失敗結果を返す。「サーバが拒否した」か「リクエストが届いていない」かの切り分け用。
   * membership_revoked の経路のみ既存の専用 action で記録済みのため二重記録しない。
   */
  const failWithLog = (
    reason: string,
    result: Extract<McpTreeAuthResult, { ok: false }>,
    userId?: number | null,
  ): McpTreeAuthResult => {
    logAuditFromContext(c, {
      userId: userId ?? null,
      action: 'mcp_oauth.request_unauthorized',
      targetType: 'tree',
      targetId: reason,
      treeId,
    })
    return result
  }

  if (!bearer) {
    return failWithLog('no_bearer', {
      ok: false,
      status: 401,
      error: 'unauthorized',
      description: 'Authorization: Bearer <token> is required',
      challenge: challenge(),
    })
  }

  const tree = await getActiveTree(c.env.DB, treeId)
  if (!tree) {
    return failWithLog('tree_not_found', {
      ok: false,
      status: 401,
      error: 'invalid_token',
      description: 'tree not found',
      challenge: challenge('invalid_token', 'tree not found'),
    })
  }

  const tokenRow = await findTokenRow(c.env.DB, bearer, 'access')
  if (!isTokenRowUsable(tokenRow) || !tokenRow) {
    return failWithLog('access_token_invalid', {
      ok: false,
      status: 401,
      error: 'invalid_token',
      description: 'access token is invalid, expired or revoked',
      challenge: challenge('invalid_token', 'access token is invalid, expired or revoked'),
    }, tokenRow?.user_id ?? null)
  }

  // audience/resource binding: token は1ツリーのMCP URLへ完全一致で束縛される
  if (tokenRow.tree_id !== treeId || tokenRow.resource !== buildMcpResourceUrl(origin, treeId)) {
    return failWithLog('token_resource_mismatch', {
      ok: false,
      status: 403,
      error: 'invalid_token',
      description: 'access token is not bound to this resource',
      challenge: challenge('invalid_token', 'access token is not bound to this resource'),
    }, tokenRow.user_id)
  }

  // 現在のツリー権限を毎リクエストで再確認する（メンバー解除は即時反映）
  const role = await getUserRole(c.env.DB, treeId, tokenRow.user_id)
  if (!role) {
    await revokeTokensForUserTree(c.env.DB, { userId: tokenRow.user_id, treeId })
    logAuditFromContext(c, {
      userId: tokenRow.user_id,
      action: 'mcp_oauth.membership_revoked',
      targetType: 'tree',
      targetId: treeId,
      treeId,
    })
    return {
      ok: false,
      status: 401,
      error: 'invalid_token',
      description: 'tree membership was revoked; the token has been invalidated',
      challenge: challenge('invalid_token', 'tree membership was revoked'),
    }
  }

  const promise = touchAccessToken(c.env.DB, tokenRow.id).catch(() => {})
  const executionCtx = safeExecutionCtx(c)
  if (executionCtx?.waitUntil) {
    executionCtx.waitUntil(promise)
  } else {
    void promise
  }

  // 実効scope = token の scope ∩ 現在の role で許容される scope
  // （editor→viewer に降格された場合は書き込みが即時に外れる）
  const effectiveScope = grantedScopeForRole(parseScopeParam(tokenRow.scope) ?? undefined, role)

  return {
    ok: true,
    principal: {
      user_id: tokenRow.user_id,
      root_node_id: tree.root_node_id,
      permission_preset: permissionPresetForOAuth(effectiveScope, role),
      credential_type: 'oauth',
      rate_limit_key: `oauth:${tokenRow.id}`,
      client_id: tokenRow.client_id,
    },
    scope: effectiveScope,
    credentialType: 'oauth',
  }
}

function parseMcpTreeIdParam(value: string): number | null {
  if (!/^[1-9][0-9]{0,17}$/.test(value)) return null
  return Number(value)
}

app.get(`${MCP_RESOURCE_PATH_PREFIX}:tree_id`, (c) => {
  if (!isSameOriginRequest(c)) {
    return c.json(makeMcpProtocolError(null, -32600, 'Invalid Origin'), 403)
  }
  return c.text('Method Not Allowed', 405, { Allow: 'POST' })
})

app.delete(`${MCP_RESOURCE_PATH_PREFIX}:tree_id`, (c) => {
  if (!isSameOriginRequest(c)) {
    return c.json(makeMcpProtocolError(null, -32600, 'Invalid Origin'), 403)
  }
  return c.text('Method Not Allowed', 405, { Allow: 'POST' })
})

app.post(`${MCP_RESOURCE_PATH_PREFIX}:tree_id`, async (c) => {
  if (!isSameOriginRequest(c)) {
    return c.json(makeMcpProtocolError(null, -32600, 'Invalid Origin'), 403)
  }

  const treeId = parseMcpTreeIdParam(c.req.param('tree_id'))
  if (!treeId) {
    return c.json(makeMcpProtocolError(null, -32602, 'Invalid params: tree_id'), 404)
  }

  if (requestBodyExceedsLimit(c.req.header('content-length'), MCP_JSON_MAX_BYTES)) {
    return c.json({ success: false, error: 'Request body too large' }, 413)
  }

  let body: any
  try {
    const rawBody = await c.req.text()
    if (new TextEncoder().encode(rawBody).byteLength > MCP_JSON_MAX_BYTES) {
      return c.json({ success: false, error: 'Request body too large' }, 413)
    }
    body = JSON.parse(rawBody)
  } catch {
    const requestIdFallback = crypto.randomUUID()
    const { makeRpcError } = createMcpResponseHelpers(requestIdFallback)
    return c.json(makeRpcError(requestIdFallback, -32700, 'Parse error'), 400, {
      'mcp-protocol-version': c.req.header('mcp-protocol-version') || MCP_LEGACY_PROTOCOL_VERSION,
    })
  }

  const validation = validateModernMcpHttpRequest(c, body)
  if (validation.error) {
    return c.json(validation.error, validation.status || 400, {
      'mcp-protocol-version': MCP_MODERN_PROTOCOL_VERSION,
    })
  }

  const auth = await resolveMcpTreePrincipal(c, treeId)
  if (!auth.ok) {
    return c.json({ success: false, error: auth.error, error_description: auth.description }, auth.status, {
      ...(auth.challenge ? { 'WWW-Authenticate': auth.challenge } : {}),
    })
  }

  // 書き込みツールは mcp:write を必須にする（scope不足は 403 insufficient_scope）
  if (!Array.isArray(body) && body?.method === 'tools/call') {
    const toolDefinition = findMcpToolDefinition(String(body?.params?.name || ''))
    if (
      toolDefinition?.accessLevel === 'write'
      && !scopeIncludes(auth.scope, MCP_OAUTH_SCOPE_WRITE)
    ) {
      return c.json({
        success: false,
        error: 'insufficient_scope',
        error_description: `tool ${toolDefinition.name} requires the ${MCP_OAUTH_SCOPE_WRITE} scope`,
      }, 403, {
        'WWW-Authenticate': buildWwwAuthenticateHeader({
          origin: oauthRequestOrigin(c),
          treeId,
          error: 'insufficient_scope',
          errorDescription: `the ${MCP_OAUTH_SCOPE_WRITE} scope is required`,
          scope: MCP_OAUTH_SCOPE_WRITE,
        }),
      })
    }
  }

  return respondMcpPost(c, auth.principal, body, validation.era)
})

// Get user profile
app.get('/api/profile', authMiddleware, async (c) => {
  try {
    const jwtUser = getCurrentUser(c)

    // Fetch latest user data from database
    const user = await c.env.DB
      .prepare('SELECT id, email, display_name, avatar_url, oauth_provider FROM users WHERE id = ?')
      .bind(jwtUser.user_id)
      .first()

    if (!user) {
      return c.json({ success: false, error: 'User not found' }, 404)
    }

    logAuditFromContext(c, { userId: user?.id ?? null, action: 'read.profile', targetType: 'user', targetId: user.id })
    return c.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        oauth_provider: user.oauth_provider
      }
    })
  } catch (error) {
    console.error('Failed to get profile:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Update user profile
app.put('/api/profile', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const body = await c.req.json()
    const { display_name } = body

    // Validate display_name
    if (display_name !== undefined) {
      if (typeof display_name !== 'string') {
        return c.json({ success: false, error: 'Display name must be a string' }, 400)
      }
      if (display_name.trim().length === 0) {
        return c.json({ success: false, error: 'Display name cannot be empty' }, 400)
      }
      if (display_name.length > 100) {
        return c.json({ success: false, error: 'Display name must be 100 characters or less' }, 400)
      }
    }

    // Update display_name（未指定なら COALESCE で現在値を維持。従来は undefined.trim() で500になっていた）
    const updatedUser = await c.env.DB
      .prepare(`
        UPDATE users
        SET display_name = COALESCE(?, display_name), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        RETURNING id, email, display_name, avatar_url, oauth_provider
      `)
      .bind(display_name === undefined ? null : display_name.trim(), user.user_id)
      .first()

    if (!updatedUser) {
      return c.json({ success: false, error: 'Failed to update profile' }, 500)
    }

    logAuditFromContext(c, { userId: user?.user_id ?? null, action: 'profile.update', targetType: 'user', targetId: user.user_id })

    return c.json({
      success: true,
      data: updatedUser
    })
  } catch (error) {
    console.error('Failed to update profile:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ===============================
// Test-Only Endpoints (Development/Test Environment Only)
// ===============================

// 多重条件ガード: 環境変数1つの設定ミスで本番に開かないように、独立した3つの信号がすべて揃ったときだけ許可する。
// 本番で誤って APP_URL=http://localhost を設定してしまっても、ENABLE_TEST_ENDPOINTS と Host が同時に揃うことはない。
function isTestBackdoorAllowed(c: any): boolean {
  // 1. APP_URL が localhost / 127.0.0.1 を指している
  const appUrl: string = c.env?.APP_URL || ''
  const appUrlIsDev = isTestBackdoorEnvironmentAllowed(appUrl)

  // 2. ENABLE_TEST_ENDPOINTS が明示的に "true"（本番では未設定）
  const flagOk = c.env?.ENABLE_TEST_ENDPOINTS === 'true'

  // 3. 実リクエストの Host が localhost / 127.0.0.1 （公開インターネット経由では絶対通らない）
  let hostIsDev = false
  try {
    const requestHost = new URL(c.req.url).hostname
    hostIsDev = requestHost === 'localhost' || requestHost === '127.0.0.1'
  } catch {
    hostIsDev = false
  }

  return appUrlIsDev && flagOk && hostIsDev
}

// Test-only endpoint for E2E testing (skip OAuth)
app.get('/auth/test-login', async (c) => {
  if (!isTestBackdoorAllowed(c)) {
    return c.json({ success: false, error: 'Not Found' }, 404)
  }

  try {
    const userId = c.req.query('user_id') || '1'
    const testUserId = parseInt(userId)
    const providerId = `test-${testUserId}`

    // Get or create test user by oauth_provider and oauth_provider_id
    let user = await c.env.DB.prepare(
      'SELECT * FROM users WHERE oauth_provider = ? AND oauth_provider_id = ?'
    ).bind('test', providerId).first()

    if (!user && c.req.query('signup') === 'true') {
      // Exercise the production signup path without an external OAuth provider.
      user = await upsertOAuthUser(c.env.DB, {
        provider: 'test', id: providerId,
        email: `test-user-${testUserId}@example.com`, name: `Test User ${testUserId}`,
      })
    } else if (user) {
      // Update last_login_at for existing user
      await c.env.DB.prepare(
        'UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).bind(user.id).run()

      // Delete old sessions for this user
      await c.env.DB.prepare(
        'DELETE FROM sessions WHERE user_id = ?'
      ).bind(user.id).run()
    } else {
      // Create test user with explicit ID for testing consistency
      try {
        user = await c.env.DB.prepare(
          `INSERT INTO users (id, oauth_provider, oauth_provider_id, email, display_name, avatar_url, last_login_at)
           VALUES (?, 'test', ?, ?, ?, NULL, CURRENT_TIMESTAMP)
           RETURNING *`
        )
          .bind(testUserId, providerId, `test-user-${testUserId}@example.com`, `Test User ${testUserId}`)
          .first()
      } catch (insertError) {
        // If ID already exists, check if user exists with different provider_id
        console.warn('Failed to insert with explicit ID:', insertError)
        user = await c.env.DB.prepare(
          'SELECT * FROM users WHERE oauth_provider = ? AND oauth_provider_id = ?'
        ).bind('test', providerId).first()

        if (!user) {
          // Try insert without explicit ID as last resort
          user = await c.env.DB.prepare(
            `INSERT INTO users (oauth_provider, oauth_provider_id, email, display_name, avatar_url, last_login_at)
             VALUES ('test', ?, ?, ?, NULL, CURRENT_TIMESTAMP)
             RETURNING *`
          )
            .bind(providerId, `test-user-${testUserId}@example.com`, `Test User ${testUserId}`)
            .first()
        }
      }
    }

    if (!user) {
      return c.json({ success: false, error: 'Failed to create test user' }, 500)
    }

    const requestedTtl = parseInt(c.req.query('session_ttl_seconds') || '', 10)
    const sessionTtlSeconds = Number.isInteger(requestedTtl)
      ? Math.max(1, Math.min(requestedTtl, 7 * 24 * 60 * 60))
      : 7 * 24 * 60 * 60
    const sessionId = crypto.randomUUID()
    const tokenSessionId = c.req.query('legacy_session') === 'true' ? undefined : sessionId

    // Generate JWT
    const token = await generateJWT(
      {
        id: user.id,
        email: user.email,
        display_name: user.display_name || '',
        avatar_url: user.avatar_url || undefined,
        oauth_provider: user.oauth_provider
      },
      c.env.JWT_SECRET,
      sessionTtlSeconds,
      tokenSessionId
    )

    // Create session record (test-login も 7 日に統一)
    await createSession(c.env.DB, user.id, token, sessionTtlSeconds, sessionId)

    // Set session cookie
    setCookie(c, 'session', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: sessionTtlSeconds,
      path: '/'
    })

    logAuditFromContext(c, { userId: user?.id ?? null, action: 'auth.login', targetType: 'user', targetId: user.id })

    return c.redirect('/index.html')
  } catch (error) {
    console.error('Test login error:', error)
    return c.json({ success: false, error: 'Test login failed' }, 500)
  }
})

// Test-only endpoint to clear all data
app.delete('/api/test/clear', async (c) => {
  if (!isTestBackdoorAllowed(c)) {
    return c.json({ success: false, error: 'Not Found' }, 404)
  }

  try {
    // trees.root_node_id -> nodes.id FK があるため、trees を先に消す
    // （trees削除で nodes / node_relations は CASCADE される）
    await c.env.DB.prepare('DELETE FROM sessions').run()
    await c.env.DB.prepare('DELETE FROM invitations').run()
    await c.env.DB.prepare('DELETE FROM notifications').run()
    // MCP OAuth（trees/users より先に消す）
    await c.env.DB.prepare('DELETE FROM mcp_oauth_tokens').run()
    await c.env.DB.prepare('DELETE FROM mcp_oauth_authorization_codes').run()
    await c.env.DB.prepare('DELETE FROM mcp_oauth_authorization_requests').run()
    await c.env.DB.prepare('DELETE FROM mcp_oauth_clients').run()
    await c.env.DB.prepare('DELETE FROM tree_members').run()
    await c.env.DB.prepare('DELETE FROM trees').run()
    // 念のため残骸があれば掃除
    await c.env.DB.prepare('DELETE FROM node_relations').run()
    await c.env.DB.prepare('DELETE FROM nodes').run()
    await c.env.DB.prepare('DELETE FROM users').run()

    return c.json({ success: true, message: 'All test data cleared' })
  } catch (error) {
    console.error('Clear data error:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ===============================
// Tree Management API Routes
// ===============================

// Get all trees accessible by the current user
app.get('/api/trees', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const trees = await getUserTrees(c.env.DB, user.user_id)

    const internalNodeIds = trees.flatMap((t: any) => [t.root_node_id, t.trash_root_node_id].filter((n): n is number => n !== null && n !== undefined))
    const publicIdMap = internalNodeIds.length > 0 ? await encodeNodeIds(c.env.DB, internalNodeIds) : new Map<number, string>()

    const data = trees.map((tree: any) => ({
      ...tree,
      root_node_id: publicIdMap.get(tree.root_node_id) ?? null,
      trash_root_node_id: tree.trash_root_node_id ? (publicIdMap.get(tree.trash_root_node_id) ?? null) : null,
    }))

    return c.json({
      success: true,
      data
    })
  } catch (error) {
    console.error('Failed to get trees:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Create a new tree
app.post('/api/trees', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    if (requestBodyIsTooLarge(c.req.header('content-length'))) {
      return c.json({ success: false, error: 'Request body is too large' }, 413)
    }
    const body = await c.req.json()

    const { name, description } = body

    const validName = validateTextLimit(name, 'Tree name', TREE_NAME_MAX_LENGTH, { required: true, trim: true })
    if (!validName.ok) return c.json({ success: false, error: validName.error }, 400)
    const validDescription = description === undefined || description === null
      ? { ok: true as const, value: null }
      : validateTextLimit(description, 'Tree description', TREE_DESCRIPTION_MAX_LENGTH)
    if (!validDescription.ok) return c.json({ success: false, error: validDescription.error }, 400)

    const tree = await createTree(
      c.env.DB,
      validName.value,
      validDescription.value,
      user.user_id
    )

    const nodeIdMap = await encodeNodeIds(c.env.DB, [tree.root_node_id, tree.trash_root_node_id].filter((n): n is number => n !== null && n !== undefined))

    logAuditFromContext(c, { userId: user?.user_id ?? null, action: 'tree.create', targetType: 'tree', targetId: tree.id, treeId: tree.id })

    return c.json({
      success: true,
      data: {
        ...tree,
        root_node_id: nodeIdMap.get(tree.root_node_id) ?? null,
        trash_root_node_id: tree.trash_root_node_id ? (nodeIdMap.get(tree.trash_root_node_id) ?? null) : null,
      }
    }, 201)
  } catch (error) {
    if (error instanceof QuotaExceededError) return c.json({ success: false, error: 'Tree quota exceeded' }, 409)
    console.error('Failed to create tree:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ===============================
// Tree Member Management API Routes
// (Must be defined before /api/trees/:id to avoid route conflicts)
// ===============================

// Get all members of a tree
app.get('/api/trees/:id/members', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('id'))

    if (isNaN(treeId)) {
      return c.json({ success: false, error: 'Invalid tree ID' }, 400)
    }

    // Check if user has access to this tree
    const hasAccess = await canViewTree(c.env.DB, treeId, user.user_id)
    if (!hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403)
    }

    const members = await getTreeMembers(c.env.DB, treeId)

    return c.json({
      success: true,
      data: members
    })
  } catch (error) {
    console.error('Failed to get tree members:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Add a member to a tree
app.post('/api/trees/:id/members', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('id'))

    if (isNaN(treeId)) {
      return c.json({ success: false, error: 'Invalid tree ID' }, 400)
    }

    // Only owners can add members directly
    const canManage = await canManageMembers(c.env.DB, treeId, user.user_id)
    if (!canManage) {
      return c.json({ success: false, error: 'Only the owner can manage members' }, 403)
    }

    // Parse request body
    const body = await c.req.json()
    const { user_id, role } = body

    if (!user_id || !role) {
      return c.json({ success: false, error: 'user_id and role are required' }, 400)
    }

    const targetUserId = parseInt(user_id)
    if (isNaN(targetUserId)) {
      return c.json({ success: false, error: 'Invalid user_id' }, 400)
    }

    if (role !== 'owner' && role !== 'editor' && role !== 'viewer') {
      return c.json({ success: false, error: 'Invalid role. Must be owner, editor, or viewer' }, 400)
    }

    // Check if user exists
    const targetUser = await c.env.DB
      .prepare('SELECT id FROM users WHERE id = ?')
      .bind(targetUserId)
      .first()

    if (!targetUser) {
      return c.json({ success: false, error: 'User not found' }, 404)
    }

    // Check if user is already a member
    const existingMember = await c.env.DB
      .prepare('SELECT id FROM tree_members WHERE tree_id = ? AND user_id = ?')
      .bind(treeId, targetUserId)
      .first()

    if (existingMember) {
      return c.json({ success: false, error: 'User is already a member of this tree' }, 400)
    }

    // Add member
    await addTreeMember(c.env.DB, treeId, targetUserId, role, user.user_id)

    logAuditFromContext(c, { userId: user?.user_id ?? null, action: 'member.add', targetType: 'tree', targetId: treeId, treeId: treeId })

    return c.json({
      success: true,
      message: 'Member added successfully'
    })
  } catch (error) {
    console.error('Failed to add member:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Remove a member from a tree
app.delete('/api/trees/:id/members/:userId', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('id'))
    const targetUserId = parseInt(c.req.param('userId'))

    if (isNaN(treeId) || isNaN(targetUserId)) {
      return c.json({ success: false, error: 'Invalid tree ID or user ID' }, 400)
    }

    // Only owners can remove members
    const canManage = await canManageMembers(c.env.DB, treeId, user.user_id)
    if (!canManage) {
      return c.json({ success: false, error: 'Only the owner can manage members' }, 403)
    }

    // Cannot remove the owner
    const tree = await getTreeById(c.env.DB, treeId)
    if (!tree) {
      return c.json({ success: false, error: 'Tree not found' }, 404)
    }

    if (targetUserId === tree.owner_user_id) {
      return c.json({ success: false, error: 'Cannot remove the owner from the tree' }, 400)
    }

    await removeTreeMember(c.env.DB, treeId, targetUserId)

    // メンバー解除時に、そのユーザーのMCP OAuthトークンを即時失効させる
    // （MCPリクエスト時にも role を再確認するが、待たずにここで失効させる）
    await revokeTokensForUserTree(c.env.DB, { userId: targetUserId, treeId })

    logAuditFromContext(c, { userId: user?.user_id ?? null, action: 'member.remove', targetType: 'tree', targetId: treeId, treeId: treeId })

    return c.json({
      success: true,
      message: 'Member removed successfully'
    })
  } catch (error) {
    console.error('Failed to remove member:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Update a member's role
app.put('/api/trees/:id/members/:userId/role', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('id'))
    const targetUserId = parseInt(c.req.param('userId'))

    if (isNaN(treeId) || isNaN(targetUserId)) {
      return c.json({ success: false, error: 'Invalid tree ID or user ID' }, 400)
    }

    // Only owner can change roles
    const isOwner = await canUpdateTreeMetadata(c.env.DB, treeId, user.user_id)
    if (!isOwner) {
      return c.json({ success: false, error: 'Only the owner can change member roles' }, 403)
    }

    const body = await c.req.json()
    const { role } = body

    if (!role || !['owner', 'editor', 'viewer'].includes(role)) {
      return c.json({ success: false, error: 'Invalid role. Must be owner, editor, or viewer' }, 400)
    }

    // Cannot change the owner's role
    const tree = await getTreeById(c.env.DB, treeId)
    if (!tree) {
      return c.json({ success: false, error: 'Tree not found' }, 404)
    }

    if (targetUserId === tree.owner_user_id && role !== 'owner') {
      return c.json({ success: false, error: 'Cannot change the owner\'s role' }, 400)
    }

    await updateMemberRole(c.env.DB, treeId, targetUserId, role)

    logAuditFromContext(c, { userId: user?.user_id ?? null, action: 'member.role_change', targetType: 'tree', targetId: treeId, treeId: treeId })

    return c.json({
      success: true,
      message: 'Member role updated successfully'
    })
  } catch (error) {
    console.error('Failed to update member role:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ===============================
// Invitation Routes
// ===============================

// Create an invitation to a tree
app.post('/api/trees/:id/invitations', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('id'))

    if (isNaN(treeId)) {
      return c.json({ success: false, error: 'Invalid tree ID' }, 400)
    }

    // Only owners can invite members
    const canInvite = await canManageMembers(c.env.DB, treeId, user.user_id)
    if (!canInvite) {
      return c.json({ success: false, error: 'Permission denied. Only the owner can invite members' }, 403)
    }

    const body = await c.req.json()
    const { email, role } = body

    if (!email || typeof email !== 'string') {
      return c.json({ success: false, error: 'Invalid email address' }, 400)
    }

    if (!role || !['editor', 'viewer'].includes(role)) {
      return c.json({ success: false, error: 'Invalid role. Must be editor or viewer' }, 400)
    }

    // Check if user with this email already exists and is a member
    const existingUser = await c.env.DB
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind(email)
      .first<{ id: number }>()

    if (existingUser) {
      const existingMember = await c.env.DB
        .prepare('SELECT id FROM tree_members WHERE tree_id = ? AND user_id = ?')
        .bind(treeId, existingUser.id)
        .first()

      if (existingMember) {
        return c.json({ success: false, error: 'User is already a member of this tree' }, 400)
      }
    }

    // Check if there's already a pending invitation for this email
    const existingInvitation = await c.env.DB
      .prepare(
        `SELECT id FROM invitations
         WHERE tree_id = ? AND invitee_email = ? AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP`
      )
      .bind(treeId, email)
      .first()

    if (existingInvitation) {
      return c.json({ success: false, error: 'An active invitation already exists for this email' }, 400)
    }

    // Create invitation
    const invitation = await createInvitation(c.env.DB, treeId, user.user_id, email, role as 'editor' | 'viewer')

    // Get tree and inviter information for email
    const tree = await getTreeById(c.env.DB, treeId)
    const inviter = await c.env.DB
      .prepare('SELECT display_name, email FROM users WHERE id = ?')
      .bind(user.user_id)
      .first<{ display_name: string; email: string }>()

    if (!tree || !inviter) {
      // Invitation created but email couldn't be sent
      return c.json({
        success: true,
        data: {
          id: invitation.id,
          token: invitation.token,
          email,
          role,
          message: 'Invitation created but email could not be sent'
        }
      }, 201)
    }

    // Get invitation details to retrieve expires_at
    const invitationDetails = await getInvitationByToken(c.env.DB, invitation.token)

    // Send invitation email (synchronous to ensure logging)
    if (!c.env.MAILGUN_API_KEY || !c.env.MAILGUN_DOMAIN) {
      console.warn('⚠️  MAILGUN_API_KEY or MAILGUN_DOMAIN not configured. Invitation email will NOT be sent.')
      console.log('📧 Would send invitation email to:', email)
    } else if (!invitationDetails) {
      console.error('❌ Invitation details not found. Email cannot be sent.')
    } else {
      console.log('📧 Sending invitation email to:', email)
      try {
        const emailResult = await sendInvitationEmail(
          { apiKey: c.env.MAILGUN_API_KEY, domain: c.env.MAILGUN_DOMAIN },
          {
            to: email,
            inviterName: inviter.display_name || inviter.email,
            treeName: tree.name,
            role: role as 'editor' | 'viewer',
            token: invitation.token,
            appUrl: c.env.APP_URL,
            expiresAt: invitationDetails.expires_at
          }
        )

        if (emailResult.success) {
          console.log('✅ Invitation email sent successfully to:', email)
          console.log('   Email ID:', emailResult.id)
        } else {
          console.error('❌ Failed to send invitation email:', emailResult.error)
        }
      } catch (error) {
        console.error('❌ Exception while sending invitation email:', error)
        // Don't fail the API call if email fails
      }
    }

    // Create notification if invitee is an existing user
    if (existingUser) {
      await createNotification(
        c.env.DB,
        existingUser.id,
        'invitation',
        { inviter: inviter.display_name || inviter.email, tree: tree.name },
        'ツリーへの招待',
        `${inviter.display_name || inviter.email} さんがあなたを「${tree.name}」ツリーに招待しました`,
        `/accept-invitation.html?token=${invitation.token}`
      )
    }

    logAuditFromContext(c, { userId: user?.user_id ?? null, action: 'invitation.create', targetType: 'invitation', targetId: invitation.id, treeId: treeId })

    return c.json({
      success: true,
      data: {
        id: invitation.id,
        token: invitation.token,
        email,
        role,
        message: 'Invitation created successfully'
      }
    }, 201)
  } catch (error) {
    console.error('Failed to create invitation:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Get invitation details by token (public, no auth required)
app.get('/api/invitations/:token', async (c) => {
  try {
    const token = c.req.param('token')

    if (!token) {
      return c.json({ success: false, error: 'Invalid token' }, 400)
    }

    const invitation = await getInvitationByToken(c.env.DB, token)

    if (!invitation) {
      return c.json({ success: false, error: 'Invitation not found' }, 404)
    }

    // Check if invitation has expired
    const now = new Date()
    const expiresAt = new Date(invitation.expires_at)
    const isExpired = now > expiresAt

    // Check if invitation is still pending
    if (invitation.status !== 'pending') {
      return c.json({ success: false, error: 'Invitation has already been used or cancelled' }, 400)
    }

    if (isExpired) {
      return c.json({ success: false, error: 'Invitation has expired' }, 400)
    }

    return c.json({
      success: true,
      data: {
        tree_name: invitation.tree_name,
        inviter_name: invitation.inviter_name,
        role: invitation.role,
        expires_at: invitation.expires_at,
        invitee_email: invitation.invitee_email
      }
    })
  } catch (error) {
    console.error('Failed to get invitation:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Accept an invitation
app.post('/api/invitations/:token/accept', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const token = c.req.param('token')

    if (!token) {
      return c.json({ success: false, error: 'Invalid token' }, 400)
    }

    // Verify invitation matches user's email
    const invitation = await getInvitationByToken(c.env.DB, token)
    if (!invitation) {
      return c.json({ success: false, error: 'Invitation not found' }, 404)
    }

    // Check if the logged-in user's email matches the invitation email
    const currentUser = await c.env.DB
      .prepare('SELECT email FROM users WHERE id = ?')
      .bind(user.user_id)
      .first<{ email: string }>()

    if (!currentUser || currentUser.email !== invitation.invitee_email) {
      return c.json({
        success: false,
        error: 'This invitation is for a different email address. Please log in with the invited email.'
      }, 403)
    }

    // Accept invitation
    const result = await acceptInvitation(c.env.DB, token, user.user_id)

    // Get tree and user information for notification
    const tree = await getTreeById(c.env.DB, result.treeId)
    const acceptingUser = await c.env.DB
      .prepare('SELECT display_name, email FROM users WHERE id = ?')
      .bind(user.user_id)
      .first<{ display_name: string; email: string }>()

    // Create notification for the inviter
    if (tree && acceptingUser && invitation.inviter_user_id) {
      await createNotification(
        c.env.DB,
        invitation.inviter_user_id,
        'invitation_accepted',
        { user: acceptingUser.display_name || acceptingUser.email, tree: tree.name },
        '招待が受諾されました',
        `${acceptingUser.display_name || acceptingUser.email} さんが「${tree.name}」ツリーへの招待を受諾しました`,
        `/index.html?tree=${result.treeId}`
      )
    }

    logAuditFromContext(c, { userId: user?.user_id ?? null, action: 'invitation.accept', targetType: 'tree', targetId: result.treeId, treeId: result.treeId })

    return c.json({
      success: true,
      data: {
        tree_id: result.treeId,
        role: result.role,
        message: 'Invitation accepted successfully'
      }
    })
  } catch (error) {
    console.error('Failed to accept invitation:', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: errorMessage }, 400)
  }
})

// Get all invitations for a tree (owner/editor only)
app.get('/api/trees/:id/invitations', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('id'))

    if (isNaN(treeId)) {
      return c.json({ success: false, error: 'Invalid tree ID' }, 400)
    }

    const role = await getUserRole(c.env.DB, treeId, user.user_id)
    if (role !== 'owner' && role !== 'editor') {
      return c.json({ success: false, error: 'Permission denied' }, 403)
    }

    const invitations = await getTreeInvitations(c.env.DB, treeId)

    return c.json({
      success: true,
      data: invitations
    })
  } catch (error) {
    console.error('Failed to get invitations:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Cancel an invitation (owner/editor only)
app.delete('/api/trees/:id/invitations/:invitationId', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('id'))
    const invitationId = parseInt(c.req.param('invitationId'))

    if (isNaN(treeId) || isNaN(invitationId)) {
      return c.json({ success: false, error: 'Invalid tree ID or invitation ID' }, 400)
    }

    // Only owners can cancel invitations
    const canManage = await canManageMembers(c.env.DB, treeId, user.user_id)
    if (!canManage) {
      return c.json({ success: false, error: 'Only the owner can cancel invitations' }, 403)
    }

    // Verify the invitation belongs to this tree
    const invitation = await c.env.DB
      .prepare('SELECT id, status FROM invitations WHERE id = ? AND tree_id = ?')
      .bind(invitationId, treeId)
      .first<{ id: number; status: string }>()

    if (!invitation) {
      return c.json({ success: false, error: 'Invitation not found' }, 404)
    }

    if (invitation.status !== 'pending') {
      return c.json({ success: false, error: 'Only pending invitations can be cancelled' }, 400)
    }

    // Cancel the invitation
    await cancelInvitation(c.env.DB, invitationId)

    logAuditFromContext(c, { userId: user?.user_id ?? null, action: 'invitation.cancel', targetType: 'invitation', targetId: invitationId, treeId: treeId })

    return c.json({
      success: true,
      message: 'Invitation cancelled successfully'
    })
  } catch (error) {
    console.error('Failed to cancel invitation:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ============================================
// Notification Management APIs
// ============================================

// Get all notifications for the current user
app.get('/api/notifications', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)

    const notifications = await c.env.DB
      .prepare(`
        SELECT id, type, params, title, message, link, is_read, created_at
        FROM notifications
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 50
      `)
      .bind(user.user_id)
      .all()

    const parsedNotifications = (notifications.results || []).map((notification: any) => {
      let params = null
      if (typeof notification.params === 'string') {
        try {
          params = JSON.parse(notification.params)
        } catch {
          params = null
        }
      }
      return { ...notification, params }
    })

    return c.json({
      success: true,
      data: parsedNotifications
    })
  } catch (error) {
    console.error('Failed to get notifications:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Mark a specific notification as read
app.put('/api/notifications/:id/read', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const notificationId = parseInt(c.req.param('id'))

    if (isNaN(notificationId)) {
      return c.json({ success: false, error: 'Invalid notification ID' }, 400)
    }

    // Check if notification belongs to the user
    const notification = await c.env.DB
      .prepare('SELECT user_id FROM notifications WHERE id = ?')
      .bind(notificationId)
      .first<{ user_id: number }>()

    if (!notification) {
      return c.json({ success: false, error: 'Notification not found' }, 404)
    }

    if (notification.user_id !== user.user_id) {
      return c.json({ success: false, error: 'Access denied' }, 403)
    }

    // Mark as read
    await c.env.DB
      .prepare('UPDATE notifications SET is_read = 1 WHERE id = ?')
      .bind(notificationId)
      .run()

    return c.json({
      success: true,
      message: 'Notification marked as read'
    })
  } catch (error) {
    console.error('Failed to mark notification as read:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Mark all notifications as read for the current user
app.put('/api/notifications/read-all', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)

    await c.env.DB
      .prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0')
      .bind(user.user_id)
      .run()

    return c.json({
      success: true,
      message: 'All notifications marked as read'
    })
  } catch (error) {
    console.error('Failed to mark all notifications as read:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Helper function to create a notification
async function createNotification(
  db: D1Database,
  userId: number,
  type: string,
  params: Record<string, string>,
  title: string,
  message: string,
  link?: string
) {
  await db
    .prepare(`
      INSERT INTO notifications (user_id, type, params, title, message, link)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(userId, type, JSON.stringify(params), title, message, link || null)
    .run()
}

// Get a specific tree
app.get('/api/trees/:id', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('id'))

    if (isNaN(treeId)) {
      return c.json({ success: false, error: 'Invalid tree ID' }, 400)
    }

    // Check if tree exists first (404 before 403)
    const tree = await getTreeById(c.env.DB, treeId)
    if (!tree) {
      return c.json({ success: false, error: 'Tree not found' }, 404)
    }

    // Check if user has access to this tree
    const hasAccess = await canViewTree(c.env.DB, treeId, user.user_id)
    if (!hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403)
    }

    // Get tree statistics
    const stats = await getTreeStats(c.env.DB, treeId)

    const nodeIdMap = await encodeNodeIds(c.env.DB, [tree.root_node_id, tree.trash_root_node_id].filter((n): n is number => n !== null && n !== undefined))

    logAuditFromContext(c, { userId: user.user_id, action: 'read.tree', targetType: 'tree', targetId: treeId })
    return c.json({
      success: true,
      data: {
        ...tree,
        root_node_id: nodeIdMap.get(tree.root_node_id) ?? null,
        trash_root_node_id: tree.trash_root_node_id ? (nodeIdMap.get(tree.trash_root_node_id) ?? null) : null,
        stats
      }
    })
  } catch (error) {
    console.error('Failed to get tree:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Update tree metadata (name, description)
app.put('/api/trees/:id', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('id'))

    if (isNaN(treeId)) {
      return c.json({ success: false, error: 'Invalid tree ID' }, 400)
    }

    // Check if user can update tree metadata (owner only)
    const canUpdate = await canUpdateTreeMetadata(c.env.DB, treeId, user.user_id)
    if (!canUpdate) {
      return c.json({ success: false, error: 'Only the owner can update tree metadata' }, 403)
    }

    if (requestBodyIsTooLarge(c.req.header('content-length'))) {
      return c.json({ success: false, error: 'Request body is too large' }, 413)
    }
    const body = await c.req.json()
    const { name, description, icon, color } = body

    const updates: { name?: string; description?: string | null; icon?: string | null; color?: string | null } = {}

    if (name !== undefined) {
      const validName = validateTextLimit(name, 'Tree name', TREE_NAME_MAX_LENGTH, { required: true, trim: true })
      if (!validName.ok) return c.json({ success: false, error: validName.error }, 400)
      updates.name = validName.value
    }

    if (description === null) {
      updates.description = null
    } else if (description !== undefined) {
      const validDescription = validateTextLimit(description, 'Tree description', TREE_DESCRIPTION_MAX_LENGTH)
      if (!validDescription.ok) return c.json({ success: false, error: validDescription.error }, 400)
      updates.description = validDescription.value
    }

    if (icon === null) {
      updates.icon = null
    } else if (icon !== undefined) {
      const validIcon = validateTreeIcon(icon)
      if (!validIcon.ok) return c.json({ success: false, error: validIcon.error }, 400)
      updates.icon = validIcon.value
    }

    if (color === null) {
      updates.color = null
    } else if (color !== undefined) {
      const validColor = validateTreeColor(color)
      if (!validColor.ok) return c.json({ success: false, error: validColor.error }, 400)
      updates.color = validColor.value
    }

    const updatedTree = await updateTree(c.env.DB, treeId, updates)

    const nodeIdMap = await encodeNodeIds(c.env.DB, [updatedTree.root_node_id, updatedTree.trash_root_node_id].filter((n): n is number => n !== null && n !== undefined))

    logAuditFromContext(c, { userId: user?.user_id ?? null, action: 'tree.update', targetType: 'tree', targetId: treeId, treeId: treeId })

    return c.json({
      success: true,
      data: {
        ...updatedTree,
        root_node_id: nodeIdMap.get(updatedTree.root_node_id) ?? null,
        trash_root_node_id: updatedTree.trash_root_node_id ? (nodeIdMap.get(updatedTree.trash_root_node_id) ?? null) : null,
      }
    })
  } catch (error) {
    console.error('Failed to update tree:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Delete a tree
app.delete('/api/trees/:id', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('id'))

    if (isNaN(treeId)) {
      return c.json({ success: false, error: 'Invalid tree ID' }, 400)
    }

    // Check if user can delete tree (owner only)
    const canDelete = await canDeleteTree(c.env.DB, treeId, user.user_id)
    if (!canDelete) {
      return c.json({ success: false, error: 'Only the owner can delete the tree' }, 403)
    }

    await deleteTree(c.env.DB, treeId)

    logAuditFromContext(c, { userId: user?.user_id ?? null, action: 'tree.delete', targetType: 'tree', targetId: treeId, treeId: treeId })

    return c.json({
      success: true,
      message: 'Tree deleted successfully'
    })
  } catch (error) {
    console.error('Failed to delete tree:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ===============================
// Tree-Scoped Node API Routes
// ===============================

// Get all nodes in a tree
app.get('/api/trees/:tree_id/nodes/:id/images', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const nodePublicId = c.req.param('id')

    if (isNaN(treeId) || !isValidPublicNodeId(nodePublicId)) {
      return c.json({ success: false, error: 'Invalid tree ID or node ID' }, 400)
    }

    const hasAccess = await canViewTree(c.env.DB, treeId, user.user_id)
    if (!hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403)
    }

    const nodeId = await resolvePublicNodeId(c.env.DB, treeId, nodePublicId)
    if (!nodeId) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    const nodeRow = await c.env.DB.prepare('SELECT id FROM nodes WHERE id = ? AND tree_id = ?')
      .bind(nodeId, treeId)
      .first<{ id: number }>()
    if (!nodeRow) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    const { results } = await c.env.DB.prepare(
      `SELECT id, node_id, serial_no, file_name, file_ext, mime_type, file_size, created_at
       FROM node_images
       WHERE tree_id = ? AND node_id = ?
       ORDER BY serial_no ASC`
    )
      .bind(treeId, nodeId)
      .all<{
        id: number
        node_id: number
        serial_no: number
        file_name: string
        file_ext: string
        mime_type: string
        file_size: number
        created_at: string
      }>()

    const data = (results || []).map((row) => {
      const url = buildNodeImageFileUrl(treeId, nodePublicId, row.id)
      return {
        ...row,
        node_id: nodePublicId,
        url,
        markdown: `![${row.file_name}](${url})`,
      }
    })

    return c.json({ success: true, data })
  } catch (error) {
    console.error('Failed to list node images:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

const REST_IMAGE_REJECTION_MESSAGES: Record<NodeImageRejection, string> = {
  empty: 'Empty file is not allowed',
  too_large: 'File is too large (max 5MB)',
  unsupported_mime: 'Only image files are allowed',
  unknown_ext: 'Failed to determine file extension',
  invalid_content: 'Image content does not match its MIME type',
}

app.post('/api/trees/:tree_id/nodes/:id/images', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const nodePublicId = c.req.param('id')

    if (isNaN(treeId) || !isValidPublicNodeId(nodePublicId)) {
      return c.json({ success: false, error: 'Invalid tree ID or node ID' }, 400)
    }

    const canEdit = await canEditTree(c.env.DB, treeId, user.user_id)
    if (!canEdit) {
      return c.json({ success: false, error: 'You do not have permission to edit this tree' }, 403)
    }

    const nodeId = await resolvePublicNodeId(c.env.DB, treeId, nodePublicId)
    if (!nodeId) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    const nodeRow = await c.env.DB.prepare('SELECT id FROM nodes WHERE id = ? AND tree_id = ?')
      .bind(nodeId, treeId)
      .first<{ id: number }>()
    if (!nodeRow) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    const formData = await c.req.formData()
    const upload = formData.get('file')
    if (!(upload instanceof File)) {
      return c.json({ success: false, error: 'file is required' }, 400)
    }
    const uploadBytes = new Uint8Array(await upload.arrayBuffer())
    const validation = validateNodeImage(upload.size, upload.type, upload.name, uploadBytes)
    if (!validation.ok) {
      return c.json({ success: false, error: REST_IMAGE_REJECTION_MESSAGES[validation.reason] }, 400)
    }

    const inserted = await storeNodeImage(c.env.DB, c.env.NODE_IMAGES, {
      treeId,
      nodeId,
      fileNameRaw: upload.name,
      mimeType: validation.mimeType,
      fileExt: validation.fileExt,
      bytes: uploadBytes,
      actorUserId: user.user_id,
    })
    if (!inserted) {
      return c.json({ success: false, error: 'Failed to save image metadata' }, 500)
    }

    const url = buildNodeImageFileUrl(treeId, nodePublicId, inserted.id)
    logAuditFromContext(c, { userId: user.user_id, action: 'node.image_upload', targetType: 'node', targetId: nodeId, treeId })
    return c.json({
      success: true,
      data: {
        ...inserted,
        node_id: nodePublicId,
        url,
        markdown: `![${inserted.file_name}](${url})`,
      }
    })
  } catch (error) {
    console.error('Failed to upload node image:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

app.get('/api/trees/:tree_id/nodes/:node_id/images/:image_id/file', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const nodePublicId = c.req.param('node_id')
    const imageId = parseInt(c.req.param('image_id'))

    if (isNaN(treeId) || !isValidPublicNodeId(nodePublicId) || isNaN(imageId)) {
      return c.json({ success: false, error: 'Invalid tree ID, node ID, or image ID' }, 400)
    }

    const nodeId = await resolvePublicNodeId(c.env.DB, treeId, nodePublicId)
    if (!nodeId) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    const hasAccess = await canViewTree(c.env.DB, treeId, user.user_id)
    if (!hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403)
    }

    const imageRow = await c.env.DB.prepare(
      `SELECT ni.r2_key, ni.mime_type, ni.file_name
       FROM node_images ni
       INNER JOIN nodes n ON n.id = ni.node_id
       WHERE ni.id = ? AND ni.tree_id = ? AND ni.node_id = ? AND n.tree_id = ?`
    )
      .bind(imageId, treeId, nodeId, treeId)
      .first<{ r2_key: string; mime_type: string; file_name: string }>()
    if (!imageRow) {
      return c.json({ success: false, error: 'Image not found' }, 404)
    }

    const object = await c.env.NODE_IMAGES.get(imageRow.r2_key)
    if (!object || !object.body) {
      return c.json({ success: false, error: 'Image file not found in storage' }, 404)
    }

    // SVGは直接開いた際にスクリプトが実行される危険があるため、ダウンロード扱いにする
    const isSvgImage = (imageRow.mime_type || '').toLowerCase() === 'image/svg+xml'
    return new Response(object.body, {
      headers: {
        'Content-Type': imageRow.mime_type || 'application/octet-stream',
        'Cache-Control': 'private, max-age=3600',
        'Content-Disposition': `${isSvgImage ? 'attachment' : 'inline'}; filename="${imageRow.file_name}"`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
      }
    })
  } catch (error) {
    console.error('Failed to serve node image:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

app.delete('/api/trees/:tree_id/nodes/:node_id/images/:image_id', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const nodePublicId = c.req.param('node_id')
    const imageId = parseInt(c.req.param('image_id'))

    if (isNaN(treeId) || !isValidPublicNodeId(nodePublicId) || isNaN(imageId)) {
      return c.json({ success: false, error: 'Invalid tree ID, node ID, or image ID' }, 400)
    }

    // 任意: 呼び出し側（エディタ）の現在の content。DB には保存せず、対象のタグを除いた文字列を返すだけ
    if (requestBodyIsTooLarge(c.req.header('content-length'))) {
      return c.json({ success: false, error: 'Request body is too large' }, 413)
    }
    const rawBody = await c.req.text()
    let editorContent: string | null = null
    if (rawBody) {
      let parsedBody: { content?: unknown } | null
      try {
        parsedBody = JSON.parse(rawBody)
      } catch {
        return c.json({ success: false, error: 'Invalid JSON body' }, 400)
      }
      if (parsedBody?.content !== undefined) {
        const validContent = validateTextLimit(parsedBody.content, 'Node content', NODE_CONTENT_MAX_LENGTH)
        if (!validContent.ok) return c.json({ success: false, error: validContent.error }, 400)
        editorContent = validContent.value
      }
    }

    const nodeId = await resolvePublicNodeId(c.env.DB, treeId, nodePublicId)
    if (!nodeId) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    const canEdit = await canEditTree(c.env.DB, treeId, user.user_id)
    if (!canEdit) {
      return c.json({ success: false, error: 'You do not have permission to edit this tree' }, 403)
    }

    const nodeRow = await c.env.DB.prepare(
      'SELECT id, content FROM nodes WHERE id = ? AND tree_id = ?'
    )
      .bind(nodeId, treeId)
      .first<{ id: number; content: string | null }>()
    if (!nodeRow) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    const imageRow = await c.env.DB.prepare(
      'SELECT id, r2_key FROM node_images WHERE id = ? AND tree_id = ? AND node_id = ?'
    )
      .bind(imageId, treeId, nodeId)
      .first<{ id: number; r2_key: string }>()
    if (!imageRow) {
      return c.json({ success: false, error: 'Image not found' }, 404)
    }

    await c.env.NODE_IMAGES.delete(imageRow.r2_key)
    await c.env.DB.prepare('DELETE FROM node_images WHERE id = ?').bind(imageId).run()

    const imageUrl = buildNodeImageFileUrl(treeId, nodePublicId, imageId)
    const updatedContent = stripNodeImageMarkdownReferences(nodeRow.content, imageUrl)
    const contentUpdated = updatedContent !== String(nodeRow.content || '')
    if (contentUpdated) {
      await c.env.DB.prepare(
        `UPDATE nodes
         SET content = ?, updated_by_user_id = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND tree_id = ?`
      ).bind(updatedContent, user.user_id, nodeId, treeId).run()
    }

    logAuditFromContext(c, { userId: user.user_id, action: 'node.image_delete', targetType: 'node', targetId: nodeId, treeId })
    return c.json({
      success: true,
      data: {
        id: imageId,
        content_updated: contentUpdated,
        ...(editorContent === null ? {} : { editor_content: stripNodeImageMarkdownReferences(editorContent, imageUrl) }),
      },
    })
  } catch (error) {
    console.error('Failed to delete node image:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

app.get('/api/trees/:tree_id/nodes', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))

    if (isNaN(treeId)) {
      return c.json({ success: false, error: 'Invalid tree ID' }, 400)
    }

    // RT1: ツリー存在確認(+root/trash root) + 権限チェック を一括
    const checkResults = await c.env.DB.batch([
      c.env.DB.prepare('SELECT id, root_node_id, trash_root_node_id FROM trees WHERE id = ? AND (is_deleted = 0 OR is_deleted IS NULL)')
        .bind(treeId),
      c.env.DB.prepare('SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ?')
        .bind(treeId, user.user_id),
    ])

    const treeRow = checkResults[0].results[0] as { id: number; root_node_id: number; trash_root_node_id: number | null } | undefined
    if (!treeRow) {
      return c.json({ success: false, error: 'Tree not found' }, 404)
    }
    if (checkResults[1].results.length === 0) {
      return c.json({ success: false, error: 'Access denied' }, 403)
    }

    // RT2: ノード一覧取得
    const { results } = await c.env.DB.prepare(
      `SELECT n.public_id AS id, n.tree_id, n.title, n.content, n.author_user_id,
              n.created_by_user_id, n.updated_by_user_id, n.version,
              n.created_at, n.updated_at, n.child_sort_mode, n.child_sort_direction, n.deleted_at,
              u_author.display_name AS author_display_name, u_author.email AS author_email
       FROM nodes n
       LEFT JOIN users u_author ON n.author_user_id = u_author.id
       WHERE n.tree_id = ? ORDER BY n.created_at`
    )
      .bind(treeId)
      .all()

    const nodeMetaIdMap = await encodeNodeIds(c.env.DB, [treeRow.root_node_id, treeRow.trash_root_node_id].filter((n): n is number => n !== null && n !== undefined))

    return c.json({
      success: true,
      data: results,
      root_node_id: nodeMetaIdMap.get(treeRow.root_node_id) ?? null,
      trash_root_node_id: treeRow.trash_root_node_id ? (nodeMetaIdMap.get(treeRow.trash_root_node_id) ?? null) : null
    })
  } catch (error) {
    console.error('Failed to get nodes:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

app.get('/api/trees/:tree_id/nodes-lite', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))

    if (isNaN(treeId)) {
      return c.json({ success: false, error: 'Invalid tree ID' }, 400)
    }

    // Keep the same access semantics as the full nodes endpoint.
    const checkResults = await c.env.DB.batch([
      c.env.DB.prepare('SELECT id, root_node_id, trash_root_node_id FROM trees WHERE id = ? AND (is_deleted = 0 OR is_deleted IS NULL)')
        .bind(treeId),
      c.env.DB.prepare('SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ?')
        .bind(treeId, user.user_id),
    ])

    const treeRow = checkResults[0].results[0] as { id: number; root_node_id: number; trash_root_node_id: number | null } | undefined
    if (!treeRow) {
      return c.json({ success: false, error: 'Tree not found' }, 404)
    }
    if (checkResults[1].results.length === 0) {
      return c.json({ success: false, error: 'Access denied' }, 403)
    }

    const { results } = await c.env.DB.prepare(
      `SELECT
         n.public_id AS id,
         n.tree_id,
         n.title,
         n.author_user_id,
         n.version,
         n.created_at,
         n.updated_at,
         n.child_sort_mode,
         n.child_sort_direction,
         n.deleted_at
       FROM nodes n
       WHERE n.tree_id = ?
       ORDER BY n.created_at`
    )
      .bind(treeId)
      .all()

    const nodeMetaIdMap = await encodeNodeIds(c.env.DB, [treeRow.root_node_id, treeRow.trash_root_node_id].filter((n): n is number => n !== null && n !== undefined))

    return c.json({
      success: true,
      data: results,
      root_node_id: nodeMetaIdMap.get(treeRow.root_node_id) ?? null,
      trash_root_node_id: treeRow.trash_root_node_id ? (nodeMetaIdMap.get(treeRow.trash_root_node_id) ?? null) : null
    })
  } catch (error) {
    console.error('Failed to get lite nodes:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Get root nodes (children of tree's root node)
// NOTE: This route MUST be defined before /nodes/:id to avoid "root" being captured as :id
app.get('/api/trees/:tree_id/nodes/root', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))

    if (isNaN(treeId)) {
      return c.json({ success: false, error: 'Invalid tree ID' }, 400)
    }

    // RT1: ツリー取得(root_node_id) + 権限チェック を一括
    const checkResults = await c.env.DB.batch([
      c.env.DB.prepare('SELECT root_node_id FROM trees WHERE id = ? AND (is_deleted = 0 OR is_deleted IS NULL)')
        .bind(treeId),
      c.env.DB.prepare('SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ?')
        .bind(treeId, user.user_id),
    ])

    const treeRow = checkResults[0].results[0] as { root_node_id: number } | undefined
    if (!treeRow) {
      return c.json({ success: false, error: 'Tree not found' }, 404)
    }
    if (checkResults[1].results.length === 0) {
      return c.json({ success: false, error: 'Access denied' }, 403)
    }

    // RT2: rootノードの子を取得
    const { results } = await c.env.DB.prepare(
      `SELECT n.public_id AS id, n.tree_id, n.title, n.content, n.author_user_id,
              n.created_by_user_id, n.updated_by_user_id, n.version,
              n.created_at, n.updated_at, n.child_sort_mode, n.child_sort_direction, n.deleted_at,
              u_author.display_name AS author_display_name, u_author.email AS author_email,
              nr.relation_type_id, rt.name AS relation_type_name
       FROM nodes n
       JOIN node_relations nr ON n.id = nr.child_node_id
       LEFT JOIN relation_types rt ON nr.relation_type_id = rt.id
       LEFT JOIN users u_author ON n.author_user_id = u_author.id
       WHERE nr.parent_node_id = ?
       ORDER BY nr.position, n.created_at`
    )
      .bind(treeRow.root_node_id)
      .all()

    return c.json({ success: true, data: results })
  } catch (error) {
    console.error('Failed to get root nodes:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Get a specific node in a tree
app.get('/api/trees/:tree_id/nodes/:id', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const nodePublicId = c.req.param('id')

    if (isNaN(treeId) || !isValidPublicNodeId(nodePublicId)) {
      return c.json({ success: false, error: 'Invalid tree ID or node ID' }, 400)
    }

    // 列挙対策: ノード解決より先にツリーアクセスを検査し、非メンバーが
    // ノードの存在/非存在を 403/404 の差で区別できないようにする
    const hasAccess = await canViewTree(c.env.DB, treeId, user.user_id)
    if (!hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403)
    }

    const nodeId = await resolvePublicNodeId(c.env.DB, treeId, nodePublicId)
    if (!nodeId) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    const node = await c.env.DB.prepare(
      `SELECT n.public_id AS id, n.tree_id, n.title, n.content, n.author_user_id,
              n.created_by_user_id, n.updated_by_user_id, n.updated_by_client_id, n.version,
              n.created_at, n.updated_at, n.child_sort_mode, n.child_sort_direction, n.deleted_at,
              u_author.display_name AS author_display_name, u_author.email AS author_email,
              u_updated.display_name AS updated_by_display_name, u_updated.email AS updated_by_email
       FROM nodes n
       LEFT JOIN users u_author ON n.author_user_id = u_author.id
       LEFT JOIN users u_updated ON n.updated_by_user_id = u_updated.id
       WHERE n.id = ? AND n.tree_id = ?`
    )
      .bind(nodeId, treeId)
      .first<{
        updated_by_client_id: string | null
        [key: string]: unknown
      }>()

    if (!node) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    // node detail ダイアログの「更新者」表示用に、最終更新クライアント名を解決する
    if (node.updated_by_client_id != null) {
      const clientRow = await c.env.DB.prepare(
        'SELECT client_name FROM mcp_oauth_clients WHERE client_id = ?'
      ).bind(node.updated_by_client_id).first<{ client_name: string | null }>()
      ;(node as Record<string, unknown>).updated_by_client_name = clientRow?.client_name ?? null
    } else {
      ;(node as Record<string, unknown>).updated_by_client_name = null
    }

    logAuditFromContext(c, { userId: user.user_id, action: 'read.node', targetType: 'node', targetId: nodeId, treeId })
    return c.json({ success: true, data: node })
  } catch (error) {
    console.error('Failed to get node:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Get saved content snapshots without transferring their content.
app.get('/api/trees/:tree_id/nodes/:id/history', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const nodePublicId = c.req.param('id')
    if (isNaN(treeId) || !isValidPublicNodeId(nodePublicId)) {
      return c.json({ success: false, error: 'Invalid tree ID or node ID' }, 400)
    }
    const hasAccess = await canViewTree(c.env.DB, treeId, user.user_id)
    if (!hasAccess) return c.json({ success: false, error: 'Access denied' }, 403)
    const nodeId = await resolvePublicNodeId(c.env.DB, treeId, nodePublicId)
    if (!nodeId) return c.json({ success: false, error: 'Node not found' }, 404)

    const rawLimit = c.req.query('limit')
    const requestedLimit = rawLimit === undefined ? 20 : Number(rawLimit)
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      return c.json({ success: false, error: 'limit must be a positive integer' }, 400)
    }
    const limit = Math.min(100, requestedLimit)
    // 各行に「その内容が書かれた日時・書いた人」を出すため、表示対象より1件多く
    // 取得する。内容 v_m が生まれたのは、次に古い snapshot が持つ版 v_j が置き換え
    // られた瞬間なので、version に飛びがあっても1つ古い snapshot から正確に得られる。
    // limit=100 では readNodeSnapshots の clamp で境界行が取れず、最古行だけ
    // 従来の「置き換えられた日時」にフォールバックする
    const snapshots = await readNodeSnapshots(c.env.DB, nodeId, limit + 1)
    // 現在の状態は snapshot に存在しない（snapshot は置き換え前の版のみ）。
    // UI の履歴一覧の先頭行に現在状態を出すため、version / updated_at / 最終更新者を返す。
    // v1 行の「書かれた日時・書いた人」は snapshot に源が無いため作成情報から出す
    const currentNode = await c.env.DB.prepare(
      `SELECT n.version, n.updated_at, n.updated_by_user_id, n.updated_by_client_id,
              n.created_at, n.created_by_user_id,
              u.display_name AS updated_by_display_name, u.email AS updated_by_email,
              cu.display_name AS created_by_display_name, cu.email AS created_by_email
       FROM nodes n
       LEFT JOIN users u ON u.id = n.updated_by_user_id
       LEFT JOIN users cu ON cu.id = n.created_by_user_id
       WHERE n.id = ? AND n.tree_id = ?`
    )
      .bind(nodeId, treeId)
      .first<{
        version: number
        updated_at: string
        updated_by_user_id: number | null
        updated_by_client_id: string | null
        created_at: string
        created_by_user_id: number | null
        updated_by_display_name: string | null
        updated_by_email: string | null
        created_by_display_name: string | null
        created_by_email: string | null
      }>()

    const actorIds = [...new Set([
      ...snapshots.map((snapshot) => snapshot.user_id),
      currentNode?.updated_by_user_id ?? null,
      currentNode?.created_by_user_id ?? null,
    ].filter((value): value is number => value != null))]
    const clientIds = [...new Set([
      ...snapshots.map((snapshot) => snapshot.client_id),
      currentNode?.updated_by_client_id ?? null,
    ].filter((value): value is string => value != null))]
    const actorMap = new Map<number, { display_name: string | null; email: string | null }>()
    if (actorIds.length > 0) {
      const { results } = await c.env.DB.prepare(
        `SELECT id, display_name, email FROM users WHERE id IN (${actorIds.map(() => '?').join(',')})`
      ).bind(...actorIds).all<{ id: number; display_name: string | null; email: string | null }>()
      for (const actor of results || []) actorMap.set(actor.id, actor)
    }
    const clientMap = new Map<string, string | null>()
    if (clientIds.length > 0) {
      const { results } = await c.env.DB.prepare(
        `SELECT client_id, client_name FROM mcp_oauth_clients WHERE client_id IN (${clientIds.map(() => '?').join(',')})`
      ).bind(...clientIds).all<{ client_id: string; client_name: string | null }>()
      for (const client of results || []) clientMap.set(client.client_id, client.client_name)
    }

    const items = snapshots.slice(0, limit).map((snapshot, index) => {
      // この内容を置き換えた更新 = 1つ古い snapshot。そこから「書かれた日時・書いた人」
      // を得る。より古い snapshot が取れない行は、v1 ならノード作成情報を使い、
      // それ以外（保持上限で消えた境界行）は snapshot 自身の置き換え情報で代用する
      const next = snapshots[index + 1]
      const useCreation = next === undefined && snapshot.node_version === 1 && currentNode != null
      const authoredAt = useCreation
        ? currentNode.created_at
        : next?.created_at ?? snapshot.created_at
      const actorUserId = useCreation
        ? currentNode.created_by_user_id
        : next?.user_id ?? snapshot.user_id
      const actorClientId = useCreation ? null : next?.client_id ?? snapshot.client_id
      const actor = actorUserId == null ? undefined : actorMap.get(actorUserId)
      return {
        node_version: snapshot.node_version,
        authored_at: authoredAt,
        actor: {
          user_id: actorUserId,
          display_name: actor?.display_name ?? null,
          email: actor?.email ?? null,
          client_name: actorClientId == null ? null : clientMap.get(actorClientId) ?? null,
        },
      }
    })
    const total = await countNodeSnapshots(c.env.DB, nodeId)
    const current = currentNode == null ? null : {
      version: currentNode.version,
      updated_at: currentNode.updated_at,
      actor: {
        user_id: currentNode.updated_by_user_id,
        display_name: currentNode.updated_by_display_name ?? null,
        email: currentNode.updated_by_email ?? null,
        client_name: currentNode.updated_by_client_id == null
          ? null
          : clientMap.get(currentNode.updated_by_client_id) ?? null,
      },
    }
    return c.json({ success: true, current, current_version: currentNode?.version ?? null, total, limit, returned: items.length, items })
  } catch (error) {
    console.error('Failed to get node history:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Get one saved content snapshot for preview.
app.get('/api/trees/:tree_id/nodes/:id/history/:node_version', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const nodePublicId = c.req.param('id')
    const nodeVersion = Number(c.req.param('node_version'))
    if (isNaN(treeId) || !isValidPublicNodeId(nodePublicId) || !Number.isInteger(nodeVersion) || nodeVersion < 1) {
      return c.json({ success: false, error: 'Invalid tree ID, node ID or node version' }, 400)
    }
    const hasAccess = await canViewTree(c.env.DB, treeId, user.user_id)
    if (!hasAccess) return c.json({ success: false, error: 'Access denied' }, 403)
    const nodeId = await resolvePublicNodeId(c.env.DB, treeId, nodePublicId)
    if (!nodeId) return c.json({ success: false, error: 'Node not found' }, 404)
    const snapshot = await c.env.DB.prepare(
      'SELECT node_version, content FROM node_snapshots WHERE node_id = ? AND node_version = ? ORDER BY id DESC LIMIT 1'
    ).bind(nodeId, nodeVersion).first<{ node_version: number; content: string | null }>()
    if (!snapshot) return c.json({ success: false, error: 'Snapshot version not found' }, 404)
    return c.json({ success: true, data: snapshot })
  } catch (error) {
    console.error('Failed to get node history version:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Restore content by snapshot version. Requests without the history restore JSON
// body continue to the existing trash restore route with the same URL.
// content の版指定復元。ゴミ箱からの復元（POST /nodes/:id/restore）とは
// 別パスにする。同じ URL に同居させて body の有無で振り分けると、フィールド名の
// 変更やリクエストの取りこぼしが「ノードをゴミ箱から戻す」という別操作に化ける
app.post('/api/trees/:tree_id/nodes/:id/history/:node_version/restore', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const nodePublicId = c.req.param('id')
    const nodeVersionRaw = c.req.param('node_version')
    const nodeVersion = /^[0-9]+$/.test(nodeVersionRaw) ? parseInt(nodeVersionRaw, 10) : NaN
    const body = await c.req.json().catch(() => ({} as any))
    const ifVersion = body?.if_version
    if (isNaN(treeId) || !isValidPublicNodeId(nodePublicId)) {
      return c.json({ success: false, error: 'Invalid tree ID or node ID' }, 400)
    }
    if (!Number.isInteger(nodeVersion) || nodeVersion < 1) {
      return c.json({ success: false, error: 'node_version must be a positive integer' }, 400)
    }
    if (!Number.isInteger(ifVersion) || ifVersion < 1) {
      return c.json({ success: false, error: 'if_version is required and must be a positive integer' }, 400)
    }
    const canEdit = await canEditTree(c.env.DB, treeId, user.user_id)
    if (!canEdit) return c.json({ success: false, error: 'You do not have permission to edit this tree' }, 403)
    const nodeId = await resolvePublicNodeId(c.env.DB, treeId, nodePublicId)
    if (!nodeId) return c.json({ success: false, error: 'Node not found' }, 404)
    const existing = await c.env.DB.prepare(
      `SELECT n.public_id AS id, n.tree_id, n.title, n.content, n.author_user_id,
              n.created_by_user_id, n.updated_by_user_id, n.version,
              n.created_at, n.updated_at, n.child_sort_mode, n.child_sort_direction, n.deleted_at,
              u_author.display_name AS author_display_name, u_author.email AS author_email
       FROM nodes n LEFT JOIN users u_author ON n.author_user_id = u_author.id
       WHERE n.id = ? AND n.tree_id = ?`
    ).bind(nodeId, treeId).first<any>()
    if (!existing) return c.json({ success: false, error: 'Node not found' }, 404)
    if (existing.version !== ifVersion) {
      return c.json({ success: false, error: 'Version conflict', current_version: existing.version, server_data: existing }, 409)
    }
    const snapshot = await c.env.DB.prepare(
      'SELECT content FROM node_snapshots WHERE node_id = ? AND node_version = ? ORDER BY id DESC LIMIT 1'
    ).bind(nodeId, nodeVersion).first<{ content: string | null }>()
    if (!snapshot) return c.json({ success: false, error: 'Snapshot version not found' }, 404)
    const writes = await c.env.DB.batch([
      nodeSnapshotInsertStatement(c.env.DB, {
        nodeId, content: existing.content, nodeVersion: existing.version,
        userId: user.user_id, source: 'ui', clientId: null,
      }),
      c.env.DB.prepare(
        `UPDATE nodes SET content = ?, updated_by_user_id = ?, updated_by_client_id = NULL, version = version + 1,
           updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tree_id = ? AND version = ?
         RETURNING version, updated_at`
      ).bind(snapshot.content, user.user_id, nodeId, treeId, ifVersion),
    ])
    const updated = writes[1].results?.[0] as { version: number; updated_at: string } | undefined
    if (!updated) return c.json({ success: false, error: 'Version conflict' }, 409)
    const ctxRestore = (c as any).executionCtx
    await schedulePurgeNodeSnapshots(c.env.DB, nodeId, ctxRestore?.waitUntil?.bind(ctxRestore))
    if (ctxRestore?.waitUntil) ctxRestore.waitUntil(upsertNodeVector(c.env.AI, c.env.VECTORIZE, c.env.DB, nodeId))
    logAuditFromContext(c, { userId: user.user_id, action: 'node.restore_content', targetType: 'node', targetId: nodeId, treeId })
    return c.json({ success: true, data: { ...updated, content: snapshot.content } })
  } catch (error) {
    console.error('Failed to restore node content:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Get child nodes (using relation table)
app.get('/api/trees/:tree_id/nodes/:id/children', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const nodePublicId = c.req.param('id')

    if (isNaN(treeId) || !isValidPublicNodeId(nodePublicId)) {
      return c.json({ success: false, error: 'Invalid tree ID or node ID' }, 400)
    }

    // 列挙対策: ノード解決より先にツリーアクセスを検査し、非メンバーが
    // ノードの存在/非存在を 403/404 の差で区別できないようにする
    const hasAccess = await canViewTree(c.env.DB, treeId, user.user_id)
    if (!hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403)
    }

    const nodeId = await resolvePublicNodeId(c.env.DB, treeId, nodePublicId)
    if (!nodeId) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    const { results } = await c.env.DB.prepare(
      `SELECT n.public_id AS id, n.tree_id, n.title, n.content, n.author_user_id,
              n.created_by_user_id, n.updated_by_user_id, n.version,
              n.created_at, n.updated_at, n.child_sort_mode, n.child_sort_direction, n.deleted_at,
              u_author.display_name AS author_display_name, u_author.email AS author_email,
              nr.relation_type_id, rt.name AS relation_type_name
       FROM nodes n
       INNER JOIN node_relations nr ON n.id = nr.child_node_id
       LEFT JOIN relation_types rt ON nr.relation_type_id = rt.id
       LEFT JOIN users u_author ON n.author_user_id = u_author.id
       WHERE nr.parent_node_id = ? AND n.tree_id = ?
       ORDER BY nr.position, n.created_at`
    )
      .bind(nodeId, treeId)
      .all()

    return c.json({ success: true, data: results })
  } catch (error) {
    console.error('Failed to get child nodes:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Get parent nodes (multi-parent support)
app.get('/api/trees/:tree_id/nodes/:id/parents', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const nodePublicId = c.req.param('id')

    if (isNaN(treeId) || !isValidPublicNodeId(nodePublicId)) {
      return c.json({ success: false, error: 'Invalid tree ID or node ID' }, 400)
    }

    // 列挙対策: ノード解決より先にツリーアクセスを検査し、非メンバーが
    // ノードの存在/非存在を 403/404 の差で区別できないようにする
    const hasAccess = await canViewTree(c.env.DB, treeId, user.user_id)
    if (!hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403)
    }

    const nodeId = await resolvePublicNodeId(c.env.DB, treeId, nodePublicId)
    if (!nodeId) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    const { results } = await c.env.DB.prepare(
      `SELECT n.public_id AS id, n.tree_id, n.title, n.content, n.author_user_id,
              n.created_by_user_id, n.updated_by_user_id, n.version,
              n.created_at, n.updated_at, n.child_sort_mode, n.child_sort_direction, n.deleted_at,
              u_author.display_name AS author_display_name, u_author.email AS author_email,
              nr.relation_type_id, rt.name AS relation_type_name
       FROM nodes n
       INNER JOIN node_relations nr ON n.id = nr.parent_node_id
       LEFT JOIN relation_types rt ON nr.relation_type_id = rt.id
       LEFT JOIN users u_author ON n.author_user_id = u_author.id
       WHERE nr.child_node_id = ? AND n.tree_id = ?
       ORDER BY n.created_at`
    )
      .bind(nodeId, treeId)
      .all()

    return c.json({ success: true, data: results })
  } catch (error) {
    console.error('Failed to get parent nodes:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Get all relations in a tree
app.get('/api/trees/:tree_id/relations', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))

    if (isNaN(treeId)) {
      return c.json({ success: false, error: 'Invalid tree ID' }, 400)
    }

    // Check if user has access to this tree
    const hasAccess = await canViewTree(c.env.DB, treeId, user.user_id)
    if (!hasAccess) {
      return c.json({ success: false, error: 'Access denied' }, 403)
    }

    // Get all relations for nodes in this tree
    const { results } = await c.env.DB.prepare(
      `SELECT parent.public_id AS parent_node_id, child.public_id AS child_node_id,
              nr.position, nr.relation_type_id, rt.name AS relation_type_name, rt.icon_type AS relation_icon_type
       FROM node_relations nr
       JOIN nodes parent ON parent.id = nr.parent_node_id
       JOIN nodes child ON child.id = nr.child_node_id
       LEFT JOIN relation_types rt ON nr.relation_type_id = rt.id
       WHERE parent.tree_id = ?
       ORDER BY nr.parent_node_id, nr.position`
    )
      .bind(treeId)
      .all()

    return c.json({ success: true, data: results })
  } catch (error) {
    console.error('Failed to get relations:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Create a node in a tree
app.post('/api/trees/:tree_id/nodes', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))

    if (isNaN(treeId)) {
      return c.json({ success: false, error: 'Invalid tree ID' }, 400)
    }

    if (requestBodyIsTooLarge(c.req.header('content-length'))) {
      return c.json({ success: false, error: 'Request body is too large' }, 413)
    }
    const body = await c.req.json()
    const { title, content, author_user_id } = body

    if (!author_user_id) {
      return c.json({ success: false, error: 'Title and author_user_id are required' }, 400)
    }
    const validTitle = validateTextLimit(title, 'Node title', NODE_TITLE_MAX_LENGTH, { required: true, trim: true })
    if (!validTitle.ok) return c.json({ success: false, error: validTitle.error }, 400)
    const validContent = validateTextLimit(content ?? '', 'Node content', NODE_CONTENT_MAX_LENGTH)
    if (!validContent.ok) return c.json({ success: false, error: validContent.error }, 400)

    // RT1: 権限チェック + author検証(+display_name/email取得) を一括
    const checkResults = await c.env.DB.batch([
      c.env.DB.prepare('SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ?')
        .bind(treeId, user.user_id),
      c.env.DB.prepare(
        `SELECT u.display_name, u.email FROM users u
         JOIN tree_members tm ON tm.user_id = u.id
         WHERE u.id = ? AND tm.tree_id = ? AND tm.role IN ('owner', 'editor')`
      ).bind(author_user_id, treeId),
    ])

    const roleRow = checkResults[0].results[0] as { role: string } | undefined
    if (!roleRow || (roleRow.role !== 'owner' && roleRow.role !== 'editor')) {
      return c.json({ success: false, error: 'You do not have permission to edit this tree' }, 403)
    }

    const authorRow = checkResults[1].results[0] as { display_name: string; email: string } | undefined
    if (!authorRow) {
      return c.json({ success: false, error: 'Invalid author: user is not an editor/owner of this tree' }, 400)
    }

    await assertNodeQuota(c.env.DB, treeId, 1)

    // RT2: INSERT ... RETURNING public DTO columns
    const result = await withPublicIdRetry(async (publicId) => {
      const batch = await c.env.DB.batch([
        c.env.DB.prepare(
        `INSERT INTO nodes (tree_id, title, content, author_user_id, created_by_user_id, updated_by_user_id, public_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id, public_id, tree_id, title, content, author_user_id,
                   created_by_user_id, updated_by_user_id, version,
                   created_at, updated_at, child_sort_mode, child_sort_direction, deleted_at`
        ).bind(treeId, validTitle.value, validContent.value, author_user_id, user.user_id, user.user_id, publicId),
        c.env.DB.prepare('UPDATE trees SET node_count = node_count + 1 WHERE id = ?').bind(treeId),
      ])
      return batch[0].results[0]
    })

    const { id: createdInternalId, public_id: createdPublicId, ...nodeDto } = result as any

    // authorRow からdisplay_name/emailをマージ（re-fetch不要）
    const ctx = (c as any).executionCtx
    if (ctx?.waitUntil) {
      ctx.waitUntil(upsertNodeVector(c.env.AI, c.env.VECTORIZE, c.env.DB, createdInternalId))
    }
    logAuditFromContext(c, { userId: user.user_id, action: 'node.create', targetType: 'node', targetId: createdInternalId, treeId })
    return c.json({
      success: true, data: {
        ...nodeDto,
        id: createdPublicId,
        author_display_name: authorRow.display_name,
        author_email: authorRow.email
      }
    }, 201)
  } catch (error) {
    if (error instanceof QuotaExceededError) return c.json({ success: false, error: 'Node quota exceeded' }, 409)
    console.error('Failed to create node:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Create a node and attach it to a parent in one request
app.post('/api/trees/:tree_id/nodes/with-parent', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))

    if (isNaN(treeId)) {
      return c.json({ success: false, error: 'Invalid tree ID' }, 400)
    }

    if (requestBodyIsTooLarge(c.req.header('content-length'))) {
      return c.json({ success: false, error: 'Request body is too large' }, 413)
    }
    const body = await c.req.json()
    const { title, content, author_user_id, parent_node_id: parentNodePublicId } = body

    if (!author_user_id || !parentNodePublicId) {
      return c.json({ success: false, error: 'title, author_user_id, and parent_node_id are required' }, 400)
    }
    const validTitle = validateTextLimit(title, 'Node title', NODE_TITLE_MAX_LENGTH, { required: true, trim: true })
    if (!validTitle.ok) return c.json({ success: false, error: validTitle.error }, 400)
    const validContent = validateTextLimit(content ?? '', 'Node content', NODE_CONTENT_MAX_LENGTH)
    if (!validContent.ok) return c.json({ success: false, error: validContent.error }, 400)
    if (!isValidPublicNodeId(parentNodePublicId)) {
      return c.json({ success: false, error: 'Invalid parent_node_id' }, 400)
    }

    const parentNodeId = await resolvePublicNodeId(c.env.DB, treeId, String(parentNodePublicId))
    if (!parentNodeId) {
      return c.json({ success: false, error: 'Parent node not found' }, 404)
    }

    const checkResults = await c.env.DB.batch([
      c.env.DB.prepare('SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ?')
        .bind(treeId, user.user_id),
      c.env.DB.prepare(
        `SELECT u.display_name, u.email FROM users u
         JOIN tree_members tm ON tm.user_id = u.id
         WHERE u.id = ? AND tm.tree_id = ? AND tm.role IN ('owner', 'editor')`
      ).bind(author_user_id, treeId),
      c.env.DB.prepare('SELECT tree_id FROM nodes WHERE id = ?').bind(parentNodeId),
    ])

    const roleRow = checkResults[0].results[0] as { role: string } | undefined
    if (!roleRow || (roleRow.role !== 'owner' && roleRow.role !== 'editor')) {
      return c.json({ success: false, error: 'You do not have permission to edit this tree' }, 403)
    }

    const authorRow = checkResults[1].results[0] as { display_name: string; email: string } | undefined
    if (!authorRow) {
      return c.json({ success: false, error: 'Invalid author: user is not an editor/owner of this tree' }, 400)
    }

    const parentRow = checkResults[2].results[0] as { tree_id: number } | undefined
    if (!parentRow || parentRow.tree_id !== treeId) {
      return c.json({ success: false, error: 'Parent node not found in this tree' }, 404)
    }

    await assertNodeQuota(c.env.DB, treeId, 1)

    const createdNode = await withPublicIdRetry(async (publicId) => {
      const batch = await c.env.DB.batch([
        c.env.DB.prepare(
        `INSERT INTO nodes (tree_id, title, content, author_user_id, created_by_user_id, updated_by_user_id, public_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id, public_id, tree_id, title, content, author_user_id,
                   created_by_user_id, updated_by_user_id, version,
                   created_at, updated_at, child_sort_mode, child_sort_direction, deleted_at`
        ).bind(treeId, validTitle.value, validContent.value, author_user_id, user.user_id, user.user_id, publicId),
        c.env.DB.prepare('UPDATE trees SET node_count = node_count + 1 WHERE id = ?').bind(treeId),
      ])
      return batch[0].results[0]
    })

    if (!createdNode) {
      return c.json({ success: false, error: 'Failed to create node' }, 500)
    }

    const createdInternalId = createdNode.id as number
    const createdPublicId = createdNode.public_id as string

    const createdRelationInternal = await c.env.DB.prepare(
      `INSERT INTO node_relations (parent_node_id, child_node_id, position)
       VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM node_relations WHERE parent_node_id = ?))`
    )
      .bind(parentNodeId, createdInternalId, parentNodeId)
      .run()

    const ctxWP = (c as any).executionCtx
    if (ctxWP?.waitUntil) {
      ctxWP.waitUntil(upsertNodeVector(c.env.AI, c.env.VECTORIZE, c.env.DB, createdInternalId))
    }

    const { id: _createdInternalId2, public_id: _createdPublicId2, ...createdNodeRest } = createdNode
    const publicCreatedNode = {
      ...createdNodeRest,
      id: createdPublicId,
      author_display_name: authorRow.display_name,
      author_email: authorRow.email
    }
    const publicRelation = await c.env.DB.prepare(
      `SELECT parent.public_id AS parent_node_id, child.public_id AS child_node_id,
              nr.position, nr.relation_type_id, rt.name AS relation_type_name, rt.icon_type AS relation_icon_type
       FROM node_relations nr
       JOIN nodes parent ON parent.id = nr.parent_node_id
       JOIN nodes child ON child.id = nr.child_node_id
       LEFT JOIN relation_types rt ON nr.relation_type_id = rt.id
       WHERE nr.parent_node_id = ? AND nr.child_node_id = ?`
    ).bind(parentNodeId, createdInternalId).first()

    logAuditFromContext(c, { userId: user.user_id, action: 'node.create', targetType: 'node', targetId: createdInternalId, treeId })
    return c.json({
      success: true,
      data: {
        node: publicCreatedNode,
        relation: publicRelation
      }
    }, 201)
  } catch (error) {
    if (error instanceof QuotaExceededError) return c.json({ success: false, error: 'Node quota exceeded' }, 409)
    console.error('Failed to create node with parent:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Duplicate a node (content + optional images) and attach it to a parent
app.post('/api/trees/:tree_id/nodes/:id/duplicate', authMiddleware, async (c) => {
  const copiedImageR2Keys: string[] = []
  let duplicatedNodeId: number | null = null
  let safeTreeIdForCleanup: number | null = null

  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const sourceNodePublicId = c.req.param('id')

    if (isNaN(treeId) || !isValidPublicNodeId(sourceNodePublicId)) {
      return c.json({ success: false, error: 'Invalid tree ID or node ID' }, 400)
    }
    safeTreeIdForCleanup = treeId

    const body = await c.req.json()
    const parentNodePublicId = body.parent_node_id
    const titleRaw = body.title
    const copyImagesRaw = body.copy_images
    const copyImages = copyImagesRaw === undefined ? true : copyImagesRaw

    if (!isValidPublicNodeId(parentNodePublicId)) {
      return c.json({ success: false, error: 'parent_node_id is required' }, 400)
    }
    if (copyImagesRaw !== undefined && typeof copyImagesRaw !== 'boolean') {
      return c.json({ success: false, error: 'copy_images must be a boolean' }, 400)
    }
    if (titleRaw !== undefined && typeof titleRaw !== 'string') {
      return c.json({ success: false, error: 'title must be a string' }, 400)
    }

    const sourceNodeId = await resolvePublicNodeId(c.env.DB, treeId, sourceNodePublicId)
    const parentNodeId = await resolvePublicNodeId(c.env.DB, treeId, String(parentNodePublicId))
    if (!sourceNodeId) {
      return c.json({ success: false, error: 'Source node not found in this tree' }, 404)
    }
    if (!parentNodeId) {
      return c.json({ success: false, error: 'Parent node not found' }, 404)
    }

    const checkResults = await c.env.DB.batch([
      c.env.DB.prepare('SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ?').bind(treeId, user.user_id),
      c.env.DB.prepare(
        `SELECT n.public_id AS id, n.tree_id, n.title, n.content, n.author_user_id,
                n.created_by_user_id, n.updated_by_user_id, n.version,
                n.created_at, n.updated_at, n.child_sort_mode, n.child_sort_direction, n.deleted_at,
                u_author.display_name AS author_display_name, u_author.email AS author_email
         FROM nodes n
         LEFT JOIN users u_author ON n.author_user_id = u_author.id
         WHERE n.id = ? AND n.tree_id = ?`
      ).bind(sourceNodeId, treeId),
      c.env.DB.prepare('SELECT tree_id FROM nodes WHERE id = ?').bind(parentNodeId),
      c.env.DB.prepare('SELECT relation_type_id FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?')
        .bind(parentNodeId, sourceNodeId),
      c.env.DB.prepare('SELECT display_name, email FROM users WHERE id = ?').bind(user.user_id),
    ])

    const roleRow = checkResults[0].results[0] as { role: string } | undefined
    if (!roleRow || (roleRow.role !== 'owner' && roleRow.role !== 'editor')) {
      return c.json({ success: false, error: 'You do not have permission to edit this tree' }, 403)
    }

    const sourceNode = checkResults[1].results[0] as any
    if (!sourceNode) {
      return c.json({ success: false, error: 'Source node not found in this tree' }, 404)
    }

    const parentRow = checkResults[2].results[0] as { tree_id: number } | undefined
    if (!parentRow || parentRow.tree_id !== treeId) {
      return c.json({ success: false, error: 'Parent node not found in this tree' }, 404)
    }

    const sourceRelationRow = checkResults[3].results[0] as { relation_type_id: number } | undefined
    if (!sourceRelationRow) {
      return c.json({ success: false, error: 'Source relation not found for this parent' }, 404)
    }
    const sourceRelationTypeId = Number(sourceRelationRow.relation_type_id) || 1
    await assertNodeQuota(c.env.DB, treeId, 1)

    const actorRow = checkResults[4].results[0] as { display_name: string; email: string } | undefined
    const locale = resolveLocaleFromRequest(getCookie(c, 'lang'), c.req.header('accept-language'))
    const duplicatedTitle = String(titleRaw || '').trim()
      || serverT(locale, 'editor.duplicateSuffix', { title: sourceNode.title })

    const createdNode = await withPublicIdRetry(async (publicId) => {
      const batch = await c.env.DB.batch([
        c.env.DB.prepare(
        `INSERT INTO nodes (tree_id, title, content, author_user_id, created_by_user_id, updated_by_user_id, public_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id, public_id, tree_id, title, content, author_user_id,
                   created_by_user_id, updated_by_user_id, version,
                   created_at, updated_at, child_sort_mode, child_sort_direction, deleted_at`
        ).bind(treeId, duplicatedTitle, sourceNode.content || '', user.user_id, user.user_id, user.user_id, publicId),
        c.env.DB.prepare('UPDATE trees SET node_count = node_count + 1 WHERE id = ?').bind(treeId),
      ])
      return batch[0].results[0]
    })

    if (!createdNode) {
      return c.json({ success: false, error: 'Failed to create duplicated node' }, 500)
    }
    duplicatedNodeId = Number(createdNode.id)
    const duplicatedPublicId = createdNode.public_id as string

    const relationInsert = await c.env.DB.prepare(
      `INSERT INTO node_relations (parent_node_id, child_node_id, position, relation_type_id)
       VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM node_relations WHERE parent_node_id = ?), ?)`
    )
      .bind(parentNodeId, duplicatedNodeId, parentNodeId, sourceRelationTypeId)
      .run()

    if (relationInsert.meta.changes === 0) {
      throw new Error('Failed to create duplicated relation')
    }

    let copiedImagesCount = 0
    if (copyImages) {
      const sourceImages = await c.env.DB.prepare(
        `SELECT id, serial_no, file_name, file_ext, mime_type, file_size, r2_key
         FROM node_images
         WHERE tree_id = ? AND node_id = ?
         ORDER BY serial_no ASC`
      )
        .bind(treeId, sourceNodeId)
        .all<DuplicateSourceImageRow>()

      const mappings = await copyImagesForDuplicatedNode(
        c.env.DB,
        c.env.NODE_IMAGES,
        treeId,
        sourceNodeId,
        duplicatedNodeId,
        sourceNodePublicId,
        createdNode.id,
        sourceImages.results || [],
        user.user_id,
      )
      copiedImagesCount = mappings.length
      copiedImageR2Keys.push(...mappings.map(m => m.r2Key))

      if (mappings.length > 0) {
        const replacedContent = replaceDuplicateImageUrls(sourceNode.content || '', mappings)
        await c.env.DB.prepare(
          `UPDATE nodes
           SET content = ?, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP, version = version + 1
           WHERE id = ? AND tree_id = ?`
        )
          .bind(replacedContent, user.user_id, duplicatedNodeId, treeId)
          .run()
        createdNode.content = replacedContent
      }
    }

    const relationWithType = await c.env.DB.prepare(
      `SELECT parent.public_id AS parent_node_id, child.public_id AS child_node_id,
              nr.position, nr.relation_type_id, rt.name AS relation_type_name, rt.icon_type AS relation_icon_type
       FROM node_relations nr
       JOIN nodes parent ON parent.id = nr.parent_node_id
       JOIN nodes child ON child.id = nr.child_node_id
       LEFT JOIN relation_types rt ON nr.relation_type_id = rt.id
       WHERE nr.parent_node_id = ? AND nr.child_node_id = ?`
    )
      .bind(parentNodeId, duplicatedNodeId)
      .first<any>()

    const { id: _duplicatedInternalId, public_id: _duplicatedPublicId, ...duplicatedNodeRest } = createdNode
    const publicCreatedNode = {
      ...duplicatedNodeRest,
      id: duplicatedPublicId,
      author_display_name: actorRow?.display_name || null,
      author_email: actorRow?.email || null,
    }
    const publicRelation = relationWithType

    logAuditFromContext(c, { userId: user.user_id, action: 'node.duplicate', targetType: 'node', targetId: sourceNodeId, treeId })
    return c.json({
      success: true,
      data: {
        node: publicCreatedNode,
        relation: publicRelation,
        copied_images_count: copiedImagesCount,
        skipped_images_count: 0,
      }
    }, 201)
  } catch (error) {
    if (error instanceof QuotaExceededError) return c.json({ success: false, error: 'Node quota exceeded' }, 409)
    console.error('Failed to duplicate node:', error)
    if (safeTreeIdForCleanup !== null) {
      await cleanupDuplicatedNodeFailure(c.env, safeTreeIdForCleanup, duplicatedNodeId, copiedImageR2Keys)
    }
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Update a node in a tree
app.put('/api/trees/:tree_id/nodes/:id', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const nodePublicId = c.req.param('id')

    if (isNaN(treeId) || !isValidPublicNodeId(nodePublicId)) {
      return c.json({ success: false, error: 'Invalid tree ID or node ID' }, 400)
    }

    const nodeId = await resolvePublicNodeId(c.env.DB, treeId, nodePublicId)
    if (!nodeId) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    if (requestBodyIsTooLarge(c.req.header('content-length'))) {
      return c.json({ success: false, error: 'Request body is too large' }, 413)
    }
    const body = await c.req.json()
    const { title, content, author_user_id, version: clientVersion } = body
    let normalizedTitle = title
    if (title !== undefined) {
      const validTitle = validateTextLimit(title, 'Node title', NODE_TITLE_MAX_LENGTH, { required: true, trim: true })
      if (!validTitle.ok) return c.json({ success: false, error: validTitle.error }, 400)
      normalizedTitle = validTitle.value
    }
    if (content !== undefined) {
      const validContent = validateTextLimit(content, 'Node content', NODE_CONTENT_MAX_LENGTH)
      if (!validContent.ok) return c.json({ success: false, error: validContent.error }, 400)
    }

    // RT1: 権限 + 既存ノード（author JOIN付き）+ author検証（条件付き）を一括
    const checkStmts: D1PreparedStatement[] = [
      // [0] 権限チェック
      c.env.DB.prepare('SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ?')
        .bind(treeId, user.user_id),
      // [1] 既存ノード取得（author JOIN付き → 競合時レスポンスにもそのまま使える）
      c.env.DB.prepare(
        `SELECT n.public_id AS id, n.tree_id, n.title, n.content, n.author_user_id,
                n.created_by_user_id, n.updated_by_user_id, n.version,
                n.created_at, n.updated_at, n.child_sort_mode, n.child_sort_direction, n.deleted_at,
                u_author.display_name AS author_display_name, u_author.email AS author_email
         FROM nodes n LEFT JOIN users u_author ON n.author_user_id = u_author.id
         WHERE n.id = ? AND n.tree_id = ?`
      ).bind(nodeId, treeId),
    ]
    if (author_user_id !== undefined) {
      // [2] author検証
      checkStmts.push(
        c.env.DB.prepare(
          `SELECT 1 FROM users u
           JOIN tree_members tm ON tm.user_id = u.id
           WHERE u.id = ? AND tm.tree_id = ? AND tm.role IN ('owner', 'editor')`
        ).bind(author_user_id, treeId)
      )
    }
    const checkResults = await c.env.DB.batch(checkStmts)

    // 権限チェック
    const roleRow = checkResults[0].results[0] as { role: string } | undefined
    if (!roleRow || (roleRow.role !== 'owner' && roleRow.role !== 'editor')) {
      return c.json({ success: false, error: 'You do not have permission to edit this tree' }, 403)
    }

    // ノード存在チェック
    const existing = checkResults[1].results[0] as any
    if (!existing) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    // Optimistic locking: バージョン競合チェック（author情報は既にRT1で取得済み）
    if (clientVersion !== undefined) {
      const currentVersion = existing.version || 1
      if (clientVersion !== currentVersion) {
        return c.json(
          {
            success: false,
            error: 'Version conflict',
            message: 'This node has been modified by another user. Please refresh and try again.',
            current_version: currentVersion,
            server_data: existing
          },
          409
        )
      }
    }

    // author検証結果チェック
    if (author_user_id !== undefined) {
      const authorRow = checkResults[2].results[0]
      if (!authorRow) {
        return c.json({ success: false, error: 'Invalid author: user is not an editor/owner of this tree' }, 400)
      }
    }

    // RT2: UPDATE + re-fetch を一括batch
    const newVersion = (existing.version || 1) + 1
    // content が実際に変わるときだけスナップショットを積む。
    // UPDATE と同じ batch に入れることで、片方だけ成功する状態を作らない
    const takesSnapshot = content !== undefined && content !== existing.content
    const writeResults = await c.env.DB.batch([
      ...(takesSnapshot
        ? [nodeSnapshotInsertStatement(c.env.DB, {
            nodeId,
            content: existing.content,
            nodeVersion: existing.version || 1,
            userId: user.user_id,
            source: 'ui' as const,
            clientId: null,
          })]
        : []),
      c.env.DB.prepare(
        `UPDATE nodes
         SET title = ?, content = ?, author_user_id = ?, updated_by_user_id = ?, updated_by_client_id = NULL, version = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND tree_id = ?`
      ).bind(
        normalizedTitle !== undefined ? normalizedTitle : existing.title,
        content !== undefined ? content : existing.content,
        author_user_id !== undefined ? author_user_id : existing.author_user_id,
        user.user_id,
        newVersion,
        nodeId,
        treeId
      ),
      c.env.DB.prepare(
        `SELECT n.public_id AS id, n.tree_id, n.title, n.content, n.author_user_id,
                n.created_by_user_id, n.updated_by_user_id, n.version,
                n.created_at, n.updated_at, n.child_sort_mode, n.child_sort_direction, n.deleted_at,
                u_author.display_name AS author_display_name, u_author.email AS author_email
         FROM nodes n LEFT JOIN users u_author ON n.author_user_id = u_author.id
         WHERE n.id = ? AND n.tree_id = ?`
      ).bind(nodeId, treeId),
    ])

    // スナップショットを積んだ場合は batch の先頭がその INSERT なので添字がずれる
    const updated = writeResults[takesSnapshot ? 2 : 1].results[0]

    const ctxPut = (c as any).executionCtx
    if (takesSnapshot) {
      // purge は正しさに関わらないので waitUntil があれば応答をブロックしない。
      // 無い環境では await する（`void promise` では走らず上限が効かない）
      await schedulePurgeNodeSnapshots(c.env.DB, nodeId, ctxPut?.waitUntil?.bind(ctxPut))
    }
    if (ctxPut?.waitUntil) {
      ctxPut.waitUntil(upsertNodeVector(c.env.AI, c.env.VECTORIZE, c.env.DB, nodeId))
    }
    logAuditFromContext(c, { userId: user.user_id, action: 'node.update', targetType: 'node', targetId: nodeId, treeId })
    return c.json({ success: true, data: updated })
  } catch (error) {
    console.error('Failed to update node:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Update child sort settings for a node (used as parent sort preference)
app.patch('/api/trees/:tree_id/nodes/:id/sort-settings', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const nodePublicId = c.req.param('id')

    if (isNaN(treeId) || !isValidPublicNodeId(nodePublicId)) {
      return c.json({ success: false, error: 'Invalid tree ID or node ID' }, 400)
    }

    const nodeId = await resolvePublicNodeId(c.env.DB, treeId, nodePublicId)
    if (!nodeId) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    const body = await c.req.json()
    const { child_sort_mode, child_sort_direction } = body

    if (child_sort_mode === undefined && child_sort_direction === undefined) {
      return c.json({ success: false, error: 'child_sort_mode or child_sort_direction is required' }, 400)
    }

    const validModes = ['manual', 'created_at', 'updated_at', 'title']
    const validDirections = ['asc', 'desc']

    if (child_sort_mode !== undefined && !validModes.includes(child_sort_mode)) {
      return c.json({ success: false, error: 'Invalid child_sort_mode' }, 400)
    }
    if (child_sort_direction !== undefined && !validDirections.includes(child_sort_direction)) {
      return c.json({ success: false, error: 'Invalid child_sort_direction' }, 400)
    }

    const checkResults = await c.env.DB.batch([
      c.env.DB.prepare('SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ?')
        .bind(treeId, user.user_id),
      c.env.DB.prepare('SELECT * FROM nodes WHERE id = ? AND tree_id = ?')
        .bind(nodeId, treeId),
    ])

    const roleRow = checkResults[0].results[0] as { role: string } | undefined
    if (!roleRow || (roleRow.role !== 'owner' && roleRow.role !== 'editor')) {
      return c.json({ success: false, error: 'You do not have permission to edit this tree' }, 403)
    }

    const existing = checkResults[1].results[0] as any
    if (!existing) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    const nextMode = child_sort_mode !== undefined ? child_sort_mode : (existing.child_sort_mode || 'manual')
    const nextDirection = child_sort_direction !== undefined ? child_sort_direction : (existing.child_sort_direction || 'asc')

    const writeResults = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE nodes
         SET child_sort_mode = ?, child_sort_direction = ?, updated_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND tree_id = ?`
      ).bind(nextMode, nextDirection, user.user_id, nodeId, treeId),
      c.env.DB.prepare(
        `SELECT n.public_id AS id, n.tree_id, n.title, n.content, n.author_user_id,
                n.created_by_user_id, n.updated_by_user_id, n.version,
                n.created_at, n.updated_at, n.child_sort_mode, n.child_sort_direction, n.deleted_at,
                u_author.display_name AS author_display_name, u_author.email AS author_email
         FROM nodes n LEFT JOIN users u_author ON n.author_user_id = u_author.id
         WHERE n.id = ? AND n.tree_id = ?`
      ).bind(nodeId, treeId),
    ])

    const updated = writeResults[1].results[0]
    return c.json({ success: true, data: updated })
  } catch (error) {
    console.error('Failed to update node sort settings:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Delete a node in a tree
app.delete('/api/trees/:tree_id/nodes/:id', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const nodePublicId = c.req.param('id')

    if (isNaN(treeId) || !isValidPublicNodeId(nodePublicId)) {
      return c.json({ success: false, error: 'Invalid tree ID or node ID' }, 400)
    }

    const nodeId = await resolvePublicNodeId(c.env.DB, treeId, nodePublicId)
    if (!nodeId) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    // RT1: 権限チェック + root/trash root + ノード存在確認
    const checkResults = await c.env.DB.batch([
      c.env.DB.prepare('SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ?')
        .bind(treeId, user.user_id),
      c.env.DB.prepare('SELECT root_node_id, trash_root_node_id FROM trees WHERE id = ?')
        .bind(treeId),
      c.env.DB.prepare('SELECT id FROM nodes WHERE id = ? AND tree_id = ?')
        .bind(nodeId, treeId),
    ])

    const roleRow = checkResults[0].results[0] as { role: string } | undefined
    if (!roleRow || (roleRow.role !== 'owner' && roleRow.role !== 'editor')) {
      return c.json({ success: false, error: 'You do not have permission to edit this tree' }, 403)
    }

    const treeRow = checkResults[1].results[0] as { root_node_id: number; trash_root_node_id: number | null } | undefined
    const nodeRow = checkResults[2].results[0] as { id: number } | undefined
    if (!nodeRow) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }
    if (!treeRow?.trash_root_node_id) {
      return c.json({ success: false, error: 'Trash root node is not configured' }, 500)
    }
    if (nodeId === treeRow.root_node_id || nodeId === treeRow.trash_root_node_id) {
      return c.json({ success: false, error: 'Root node cannot be deleted' }, 403)
    }

    const trashRootId = treeRow.trash_root_node_id
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM node_relations WHERE child_node_id = ?').bind(nodeId),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO node_relations (parent_node_id, child_node_id, position, relation_type_id)
         VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM node_relations WHERE parent_node_id = ?), 1)`
      ).bind(trashRootId, nodeId, trashRootId),
      c.env.DB.prepare('UPDATE nodes SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND tree_id = ?')
        .bind(nodeId, treeId),
    ])

    const ctxDel = (c as any).executionCtx
    if (ctxDel?.waitUntil) {
      ctxDel.waitUntil(deleteNodeVector(c.env.VECTORIZE, nodeId))
    }
    logAuditFromContext(c, { userId: user.user_id, action: 'node.delete', targetType: 'node', targetId: nodeId, treeId })
    return c.json({ success: true, message: 'Node moved to trash' })
  } catch (error) {
    console.error('Failed to delete node:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Restore a trashed node to normal root
app.post('/api/trees/:tree_id/nodes/:id/restore', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const nodePublicId = c.req.param('id')
    if (isNaN(treeId) || !isValidPublicNodeId(nodePublicId)) {
      return c.json({ success: false, error: 'Invalid tree ID or node ID' }, 400)
    }

    const nodeId = await resolvePublicNodeId(c.env.DB, treeId, nodePublicId)
    if (!nodeId) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    const checkResults = await c.env.DB.batch([
      c.env.DB.prepare('SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ?').bind(treeId, user.user_id),
      c.env.DB.prepare('SELECT root_node_id, trash_root_node_id FROM trees WHERE id = ?').bind(treeId),
      c.env.DB.prepare('SELECT id FROM nodes WHERE id = ? AND tree_id = ?').bind(nodeId, treeId),
      c.env.DB.prepare(
        `WITH RECURSIVE trash_subtree(id) AS (
           SELECT (SELECT trash_root_node_id FROM trees WHERE id = ?)
           UNION
           SELECT nr.child_node_id
           FROM node_relations nr
           JOIN trash_subtree ts ON nr.parent_node_id = ts.id
         )
         SELECT 1 AS in_trash FROM trash_subtree WHERE id = ? LIMIT 1`
      ).bind(treeId, nodeId),
    ])

    const roleRow = checkResults[0].results[0] as { role: string } | undefined
    if (!roleRow || (roleRow.role !== 'owner' && roleRow.role !== 'editor')) {
      return c.json({ success: false, error: 'You do not have permission to edit this tree' }, 403)
    }
    const treeRow = checkResults[1].results[0] as { root_node_id: number; trash_root_node_id: number | null } | undefined
    const nodeRow = checkResults[2].results[0] as { id: number } | undefined
    const inTrashRow = checkResults[3].results[0] as { in_trash: number } | undefined
    if (!treeRow?.trash_root_node_id) {
      return c.json({ success: false, error: 'Trash root node is not configured' }, 500)
    }
    if (!nodeRow) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }
    if (!inTrashRow) {
      return c.json({ success: false, error: 'Only nodes in trash tree can be restored' }, 400)
    }

    const trashRootId = treeRow.trash_root_node_id
    const rootId = treeRow.root_node_id
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM node_relations WHERE child_node_id = ?').bind(nodeId),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO node_relations (parent_node_id, child_node_id, position, relation_type_id)
         VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM node_relations WHERE parent_node_id = ?), 1)`
      ).bind(rootId, nodeId, rootId),
      c.env.DB.prepare('UPDATE nodes SET deleted_at = NULL WHERE id = ? AND tree_id = ?').bind(nodeId, treeId),
    ])

    const publicIdMap = await encodeNodeIds(c.env.DB, [nodeId])
    logAuditFromContext(c, { userId: user.user_id, action: 'node.restore', targetType: 'node', targetId: nodeId, treeId })
    return c.json({ success: true, message: 'Node restored', node_id: publicIdMap.get(nodeId) ?? String(nodeId) })
  } catch (error) {
    console.error('Failed to restore node:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Permanently delete a trashed node and deletable descendants
app.delete('/api/trees/:tree_id/nodes/:id/permanent', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const nodePublicId = c.req.param('id')
    if (isNaN(treeId) || !isValidPublicNodeId(nodePublicId)) {
      return c.json({ success: false, error: 'Invalid tree ID or node ID' }, 400)
    }

    const nodeId = await resolvePublicNodeId(c.env.DB, treeId, nodePublicId)
    if (!nodeId) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }

    const checkResults = await c.env.DB.batch([
      c.env.DB.prepare('SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ?').bind(treeId, user.user_id),
      c.env.DB.prepare('SELECT trash_root_node_id FROM trees WHERE id = ?').bind(treeId),
      c.env.DB.prepare('SELECT id FROM nodes WHERE id = ? AND tree_id = ?').bind(nodeId, treeId),
      c.env.DB.prepare(
        `WITH RECURSIVE trash_subtree(id) AS (
           SELECT (SELECT trash_root_node_id FROM trees WHERE id = ?)
           UNION
           SELECT nr.child_node_id
           FROM node_relations nr
           JOIN trash_subtree ts ON nr.parent_node_id = ts.id
         )
         SELECT 1 AS in_trash FROM trash_subtree WHERE id = ? LIMIT 1`
      ).bind(treeId, nodeId),
    ])

    const roleRow = checkResults[0].results[0] as { role: string } | undefined
    if (!roleRow || (roleRow.role !== 'owner' && roleRow.role !== 'editor')) {
      return c.json({ success: false, error: 'You do not have permission to edit this tree' }, 403)
    }
    const treeRow = checkResults[1].results[0] as { trash_root_node_id: number | null } | undefined
    const nodeRow = checkResults[2].results[0] as { id: number } | undefined
    const inTrashRow = checkResults[3].results[0] as { in_trash: number } | undefined
    if (!treeRow?.trash_root_node_id) {
      return c.json({ success: false, error: 'Trash root node is not configured' }, 500)
    }
    if (!nodeRow) {
      return c.json({ success: false, error: 'Node not found' }, 404)
    }
    if (!inTrashRow) {
      return c.json({ success: false, error: 'Only nodes in trash tree can be permanently deleted' }, 400)
    }

    const subtreeRows = await c.env.DB.prepare(
      `WITH RECURSIVE
         subtree(id) AS (
           SELECT ?
           UNION
           SELECT nr.child_node_id
           FROM node_relations nr
           JOIN subtree s ON nr.parent_node_id = s.id
         ),
         trash_subtree(id) AS (
           SELECT ?
           UNION
           SELECT nr.child_node_id
           FROM node_relations nr
           JOIN trash_subtree ts ON nr.parent_node_id = ts.id
         )
       SELECT
         s.id AS id,
         EXISTS(
           SELECT 1
           FROM node_relations pr
           WHERE pr.child_node_id = s.id
             AND pr.parent_node_id NOT IN (SELECT id FROM subtree)
             AND pr.parent_node_id NOT IN (SELECT id FROM trash_subtree)
         ) AS has_outside_parent
       FROM subtree s
       JOIN nodes n ON n.id = s.id
       WHERE n.tree_id = ?`
    ).bind(nodeId, treeRow.trash_root_node_id, treeId).all<{ id: number; has_outside_parent: number }>()

    const candidates = subtreeRows.results || []
    if (candidates.length === 0) {
      return c.json({ success: false, error: 'Delete target not found in tree' }, 404)
    }
    const deletableIds = candidates.filter((r) => Number(r.has_outside_parent) === 0).map((r) => Number(r.id))
    const skippedCount = candidates.length - deletableIds.length

    let deletedCount = 0
    if (deletableIds.length > 0) {
      await purgeNodeSnapshotsForNodes(c.env.DB, deletableIds)
      // 削除される親を失う残存ノード（外側の親を持つノード）を先に集める。
      // CASCADE で親が1人になったものは、削除と同じ batch で STRUCTURAL に正規化する
      const deletableIdSet = new Set(deletableIds)
      const survivingChildIds = new Set<number>()
      // D1 のバインド変数上限（100/クエリ）を超えないよう分割して batch で一括削除する
      // （サブツリーが99ノードを超えると tree_id 1個 + IN 句で上限を超え、削除が500になっていた）
      const deleteStatements: D1PreparedStatement[] = []
      for (let i = 0; i < deletableIds.length; i += D1_IN_CLAUSE_BATCH) {
        const chunk = deletableIds.slice(i, i + D1_IN_CLAUSE_BATCH)
        const placeholders = chunk.map(() => '?').join(', ')
        const childRows = await c.env.DB.prepare(
          `SELECT DISTINCT child_node_id FROM node_relations WHERE parent_node_id IN (${placeholders})`
        ).bind(...chunk).all<{ child_node_id: number }>()
        for (const row of childRows.results || []) {
          const childId = Number(row.child_node_id)
          if (!deletableIdSet.has(childId)) survivingChildIds.add(childId)
        }
        deleteStatements.push(
          c.env.DB.prepare(`DELETE FROM nodes WHERE tree_id = ? AND id IN (${placeholders})`).bind(treeId, ...chunk)
        )
      }
      const normalizeStatements = [...survivingChildIds].map((childId) => normalizeSoleParentStatement(c.env.DB, childId))
      await c.env.DB.batch([
        ...deleteStatements,
        ...normalizeStatements,
        c.env.DB.prepare('UPDATE trees SET node_count = MAX(0, node_count - ?) WHERE id = ?').bind(deletableIds.length, treeId),
      ])
      // meta.changes は FK の ON DELETE CASCADE で消えた node_relations 行も数えるため
      // （ノード111件+リレーション111件=222になる）、ノード数は対象件数で返す
      deletedCount = deletableIds.length
    }

    const ctxPerm = (c as any).executionCtx
    if (ctxPerm?.waitUntil) {
      ctxPerm.waitUntil(deleteNodeVector(c.env.VECTORIZE, nodeId))
    }
    const publicIdMap = await encodeNodeIds(c.env.DB, [nodeId])
    logAuditFromContext(c, { userId: user.user_id, action: 'node.permanent_delete', targetType: 'node', targetId: nodeId, treeId })
    return c.json({
      success: true,
      message: 'Permanent deletion completed',
      node_id: publicIdMap.get(nodeId) ?? String(nodeId),
      deleted_count: deletedCount,
      skipped_count: skippedCount
    })
  } catch (error) {
    console.error('Failed to permanently delete node:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Add a parent-child relation (with circular reference check and same-tree validation)
const REST_LINK_REJECTION_MESSAGES: Record<NewRelationRejection, string> = {
  self_reference: 'Cannot create self-reference',
  cycle_detected: 'Circular reference detected',
  cycle_indeterminate: CIRCULAR_CHECK_INDETERMINATE_MESSAGE,
  already_exists: 'Relation already exists',
}

app.post('/api/trees/:tree_id/relations', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))

    if (isNaN(treeId)) {
      return c.json({ success: false, error: 'Invalid tree ID' }, 400)
    }

    const body = await c.req.json()
    const { parent_node_id: parentNodePublicId, child_node_id: childNodePublicId } = body
    const relationTypeIdRaw = body.relation_type_id
    const relationTypeId = relationTypeIdRaw === undefined || relationTypeIdRaw === null
      ? null
      : parseInt(String(relationTypeIdRaw))

    if (!isValidPublicNodeId(parentNodePublicId) || !isValidPublicNodeId(childNodePublicId)) {
      return c.json({ success: false, error: 'parent_node_id and child_node_id are required' }, 400)
    }
    if (relationTypeId !== null && isNaN(relationTypeId)) {
      return c.json({ success: false, error: 'relation_type_id must be a number' }, 400)
    }

    const publicIdMap = await resolvePublicNodeIds(c.env.DB, treeId, [String(parentNodePublicId), String(childNodePublicId)])
    const parentNodeId = publicIdMap.get(String(parentNodePublicId))
    const childNodeId = publicIdMap.get(String(childNodePublicId))
    if (!parentNodeId || !childNodeId) {
      return c.json({ success: false, error: 'Parent or child node not found' }, 404)
    }

    // Self-reference check
    if (parentNodeId === childNodeId) {
      return c.json({ success: false, error: 'Cannot create self-reference' }, 400)
    }

    // RT1: 全チェックを一括batch
    const checkResults = await c.env.DB.batch([
      // [0] 権限チェック
      c.env.DB.prepare('SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ?')
        .bind(treeId, user.user_id),
      // [1] 親ノードのtree_id
      c.env.DB.prepare('SELECT tree_id FROM nodes WHERE id = ?').bind(parentNodeId),
      // [2] 子ノードのtree_id
      c.env.DB.prepare('SELECT tree_id FROM nodes WHERE id = ?').bind(childNodeId),
      // [3] child current parent count (for default relation_type)
      c.env.DB.prepare('SELECT COUNT(*) as parent_count FROM node_relations WHERE child_node_id = ?')
        .bind(childNodeId),
    ])

    // 権限チェック
    const roleRow = checkResults[0].results[0] as { role: string } | undefined
    if (!roleRow || (roleRow.role !== 'owner' && roleRow.role !== 'editor')) {
      return c.json({ success: false, error: 'You do not have permission to edit this tree' }, 403)
    }

    // ノード存在・ツリー所属チェック
    const parentNode = checkResults[1].results[0] as { tree_id: number } | undefined
    const childNode = checkResults[2].results[0] as { tree_id: number } | undefined

    if (!parentNode || !childNode) {
      return c.json({ success: false, error: 'Parent or child node not found' }, 404)
    }

    if (parentNode.tree_id !== treeId || childNode.tree_id !== treeId) {
      return c.json({ success: false, error: 'Both nodes must belong to the same tree' }, 400)
    }

    // 循環参照・既存リレーション確認
    const rejection = await checkNewRelation(c.env.DB, parentNodeId, childNodeId, {
      route: 'rest:/api/trees/:tree_id/relations',
      treeId,
      parentId: parentNodeId,
      childId: childNodeId,
    })
    if (rejection) {
      return c.json({ success: false, error: REST_LINK_REJECTION_MESSAGES[rejection] }, 400)
    }

    const childParentCountRow = checkResults[3].results[0] as { parent_count: number } | undefined
    const hasExistingParent = Number(childParentCountRow?.parent_count ?? 0) > 0
    const effectiveRelationTypeId = relationTypeId ?? (hasExistingParent ? 3 : 1)

    const relationType = await c.env.DB.prepare('SELECT id FROM relation_types WHERE id = ?')
      .bind(effectiveRelationTypeId)
      .first<{ id: number }>()
    if (!relationType) {
      return c.json({ success: false, error: 'Invalid relation_type_id' }, 400)
    }

    await appendRelation(c.env.DB, parentNodeId, childNodeId, effectiveRelationTypeId)

    const responseData = await c.env.DB.prepare(
      `SELECT parent.public_id AS parent_node_id, child.public_id AS child_node_id,
              nr.position, nr.relation_type_id, rt.name AS relation_type_name, rt.icon_type AS relation_icon_type
       FROM node_relations nr
       JOIN nodes parent ON parent.id = nr.parent_node_id
       JOIN nodes child ON child.id = nr.child_node_id
       LEFT JOIN relation_types rt ON nr.relation_type_id = rt.id
       WHERE nr.parent_node_id = ? AND nr.child_node_id = ?`
    ).bind(parentNodeId, childNodeId).first()

    logAuditFromContext(c, { userId: user.user_id, action: 'relation.create', targetType: 'relation', targetId: `${parentNodeId}:${childNodeId}`, treeId })
    return c.json({ success: true, data: responseData }, 201)
  } catch (error) {
    console.error('Failed to create relation:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Delete a parent-child relation
app.delete('/api/trees/:tree_id/relations/:parent_id/:child_id', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const parentPublicId = c.req.param('parent_id')
    const childPublicId = c.req.param('child_id')

    if (isNaN(treeId) || !isValidPublicNodeId(parentPublicId) || !isValidPublicNodeId(childPublicId)) {
      return c.json({ success: false, error: 'Invalid tree ID, parent ID, or child ID' }, 400)
    }

    const idMap = await resolvePublicNodeIds(c.env.DB, treeId, [parentPublicId, childPublicId])
    const parentId = idMap.get(parentPublicId)
    const childId = idMap.get(childPublicId)
    if (!parentId || !childId) {
      return c.json({ success: false, error: 'Parent or child node not found' }, 404)
    }

    // Batch checks: permission + tree ownership + relation existence + parent count
    const checkResults = await c.env.DB.batch([
      c.env.DB.prepare('SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ?')
        .bind(treeId, user.user_id),
      c.env.DB.prepare('SELECT tree_id FROM nodes WHERE id = ?')
        .bind(parentId),
      c.env.DB.prepare('SELECT tree_id FROM nodes WHERE id = ?')
        .bind(childId),
    ])

    const roleRow = checkResults[0].results[0] as { role: string } | undefined
    if (!roleRow || (roleRow.role !== 'owner' && roleRow.role !== 'editor')) {
      return c.json({ success: false, error: 'You do not have permission to edit this tree' }, 403)
    }

    const parentNode = checkResults[1].results[0] as { tree_id: number } | undefined
    if (!parentNode || parentNode.tree_id !== treeId) {
      return c.json({ success: false, error: 'Parent node not found in this tree' }, 404)
    }

    const childNode = checkResults[2].results[0] as { tree_id: number } | undefined
    if (!childNode || childNode.tree_id !== treeId) {
      return c.json({ success: false, error: 'Child node not found in this tree' }, 404)
    }

    // 唯一の親の解除はエラー（ノードは常に1つ以上の親を持つ必要がある）。
    // MCP unlink_node / unlink_nodes（2026-07-17〜）と挙動を統一。
    // 以前は自動的に root 配下へ付け替えていたが、その挙動は廃止した。
    const rejection = await checkRelationRemoval(c.env.DB, parentId, childId)
    if (rejection === 'not_found') {
      return c.json({ success: false, error: 'Relation not found' }, 404)
    }
    if (rejection === 'last_parent') {
      return c.json({
        success: false,
        error: 'Cannot remove the last parent from a node: a node must keep at least one parent. Move it to another parent first, or move it to trash.',
      }, 400)
    }

    const deletedCount = await removeRelation(c.env.DB, parentId, childId)
    if (deletedCount === 0) {
      return c.json({ success: false, error: 'Relation not found' }, 404)
    }

    logAuditFromContext(c, { userId: user?.user_id ?? null, action: 'relation.delete', targetType: 'relation', targetId: `${parentId}:${childId}`, treeId })
    return c.json({ success: true, message: 'Relation deleted' })
  } catch (error) {
    console.error('Failed to delete relation:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Update relation position (for drag and drop reordering)
app.patch('/api/trees/:tree_id/relations/:parent_id/:child_id/position', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const parentPublicId = c.req.param('parent_id')
    const childPublicId = c.req.param('child_id')
    const body = await c.req.json()
    const { position } = body

    if (isNaN(treeId) || !isValidPublicNodeId(parentPublicId) || !isValidPublicNodeId(childPublicId)) {
      return c.json({ success: false, error: 'Invalid IDs' }, 400)
    }

    const idMap = await resolvePublicNodeIds(c.env.DB, treeId, [parentPublicId, childPublicId])
    const parentId = idMap.get(parentPublicId)
    const childId = idMap.get(childPublicId)
    if (!parentId || !childId) {
      return c.json({ success: false, error: 'Parent or child node not found' }, 404)
    }

    // Check if user can edit this tree
    const canEdit = await canEditTree(c.env.DB, treeId, user.user_id)
    if (!canEdit) {
      return c.json({ success: false, error: 'You do not have permission to edit this tree' }, 403)
    }

    // Verify parent node belongs to the tree
    const parentNode = await c.env.DB.prepare('SELECT tree_id FROM nodes WHERE id = ?')
      .bind(parentId)
      .first<{ tree_id: number }>()

    if (!parentNode || parentNode.tree_id !== treeId) {
      return c.json({ success: false, error: 'Parent node not found in this tree' }, 404)
    }

    // Update position
    await c.env.DB.prepare(
      'UPDATE node_relations SET position = ? WHERE parent_node_id = ? AND child_node_id = ?'
    ).bind(position || 0, parentId, childId).run()

    const updated = await c.env.DB.prepare(
      `SELECT parent.public_id AS parent_node_id, child.public_id AS child_node_id,
              nr.position, nr.relation_type_id, rt.name AS relation_type_name, rt.icon_type AS relation_icon_type
       FROM node_relations nr
       JOIN nodes parent ON parent.id = nr.parent_node_id
       JOIN nodes child ON child.id = nr.child_node_id
       LEFT JOIN relation_types rt ON nr.relation_type_id = rt.id
       WHERE nr.parent_node_id = ? AND nr.child_node_id = ?`
    ).bind(parentId, childId).first()

    logAuditFromContext(c, { userId: user.user_id, action: 'relation.position_update', targetType: 'relation', targetId: `${parentId}:${childId}`, treeId })
    return c.json({ success: true, data: updated })
  } catch (error) {
    console.error('Failed to update relation position:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Update relation type for a parent-child relation
app.patch('/api/trees/:tree_id/relations/:parent_id/:child_id/type', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))
    const parentPublicId = c.req.param('parent_id')
    const childPublicId = c.req.param('child_id')
    const body = await c.req.json()
    const relationTypeId = parseInt(String(body.relation_type_id))

    if (isNaN(treeId) || !isValidPublicNodeId(parentPublicId) || !isValidPublicNodeId(childPublicId)) {
      return c.json({ success: false, error: 'Invalid tree ID, parent ID, or child ID' }, 400)
    }
    if (isNaN(relationTypeId)) {
      return c.json({ success: false, error: 'relation_type_id must be a number' }, 400)
    }

    const idMap = await resolvePublicNodeIds(c.env.DB, treeId, [parentPublicId, childPublicId])
    const parentId = idMap.get(parentPublicId)
    const childId = idMap.get(childPublicId)
    if (!parentId || !childId) {
      return c.json({ success: false, error: 'Parent or child node not found' }, 404)
    }

    const checkResults = await c.env.DB.batch([
      // [0] permission
      c.env.DB.prepare('SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ?')
        .bind(treeId, user.user_id),
      // [1] parent belongs to tree
      c.env.DB.prepare('SELECT tree_id FROM nodes WHERE id = ?')
        .bind(parentId),
      // [2] child belongs to tree
      c.env.DB.prepare('SELECT tree_id FROM nodes WHERE id = ?')
        .bind(childId),
      // [3] relation exists
      c.env.DB.prepare('SELECT 1 AS relation_exists FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?')
        .bind(parentId, childId),
      // [4] relation_type exists
      c.env.DB.prepare('SELECT id FROM relation_types WHERE id = ?')
        .bind(relationTypeId),
    ])

    const roleRow = checkResults[0].results[0] as { role: string } | undefined
    if (!roleRow || (roleRow.role !== 'owner' && roleRow.role !== 'editor')) {
      return c.json({ success: false, error: 'You do not have permission to edit this tree' }, 403)
    }

    const parentNode = checkResults[1].results[0] as { tree_id: number } | undefined
    if (!parentNode || parentNode.tree_id !== treeId) {
      return c.json({ success: false, error: 'Parent node not found in this tree' }, 404)
    }

    const childNode = checkResults[2].results[0] as { tree_id: number } | undefined
    if (!childNode || childNode.tree_id !== treeId) {
      return c.json({ success: false, error: 'Child node not found in this tree' }, 404)
    }

    const relation = checkResults[3].results[0] as { relation_exists: number } | undefined
    if (!relation) {
      return c.json({ success: false, error: 'Relation not found' }, 404)
    }

    const relationType = checkResults[4].results[0] as { id: number } | undefined
    if (!relationType) {
      return c.json({ success: false, error: 'Invalid relation_type_id' }, 400)
    }

    const change = await setRelationType(c.env.DB, parentId, childId, relationTypeId)
    if (change.status === 'not_found') {
      return c.json({ success: false, error: 'Relation not found' }, 404)
    }
    if (change.status === 'last_structural') {
      return c.json({ success: false, error: LAST_STRUCTURAL_PARENT_ERROR }, 400)
    }
    const demotedPublicIds = await encodeNodeIds(c.env.DB, change.demotedParentIds)

    const updated = await c.env.DB.prepare(
      `SELECT parent.public_id AS parent_node_id, child.public_id AS child_node_id,
              nr.position, nr.relation_type_id, rt.name AS relation_type_name, rt.icon_type AS relation_icon_type
       FROM node_relations nr
       JOIN nodes parent ON parent.id = nr.parent_node_id
       JOIN nodes child ON child.id = nr.child_node_id
       LEFT JOIN relation_types rt ON nr.relation_type_id = rt.id
       WHERE nr.parent_node_id = ? AND nr.child_node_id = ?`
    ).bind(parentId, childId).first()

    logAuditFromContext(c, { userId: user.user_id, action: 'relation.type_update', targetType: 'relation', targetId: `${parentId}:${childId}`, treeId })
    return c.json({
      success: true,
      data: { ...updated, demoted_parent_ids: change.demotedParentIds.map((id) => demotedPublicIds.get(id) ?? String(id)) },
    })
  } catch (error) {
    console.error('Failed to update relation type:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// [DEPRECATED] root-position endpoint - use batch-reorder with root_node_id instead
app.patch('/api/trees/:tree_id/nodes/:id/root-position', authMiddleware, async (c) => {
  return c.json({ success: false, error: 'This endpoint is deprecated. Use PUT /relations/batch-reorder with parent_node_id = root_node_id instead.' }, 410)
})

// ===============================
// Batch Operations (Performance Optimization)
// ===============================

// Batch reorder: update positions for all children of a parent in one request
app.put('/api/trees/:tree_id/relations/batch-reorder', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))

    if (isNaN(treeId)) {
      return c.json({ success: false, error: 'Invalid tree ID' }, 400)
    }

    const body = await c.req.json()
    const { parent_node_id, ordered_child_ids } = body
    const includeFullData = c.req.query('include_full_data') === '1'

    if (!Array.isArray(ordered_child_ids) || ordered_child_ids.length === 0) {
      return c.json({ success: false, error: 'ordered_child_ids must be a non-empty array' }, 400)
    }
    if (!ordered_child_ids.every((id: unknown) => isValidPublicNodeId(id))) {
      return c.json({ success: false, error: 'ordered_child_ids must contain only public node IDs' }, 400)
    }

    // Resolve all public IDs first (API boundary)
    const orderedChildPublicIds = ordered_child_ids as string[]
    const idsToResolve = new Set<string>(orderedChildPublicIds)
    if (parent_node_id !== null && parent_node_id !== undefined) {
      if (!isValidPublicNodeId(parent_node_id)) {
        return c.json({ success: false, error: 'parent_node_id must be a public node ID' }, 400)
      }
      idsToResolve.add(parent_node_id)
    }
    const idMap = await resolvePublicNodeIds(c.env.DB, treeId, Array.from(idsToResolve))

    // parent_node_idが未指定の場合、root_node_idを使用
    let effectiveParentId: number | undefined
    let effectiveParentPublicId: string | undefined
    if (parent_node_id === null || parent_node_id === undefined) {
      const treeRow = await c.env.DB.prepare('SELECT root_node_id FROM trees WHERE id = ?').bind(treeId).first<{ root_node_id: number }>()
      effectiveParentId = treeRow?.root_node_id
    } else {
      effectiveParentPublicId = parent_node_id
      effectiveParentId = idMap.get(parent_node_id)
    }

    if (!effectiveParentId) {
      return c.json({ success: false, error: 'Could not determine parent node' }, 400)
    }

    if (!effectiveParentPublicId) {
      const parentIdMap = await encodeNodeIds(c.env.DB, [effectiveParentId])
      effectiveParentPublicId = parentIdMap.get(effectiveParentId) ?? String(effectiveParentId)
    }

    // RT1: canEditTree + parent validation in one batch
    const checkResults = await c.env.DB.batch([
      c.env.DB.prepare('SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ?').bind(treeId, user.user_id),
      c.env.DB.prepare('SELECT tree_id FROM nodes WHERE id = ?').bind(effectiveParentId)
    ])

    const roleRow = checkResults[0].results[0] as { role: string } | undefined
    if (!roleRow || (roleRow.role !== 'owner' && roleRow.role !== 'editor')) {
      return c.json({ success: false, error: 'You do not have permission to edit this tree' }, 403)
    }

    const parentNode = checkResults[1].results[0] as { tree_id: number } | undefined
    if (!parentNode || parentNode.tree_id !== treeId) {
      return c.json({ success: false, error: 'Parent node not found in this tree' }, 404)
    }

    // RT2: Batch update positions
    const writeStmts: D1PreparedStatement[] = []
    const resolvedChildIds: number[] = []

    for (let i = 0; i < orderedChildPublicIds.length; i++) {
      const childId = idMap.get(orderedChildPublicIds[i])
      if (!childId) {
        return c.json({ success: false, error: `Child node not found: ${orderedChildPublicIds[i]}` }, 404)
      }
      resolvedChildIds.push(childId)
      writeStmts.push(
        c.env.DB.prepare(
          'UPDATE node_relations SET position = ? WHERE parent_node_id = ? AND child_node_id = ?'
        ).bind(i, effectiveParentId, childId)
      )
    }

    await c.env.DB.batch(writeStmts)

    if (!includeFullData) {
      logAuditFromContext(c, { userId: user.user_id, action: 'relation.reorder', targetType: 'tree', targetId: effectiveParentId, treeId })
      return c.json({
        success: true,
        data: {
          parent_node_id: effectiveParentPublicId ?? effectiveParentId,
          ordered_child_ids: orderedChildPublicIds
        }
      })
    }

    const [nodesResult, relationsResult] = await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT n.public_id AS id, n.tree_id, n.title, n.content, n.author_user_id,
                n.created_by_user_id, n.updated_by_user_id, n.version,
                n.created_at, n.updated_at, n.child_sort_mode, n.child_sort_direction, n.deleted_at,
                u_author.display_name AS author_display_name, u_author.email AS author_email
         FROM nodes n LEFT JOIN users u_author ON n.author_user_id = u_author.id
         WHERE n.tree_id = ? ORDER BY n.created_at`
      ).bind(treeId),
      c.env.DB.prepare(
        `SELECT parent.public_id AS parent_node_id, child.public_id AS child_node_id,
                nr.position, nr.relation_type_id, rt.name AS relation_type_name, rt.icon_type AS relation_icon_type
         FROM node_relations nr
         JOIN nodes parent ON parent.id = nr.parent_node_id
         JOIN nodes child ON child.id = nr.child_node_id
         LEFT JOIN relation_types rt ON nr.relation_type_id = rt.id
         INNER JOIN nodes n ON nr.parent_node_id = n.id
         WHERE n.tree_id = ? ORDER BY nr.parent_node_id, nr.position`
      ).bind(treeId)
    ])

    logAuditFromContext(c, { userId: user.user_id, action: 'relation.reorder', targetType: 'tree', targetId: effectiveParentId, treeId })
    return c.json({
      success: true,
      data: {
        nodes: nodesResult.results,
        relations: relationsResult.results
      }
    })
  } catch (error) {
    console.error('Failed to batch reorder:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// Move node: delete old relation + cycle check + create new relation + reorder, all in one request
app.post('/api/trees/:tree_id/relations/move', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)
    const treeId = parseInt(c.req.param('tree_id'))

    if (isNaN(treeId)) {
      return c.json({ success: false, error: 'Invalid tree ID' }, 400)
    }

    const body = await c.req.json()
    const { child_node_id, old_parent_id, new_parent_id, new_sibling_order } = body

    if (!isValidPublicNodeId(child_node_id)) {
      return c.json({ success: false, error: 'child_node_id is required and must be a public node ID' }, 400)
    }

    if (old_parent_id !== null && old_parent_id !== undefined && !isValidPublicNodeId(old_parent_id)) {
      return c.json({ success: false, error: 'old_parent_id must be a public node ID' }, 400)
    }

    if (new_parent_id !== null && new_parent_id !== undefined && !isValidPublicNodeId(new_parent_id)) {
      return c.json({ success: false, error: 'new_parent_id must be a public node ID' }, 400)
    }

    if (new_sibling_order !== undefined && new_sibling_order !== null) {
      if (!Array.isArray(new_sibling_order) || !new_sibling_order.every((id: unknown) => isValidPublicNodeId(id))) {
        return c.json({ success: false, error: 'new_sibling_order must be an array of public node IDs' }, 400)
      }
    }

    // Self-reference check
    if (new_parent_id !== null && new_parent_id !== undefined && child_node_id === new_parent_id) {
      return c.json({ success: false, error: 'Cannot create self-reference' }, 400)
    }

    // Resolve all public IDs (API boundary)
    const idsToResolve = new Set<string>([child_node_id])
    if (old_parent_id) idsToResolve.add(old_parent_id)
    if (new_parent_id) idsToResolve.add(new_parent_id)
    if (Array.isArray(new_sibling_order)) {
      for (const id of new_sibling_order) idsToResolve.add(id as string)
    }
    const publicIdMap = await resolvePublicNodeIds(c.env.DB, treeId, Array.from(idsToResolve))
    const childId = publicIdMap.get(child_node_id)
    if (!childId) {
      return c.json({ success: false, error: 'Child node not found' }, 404)
    }
    const oldParentId = old_parent_id ? publicIdMap.get(old_parent_id) : undefined
    if (old_parent_id && !oldParentId) {
      return c.json({ success: false, error: 'Old parent node not found' }, 404)
    }
    let newParentId: number | undefined
    if (new_parent_id) {
      newParentId = publicIdMap.get(new_parent_id)
      if (!newParentId) {
        return c.json({ success: false, error: 'New parent node not found' }, 404)
      }
    }
    const newSiblingOrderIds: number[] | undefined = Array.isArray(new_sibling_order)
      ? (new_sibling_order as string[]).map(publicId => {
          const id = publicIdMap.get(publicId)
          if (!id) throw new Error(`Sibling node not found: ${publicId}`)
          return id
        })
      : undefined

    // RT1: canEditTree + validation + root_node_id取得 in one batch
    const checkStmts: D1PreparedStatement[] = [
      c.env.DB.prepare('SELECT role FROM tree_members WHERE tree_id = ? AND user_id = ?').bind(treeId, user.user_id),
      c.env.DB.prepare('SELECT tree_id FROM nodes WHERE id = ?').bind(childId),
      c.env.DB.prepare('SELECT root_node_id FROM trees WHERE id = ?').bind(treeId),
    ]
    if (newParentId !== undefined) {
      checkStmts.push(
        c.env.DB.prepare('SELECT tree_id FROM nodes WHERE id = ?').bind(newParentId)
      )
    }
    const checkResults = await c.env.DB.batch(checkStmts)

    const roleRow = checkResults[0].results[0] as { role: string } | undefined
    if (!roleRow || (roleRow.role !== 'owner' && roleRow.role !== 'editor')) {
      return c.json({ success: false, error: 'You do not have permission to edit this tree' }, 403)
    }

    const childNode = checkResults[1].results[0] as { tree_id: number } | undefined
    if (!childNode || childNode.tree_id !== treeId) {
      return c.json({ success: false, error: 'Child node not found in this tree' }, 404)
    }

    const treeRow = checkResults[2].results[0] as { root_node_id: number } | undefined
    const rootNodeId = treeRow?.root_node_id

    // new_parent_id が null の場合、root_node_id に変換
    let effectiveNewParentId = newParentId
    if (effectiveNewParentId === undefined || effectiveNewParentId === null) {
      effectiveNewParentId = rootNodeId
    }

    if (effectiveNewParentId) {
      if (newParentId !== undefined) {
        const newParentNode = checkResults[3].results[0] as { tree_id: number } | undefined
        if (!newParentNode || newParentNode.tree_id !== treeId) {
          return c.json({ success: false, error: 'New parent node not found in this tree' }, 404)
        }
      }

      // RT2: Circular reference check (CTE)
      const cycleCheck = await checkCircularReference(c.env.DB, effectiveNewParentId, childId, {
        route: 'rest:/api/trees/:tree_id/relations/move',
        treeId,
        parentId: effectiveNewParentId,
        childId: childId,
      })
      if (cycleCheck === 'cycle_detected') {
        return c.json({ success: false, error: 'Circular reference detected' }, 400)
      }
      if (cycleCheck === 'indeterminate') {
        return c.json({ success: false, error: CIRCULAR_CHECK_INDETERMINATE_MESSAGE }, 400)
      }
    }

    let effectiveRelationTypeId = 1
    if (oldParentId !== undefined) {
      const oldRelation = await c.env.DB.prepare(
        'SELECT relation_type_id FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?'
      ).bind(oldParentId, childId).first<{ relation_type_id: number }>()

      if (!oldRelation) {
        return c.json({ success: false, error: 'Old relation not found' }, 404)
      }
      effectiveRelationTypeId = Number(oldRelation.relation_type_id) || 1
    }

    // RT3: writes + reads in one batch
    const batchStmts: D1PreparedStatement[] = []

    // Delete old relation
    if (oldParentId !== undefined) {
      batchStmts.push(
        c.env.DB.prepare(
          'DELETE FROM node_relations WHERE parent_node_id = ? AND child_node_id = ?'
        ).bind(oldParentId, childId)
      )
    }

    // Create new relation + reorder
    if (effectiveNewParentId) {
      if (newSiblingOrderIds && Array.isArray(newSiblingOrderIds)) {
        // Insert with specific position from sibling order
        const position = newSiblingOrderIds.indexOf(childId)
        batchStmts.push(
          c.env.DB.prepare(
            `INSERT OR IGNORE INTO node_relations (parent_node_id, child_node_id, position, relation_type_id)
             VALUES (?, ?, ?, ?)`
          ).bind(effectiveNewParentId, childId, position >= 0 ? position : 0, effectiveRelationTypeId)
        )
        // Update all sibling positions
        for (let i = 0; i < newSiblingOrderIds.length; i++) {
          batchStmts.push(
            c.env.DB.prepare(
              'UPDATE node_relations SET position = ? WHERE parent_node_id = ? AND child_node_id = ?'
            ).bind(i, effectiveNewParentId, newSiblingOrderIds[i])
          )
        }
      } else {
        // Append to end
        batchStmts.push(
          c.env.DB.prepare(
            `INSERT INTO node_relations (parent_node_id, child_node_id, position, relation_type_id)
             VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM node_relations WHERE parent_node_id = ?), ?)`
          ).bind(effectiveNewParentId, childId, effectiveNewParentId, effectiveRelationTypeId)
        )
      }
    }

    // Append read queries to same batch
    batchStmts.push(
      c.env.DB.prepare(
        `SELECT n.public_id AS id, n.tree_id, n.title, n.content, n.author_user_id,
                n.created_by_user_id, n.updated_by_user_id, n.version,
                n.created_at, n.updated_at, n.child_sort_mode, n.child_sort_direction, n.deleted_at,
                u_author.display_name AS author_display_name, u_author.email AS author_email
         FROM nodes n LEFT JOIN users u_author ON n.author_user_id = u_author.id
         WHERE n.tree_id = ? ORDER BY n.created_at`
      ).bind(treeId),
      c.env.DB.prepare(
        `SELECT parent.public_id AS parent_node_id, child.public_id AS child_node_id,
                nr.position, nr.relation_type_id, rt.name AS relation_type_name, rt.icon_type AS relation_icon_type
         FROM node_relations nr
         JOIN nodes parent ON parent.id = nr.parent_node_id
         JOIN nodes child ON child.id = nr.child_node_id
         LEFT JOIN relation_types rt ON nr.relation_type_id = rt.id
         INNER JOIN nodes n ON nr.parent_node_id = n.id
         WHERE n.tree_id = ? ORDER BY nr.parent_node_id, nr.position`
      ).bind(treeId)
    )

    const batchResults = await c.env.DB.batch(batchStmts)
    const nodesResult = batchResults[batchResults.length - 2]
    const relationsResult = batchResults[batchResults.length - 1]

    logAuditFromContext(c, { userId: user.user_id, action: 'relation.move', targetType: 'relation', treeId })
    return c.json({
      success: true,
      data: {
        nodes: nodesResult.results,
        relations: relationsResult.results
      }
    })
  } catch (error) {
    console.error('Failed to move node:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// 全ユーザーのノードを走査する運用ジョブ。安全な operator identity がまだ無いため
// HTTP からは起動させず、将来 Queue/Cron など内部トリガーから再利用できる形で保持する。
async function runVectorizeBulkSync(c: Context) {
  const requestStart = Date.now()
  try {
  if (!c.env.AI || !c.env.VECTORIZE) {
    return c.json({ success: false, error: 'AI/VECTORIZE binding not available' }, 503)
  }

  const offsetRaw = c.req.query('offset')
  const limitRaw = c.req.query('limit')
  const offset = offsetRaw ? Math.max(0, parseInt(offsetRaw, 10)) : 0
  const limit = limitRaw ? Math.min(500, Math.max(1, parseInt(limitRaw, 10))) : 300

  const db = c.env.DB
  const ai = c.env.AI
  const vectorize = c.env.VECTORIZE

  // 全件数を取得
  const countRow = await db.prepare(
    `SELECT COUNT(*) as total FROM nodes n
     JOIN trees t ON t.id = n.tree_id
     WHERE t.is_deleted = 0 AND n.deleted_at IS NULL`
  ).first<{ total: number }>()
  const total = countRow?.total ?? 0

  // 注: 旧実装は毎リクエストで全ノードのタイトル＋全リレーションをフルスキャンして
  // パス地図を再構築していたが、これが D1 レイテンシ次第で 30s を食い 524 の主因だった。
  // パスは処理対象ノードごとに getNodePathText()（再帰CTE）で取得し、処理量をページサイズに比例させる。

  // 今回処理するページのノードを取得
  const { results: pageNodes } = await db.prepare(
    `SELECT n.id, n.title, n.content, n.tree_id
     FROM nodes n
     JOIN trees t ON t.id = n.tree_id
     WHERE t.is_deleted = 0 AND n.deleted_at IS NULL
     ORDER BY n.id
     LIMIT ? OFFSET ?`
  ).bind(limit, offset).all<{ id: number; title: string; content: string | null; tree_id: number }>()

  const nodes = pageNodes || []
  let processed = 0
  let vectorsUpserted = 0

  // 各ノードをコンテンツ・チャンクに分割し、パス文脈付きのテキスト片を平坦化する。
  // 2000字打ち切りは撤廃（チャンク化で長文全体を対象にする）。
  // タイムアウト対策: 1リクエストで embedding するチャンク数を chunk_budget で上限管理する。
  // 内容の濃いページ（長文が密集）ではノード数を減らして時間内に収める。最低1ノードは必ず処理。
  // 処理しきれなかったノードは next_offset により次リクエストで処理される。
  // chunk_budget はクエリパラメータで調整可能（再デプロイなしでチューニングするため）。
  const chunkBudgetRaw = c.req.query('chunk_budget')
  const chunkBudget = chunkBudgetRaw ? Math.min(300, Math.max(10, parseInt(chunkBudgetRaw, 10) || 120)) : 120
  type ChunkText = { nodeId: number; treeId: number; chunkIdx: number; text: string }

  // フェーズ別の所要時間を計測してレスポンスで返す（どこが遅いかを推測でなく実測で判断する）
  const timings: Record<string, number> = {}
  let phaseStart = Date.now()
  const markPhase = (name: string) => {
    timings[name] = Date.now() - phaseStart
    phaseStart = Date.now()
  }

  // 1) チャンク予算内で処理対象ノードを選ぶ（パス取得はまだしない）。最低1ノードは処理。
  const selected: Array<{ node: typeof nodes[number]; chunks: string[] }> = []
  let chunkAccum = 0
  for (const node of nodes) {
    const chunks = splitIntoChunks(node.content)
    if (selected.length > 0 && chunkAccum + chunks.length > chunkBudget) break
    chunkAccum += chunks.length
    selected.push({ node, chunks })
  }

  // 2) 選んだノードのパスだけを per-node 再帰クエリで取得（並列・小バッチ）。
  //    D1 がハングしてもリクエストを固めないよう wave 単位でタイムアウト（fallback はタイトル無しパス）。
  const pathById = new Map<number, string>()
  const PATH_CONCURRENCY = 10
  for (let i = 0; i < selected.length; i += PATH_CONCURRENCY) {
    const slice = selected.slice(i, i + PATH_CONCURRENCY)
    const paths = await withTimeout(
      Promise.all(slice.map((s) => getNodePathText(db, s.node.id))),
      8000,
      slice.map((s) => String(s.node.id)),
    )
    slice.forEach((s, j) => pathById.set(s.node.id, paths[j]))
  }
  markPhase('path_ms')

  // 3) チャンクテキストを平坦化（ノード境界を記録し、後で「完了したノード」だけコミットする）。
  const chunkTexts: ChunkText[] = []
  const nodeRanges: Array<{ node: typeof nodes[number]; start: number; end: number }> = []
  for (const { node, chunks } of selected) {
    const pathText = pathById.get(node.id) || String(node.id)
    const start = chunkTexts.length
    chunks.forEach((chunk, idx) => {
      chunkTexts.push({
        nodeId: node.id,
        treeId: node.tree_id,
        chunkIdx: idx,
        text: buildNodeVectorText(pathText, chunk),
      })
    })
    nodeRanges.push({ node, start, end: chunkTexts.length })
  }

  // 4) embedding は「wave 並列 × 締切駆動」で実行する。
  //    30s 以内に終わることを祈る設計は 524 を根絶できないため、EMBED_DEADLINE_MS で
  //    embedding を打ち切り、完了した分だけコミットして必ず 200 を返す。
  //    進捗は next_offset が実処理ノード数を反映するのでクライアントはそのまま続行できる。
  //    最初の wave（50チャンク）は締切に関係なく必ず実行 = 最低1ノードは必ず前進する
  //    （MAX_CHUNKS_PER_NODE=50 なので最初の wave は先頭ノードを必ずカバーする）。
  const EMBED_BATCH = 10
  const EMBED_WAVE = 3 // 同時実行バッチ数（3×10=30チャンク/wave。並列過多はレート制限→ハングを誘発するため控えめに）
  const EMBED_DEADLINE_MS = 18000 // upsert/cleanup 用に 30s からの余白を残す
  const EMBED_CALL_TIMEOUT_MS = 10000 // 1バッチ呼び出しの上限。ハングは null 埋めで打ち切る
  const embeddingsByIndex: (number[] | null)[] = new Array(chunkTexts.length).fill(null)
  let embeddedUpto = 0
  for (let i = 0; i < chunkTexts.length; i += EMBED_BATCH * EMBED_WAVE) {
    if (i > 0 && Date.now() - requestStart > EMBED_DEADLINE_MS) break
    const waveBatches: Array<{ start: number; texts: string[] }> = []
    for (let w = 0; w < EMBED_WAVE; w++) {
      const s = i + w * EMBED_BATCH
      if (s >= chunkTexts.length) break
      waveBatches.push({ start: s, texts: chunkTexts.slice(s, s + EMBED_BATCH).map((b) => b.text) })
    }
    const waveResults = await Promise.all(
      waveBatches.map((wb) =>
        withTimeout(generateEmbeddingsBatch(ai, wb.texts), EMBED_CALL_TIMEOUT_MS, wb.texts.map(() => null)),
      ),
    )
    waveBatches.forEach((wb, k) => {
      waveResults[k].forEach((emb, j) => {
        embeddingsByIndex[wb.start + j] = emb
      })
    })
    embeddedUpto = Math.min(chunkTexts.length, i + EMBED_BATCH * EMBED_WAVE)
  }
  markPhase('embed_ms')

  // 5) 全チャンクの embedding が完了したノードだけをコミット対象にする。
  //    （締切打ち切りで途中までしか埋め込めなかったノードは次リクエストで最初から処理）
  const completedRanges = nodeRanges.filter((r) => r.end <= embeddedUpto)
  const committedNodes = completedRanges.map((r) => r.node)

  const vectors: VectorizeVector[] = []
  for (const range of completedRanges) {
    for (let i = range.start; i < range.end; i++) {
      const embedding = embeddingsByIndex[i]
      if (!embedding) continue // embedding 失敗チャンクはスキップ（従来挙動）
      const b = chunkTexts[i]
      vectors.push({
        id: chunkVectorId(b.nodeId, b.chunkIdx),
        values: embedding,
        metadata: { node_id: b.nodeId, tree_id: b.treeId, chunk_idx: b.chunkIdx },
      })
    }
  }

  // 6) upsert は 100 件ずつ（Vectorize のリクエストサイズ上限を避ける）。ハング対策のタイムアウト付き。
  const UPSERT_BATCH = 100
  const VECTORIZE_CALL_TIMEOUT_MS = 8000
  for (let i = 0; i < vectors.length; i += UPSERT_BATCH) {
    const batch = vectors.slice(i, i + UPSERT_BATCH)
    try {
      const ok = await withTimeout(vectorize.upsert(batch).then(() => true), VECTORIZE_CALL_TIMEOUT_MS, false)
      if (ok) vectorsUpserted += batch.length
      else console.error(`[vectorize-sync] upsert batch offset=${offset}+${i} timed out`)
    } catch (e) {
      console.error(`[vectorize-sync] upsert batch offset=${offset}+${i} failed:`, e)
    }
  }
  markPhase('upsert_ms')

  // 7) 掃除は「旧単一ベクトル（チャンク化前の String(nodeId)）」のみに絞る。
  //    1ノードにつき #k..#49 を消す方式は deleteByIds の往復が膨れタイムアウト要因になるため
  //    bulk では行わない（初回チャンク化では高indexのorphanは存在しない）。
  //    コンテンツ縮小による orphan は realtime 側 upsertNodeVector の full cleanup が担保。
  //    また embedding が1チャンクでも失敗したノードは旧ベクトルを残す（部分的な新データで
  //    検索可能性を失わないため。次回の同期・realtime 更新で自然に置き換わる）。
  const embedFailedByNode = new Map<number, number>()
  for (const range of completedRanges) {
    let failed = 0
    for (let i = range.start; i < range.end; i++) {
      if (!embeddingsByIndex[i]) failed++
    }
    if (failed > 0) embedFailedByNode.set(range.node.id, failed)
  }
  const embedFailedChunks = Array.from(embedFailedByNode.values()).reduce((a, b) => a + b, 0)
  const staleIds: string[] = committedNodes
    .filter((node) => !embedFailedByNode.has(node.id))
    .map((node) => String(node.id))
  for (let i = 0; i < staleIds.length; i += UPSERT_BATCH) {
    try {
      await withTimeout(
        vectorize.deleteByIds(staleIds.slice(i, i + UPSERT_BATCH)).then(() => true),
        VECTORIZE_CALL_TIMEOUT_MS,
        false,
      )
    } catch (e) {
      console.error(`[vectorize-sync] legacy cleanup offset=${offset}+${i} failed:`, e)
    }
  }
  markPhase('cleanup_ms')

  // progress はノード単位（total もノード数）。チャンク数は vectors_upserted で別途返す。
  // バジェット/締切により limit 未満のノードしか処理していない場合がある。
  processed = committedNodes.length

  const nextOffset = offset + committedNodes.length
  const done = nextOffset >= total
  const timeBoxed = embeddedUpto < chunkTexts.length

  const responsePayload = {
    success: true,
    processed,
    vectors_upserted: vectorsUpserted,
    embed_failed_chunks: embedFailedChunks,
    chunk_budget: chunkBudget,
    time_boxed: timeBoxed,
    offset,
    limit,
    total,
    next_offset: done ? null : nextOffset,
    done,
    timings: { ...timings, total_ms: Date.now() - requestStart },
  }
  // wrangler pages deployment tail で観測できるようサーバー側にも残す
  console.log('[vectorize-sync]', JSON.stringify(responsePayload))
  return c.json(responsePayload)
  } catch (e) {
    console.error('[vectorize-bulk-sync] error:', e)
    return c.json({ success: false, error: String(e) }, 500)
  }
}

// URL の存在を知っている通常ユーザーにも運用面を公開しない。
app.post('/api/vectorize-bulk-sync', disabledOperatorHttpRoute)

app.get('/api/search', authMiddleware, async (c) => {
  try {
    const user = getCurrentUser(c)

    const query = c.req.query('q')
    if (!query || query.trim() === '') {
      return c.json({ success: true, data: [] })
    }

    const { normalized, terms } = parseSearchQuery(query)

    const parentNodeIdRaw = c.req.query('parent_node_id')
    let parentNodeId: number | null = null
    if (parentNodeIdRaw) {
      if (!isValidPublicNodeId(parentNodeIdRaw)) {
        return c.json({ success: false, error: 'Invalid parent_node_id' }, 400)
      }
      parentNodeId = await resolvePublicNodeIdForScope(c.env.DB, parentNodeIdRaw)
      if (!parentNodeId) {
        return c.json({ success: false, error: 'Parent node not found' }, 404)
      }
    }

    const matchModeRaw = String(c.req.query('match_mode') || 'and').toLowerCase()
    if (matchModeRaw !== 'and' && matchModeRaw !== 'or') {
      return c.json({ success: false, error: 'Invalid match_mode (and/or)' }, 400)
    }

    // title_only=true はタイトルのみを検索対象にする（ベクトル検索もスキップ）
    const titleOnlyRaw = String(c.req.query('title_only') || '').toLowerCase()
    const titleOnly = titleOnlyRaw === 'true' || titleOnlyRaw === '1'

    const termJoiner = matchModeRaw === 'or' ? ' OR ' : ' AND '
    // 長い検索語は D1 の LIKE パターン長制限(約50バイト)を超えないよう分割して AND 条件化する
    const { clause: whereClause, binds } = buildLikeClause(terms, termJoiner, false, titleOnly)

    // ユーザーの tree_id を取得（ベクトル検索フィルター用）
    const { results: userTrees } = await c.env.DB.prepare(
      `SELECT tree_id FROM tree_members WHERE user_id = ? ORDER BY created_at ASC`
    ).bind(user.user_id).all<{ tree_id: number }>()
    const treeIds = (userTrees || []).map((t) => t.tree_id)

    const nodeDtoSelect = `n.public_id AS id, n.tree_id, n.title, n.content, n.author_user_id,
        n.created_by_user_id, n.updated_by_user_id, n.version,
        n.created_at, n.updated_at, n.child_sort_mode, n.child_sort_direction, n.deleted_at,
        u_author.display_name AS author_display_name, u_author.email AS author_email`

    // parent_node_id（配下スコープ）指定時は、対象ツリーとアクセス権をワード検索・
    // ベクトル検索の両方で使うため先に解決する。未解決/アクセス不可なら即座に空で返す
    // （従来はベクトル検索側がこのチェックを一切見ておらず、無関係な全ツリーを検索していた）。
    let parentScope: { treeId: number; scopedIdsPromise: Promise<number[]> } | null = null
    if (parentNodeId) {
      const parentRow = await c.env.DB.prepare(
        'SELECT tree_id FROM nodes WHERE id = ?'
      ).bind(parentNodeId).first<{ tree_id: number }>()
      const accessRow = parentRow
        ? await c.env.DB.prepare(
            'SELECT 1 FROM tree_members WHERE tree_id = ? AND user_id = ?'
          ).bind(parentRow.tree_id, user.user_id).first()
        : null
      if (!parentRow || !accessRow) {
        return c.json({ success: true, data: [] })
      }
      parentScope = { treeId: parentRow.tree_id, scopedIdsPromise: getAccessibleNodeIds(c.env.DB, parentNodeId) }
    }

    // 広い検索語でツリー全ノード＋本文を1レスポンスに詰めるのを防ぐ上限
    const SEARCH_RESULT_LIMIT = 100

    // ワード検索とベクトル検索を常に並列実行
    // ワード検索の失敗（例: D1 の LIKE 制限）で検索全体を殺さず、ベクトル結果だけでも返す
    const wordSearchPromise = (async () => {
      if (terms.length === 0) return []
      if (parentNodeId) {
        const { results } = await c.env.DB.prepare(
          `WITH RECURSIVE scoped(id) AS (
             SELECT ?
             UNION
             SELECT nr.child_node_id
             FROM node_relations nr
             JOIN scoped s ON nr.parent_node_id = s.id
           )
           SELECT ${nodeDtoSelect}
           FROM nodes n
           JOIN scoped s ON s.id = n.id
           LEFT JOIN users u_author ON n.author_user_id = u_author.id
           WHERE ${whereClause}
           ORDER BY n.updated_at DESC, n.id ASC
           LIMIT ${SEARCH_RESULT_LIMIT}`
        ).bind(parentNodeId, ...binds).all()
        return results || []
      } else {
        const { results } = await c.env.DB.prepare(
          `SELECT ${nodeDtoSelect}
           FROM nodes n
           INNER JOIN tree_members tm ON tm.tree_id = n.tree_id AND tm.user_id = ?
           LEFT JOIN users u_author ON n.author_user_id = u_author.id
           WHERE ${whereClause}
           ORDER BY n.updated_at DESC, n.id ASC
           LIMIT ${SEARCH_RESULT_LIMIT}`
        ).bind(user.user_id, ...binds).all()
        return results || []
      }
    })().catch((e) => {
      console.error('[api/search] word search failed:', e)
      return [] as any[]
    })

    const vectorSearchPromise = (async () => {
      // title_only 指定時は本文の意味マッチを結果に混ぜない
      if (titleOnly) return []
      if (!c.env.AI || !c.env.VECTORIZE) return []
      // parent_node_id 指定時はそのノードのツリーだけを対象にする（配下外・他ツリーへの
      // 漏れを防ぐ）。未指定時は従来通りユーザーの全所属ツリーを横断する。
      const targetTreeIds = parentScope ? [parentScope.treeId] : treeIds
      if (targetTreeIds.length === 0) return []
      // AI/Vectorize がハングしてもキーワード検索の結果を道連れにしないようタイムアウト防御
      const embedding = await withTimeout(generateEmbedding(c.env.AI, normalized), 5000, null)
      if (!embedding) return []
      // ユーザーの各ツリーで tree_id フィルタ検索して union。topK 枠を他ユーザーの
      // ツリーに浪費しない。アクセス制御は下の D1 JOIN でも多層防御。
      const perTreeIds = await Promise.all(
        targetTreeIds.map((treeId) =>
          withTimeout(vectorSearch(c.env.VECTORIZE, embedding, treeId, 20), 5000, [] as number[]),
        ),
      )
      const merged: number[] = []
      const seen = new Set<number>()
      for (const ids of perTreeIds) {
        for (const nodeId of ids) {
          if (!seen.has(nodeId)) {
            seen.add(nodeId)
            merged.push(nodeId)
          }
        }
      }
      // parent_node_id 指定時は配下（子孫）以外を除外する。tree_id での絞り込みだけでは
      // 同一ツリー内の配下外ノードが漏れるため、子孫ID集合との積を取る。
      if (parentScope) {
        const scopedSet = new Set(await parentScope.scopedIdsPromise)
        return merged.filter((id) => scopedSet.has(id))
      }
      return merged
    })()

    const [wordResults, vectorNodeIds] = await Promise.all([wordSearchPromise, vectorSearchPromise])

    // マージ：ワード結果優先、ベクトル専用をその後ろに
    // wordResults の id は公開ID（public_id AS id）なので、内部IDのベクトル結果を
    // 公開IDへ変換してから重複除去する
    const wordIdSet = new Set((wordResults as any[]).map((n: any) => String(n.id)))

    let vectorOnlyNodes: any[] = []
    if (vectorNodeIds.length > 0) {
      const vectorPublicIdMap = await encodeNodeIds(c.env.DB, vectorNodeIds)
      const vectorOnlyIds = vectorNodeIds.filter((id) => {
        const publicId = vectorPublicIdMap.get(id)
        return publicId !== undefined && !wordIdSet.has(publicId)
      })
      // D1 のバインド変数上限（100/クエリ）を超えないよう分割して取得する。
      // ツリー数 × topK でIDが100を超えると "too many SQL variables" になるため必須。
      const D1_IN_BATCH = 90
      const rowsByPublicId = new Map<string, any>()
      for (let i = 0; i < vectorOnlyIds.length; i += D1_IN_BATCH) {
        const slice = vectorOnlyIds.slice(i, i + D1_IN_BATCH)
        const placeholders = slice.map(() => '?').join(',')
        const { results } = await c.env.DB.prepare(
          `SELECT ${nodeDtoSelect}
           FROM nodes n
           INNER JOIN tree_members tm ON tm.tree_id = n.tree_id AND tm.user_id = ?
           LEFT JOIN users u_author ON n.author_user_id = u_author.id
           WHERE n.id IN (${placeholders})`
        ).bind(user.user_id, ...slice).all()
        for (const row of results || []) rowsByPublicId.set(String((row as any).id), row)
      }
      vectorOnlyNodes = vectorOnlyIds
        .map((id) => {
          const publicId = vectorPublicIdMap.get(id)
          return publicId === undefined ? undefined : rowsByPublicId.get(publicId)
        })
        .filter(Boolean)
    }

    // ワード検索＋ベクトル結果の合計も上限に揃える（ベクトル専用結果が上乗せされないように）
    const data = [
      ...(wordResults as any[]).map((n: any) => ({ ...n, is_vector_match: false })),
      ...vectorOnlyNodes.map((n: any) => ({ ...n, is_vector_match: true })),
    ].slice(0, SEARCH_RESULT_LIMIT)

    logAuditFromContext(c, { userId: user.user_id, action: 'read.search', targetType: 'tree', treeId: parentNodeId ?? null })
    return c.json({ success: true, data })
  } catch (error) {
    console.error('Failed to search:', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ===============================
// Frontend
// ===============================

// Editor HTML generator
const getEditorHTML = () => `
    <!DOCTYPE html>
    <html lang="ja">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta name="robots" content="noindex, nofollow, noarchive">
        <title>Zeeta Web</title>
        <link rel="icon" type="image/x-icon" href="/static/favicon.ico">
        <link rel="icon" type="image/png" sizes="32x32" href="/static/favicon.png">
        <link rel="apple-touch-icon" sizes="180x180" href="/static/favicon.png">
        <link rel="preconnect" href="https://cdn.jsdelivr.net">
        <script>(function(){try{var t=localStorage.getItem('zeeta-theme')||'system';if(t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('theme-dark')}catch(e){}})()</script>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" integrity="sha384-HtMZLkYo+pR5/u7zCzXxMJP6QoNnQJt1qkHM0EaOPvGDIzaVZbmYr/TlvUZ/sKAg" crossorigin="anonymous">
        <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet" integrity="sha384-iw3OoTErCYJJB9mCa8LNS2hbsQ7M3C0EpIsO/H5+EGAkPGc6rk+V8i04oW/K5xq0" crossorigin="anonymous">
        <link rel="stylesheet" href="/static/dark.css">
        <link rel="stylesheet" href="/static/tree-rail.css?v=${__BUILD_STAMP__}">
        <link rel="expect" href="#tree-rail-render-ready" blocking="render">
        <script src="/static/theme.js" defer></script>
        <!-- ByteMD Markdown Editor -->
        <script>window.process = { env: { NODE_ENV: 'production' } };</script>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bytemd@1.22.0/dist/index.css" integrity="sha384-FPHFECdLNgU/1megPUfSPyRef6W8DacPT0AkzyFP9H6gfWleAO22eEOCqTfpgquD" crossorigin="anonymous">
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5.9.0/github-markdown-light.css" integrity="sha384-4+yp2IvYOqcJcR9WCGb7S9CwgoCBD4qxmEMxnXjwpM54P0M/z05F3YkC+NFunWrc" crossorigin="anonymous">
        <style>
          :root {
            --tree-header-height: 48px;
          }
          #tree-header {
            background: #ffffff;
            border-bottom: 2px solid #e2e8f0;
            padding: 2px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 100;
            box-sizing: border-box;
          }
          #tree-header:empty {
            min-height: var(--tree-header-height, 48px);
          }
          .tree-item {
            cursor: pointer;
            user-select: none;
            line-height: 1.2;
            position: relative;
            color: #1f2937;
            transition: background-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
          }
          .tree-item:hover {
            background-color: #f8fafc;
          }
          .tree-item.active {
            background-color: #dbeafe;
            color: #111827;
            box-shadow: inset 4px 0 0 #3b82f6;
          }
          .tree-item-title {
            display: block;
            flex: 0 0 auto;
            width: max-content;
            min-width: max-content;
            overflow: visible !important;
            text-overflow: clip !important;
            white-space: nowrap !important;
          }
          .tree-item-actions {
            position: sticky;
            right: 0;
            z-index: 2;
            display: inline-grid;
            grid-template-columns: auto 26px;
            align-items: center;
            column-gap: 2px;
            flex: 0 0 auto;
            margin-left: auto;
            padding-left: 34px;
            background: linear-gradient(to right, rgba(255, 255, 255, 0), #ffffff 14px);
          }
          .tree-item:hover .tree-item-actions {
            background: linear-gradient(to right, rgba(248, 250, 252, 0), #f8fafc 14px);
          }
          .tree-item.active .tree-item-actions {
            background: linear-gradient(to right, rgba(219, 234, 254, 0), #dbeafe 14px);
          }
          .tree-item.duplicate-active .tree-item-actions {
            background: linear-gradient(to right, rgba(250, 245, 255, 0), #faf5ff 14px);
          }
          .tree-item .add-child-btn {
            position: sticky;
            right: 0;
            z-index: 2;
            grid-column: 2;
            flex-shrink: 0;
            justify-self: end;
            margin-left: 0;
            min-width: 26px;
            padding-left: 4px;
            padding-right: 4px;
            background: transparent;
          }
          .tree-item.duplicate-active {
            background-color: #faf5ff;
            border: 1px dashed #d8b4fe;
            border-radius: 4px;
          }
          .tree-guides {
            position: absolute;
            inset: 0 auto 0 0;
            pointer-events: none;
          }
          .tree-guide-line {
            position: absolute;
            top: 0;
            bottom: 0;
            width: 1px;
            background: rgba(148, 163, 184, 0.28);
          }
          #tree-container {
            min-height: 100px;
            width: max-content;
            min-width: 100%;
          }
          .tree-children {
            display: none;
          }
          .tree-children.expanded {
            display: block;
          }
          #editor-panel {
            margin-top: 0;
            padding-top: 0;
            /* 高さは親要素に合わせる */
          }
          #editor-panel .editor-scroll-area {
            min-height: 0;
            overflow-x: hidden;
          }
          #node-detail-dialog-panel {
            /* 初期サイズはビューポートに対する割合で決める（幅90% / 高さ85%）。
               画面の大小にかかわらず同じ見た目の割合になるようにする */
            width: min(90vw, calc(100vw - 2rem));
            height: min(85vh, calc(100vh - 2rem));
            min-width: min(720px, calc(100vw - 2rem));
            min-height: 420px;
            max-width: calc(100vw - 2rem);
            max-height: calc(100vh - 2rem);
            resize: both;
            /* パネル自体はスクロールさせない。履歴一覧と preview が各々スクロールし、
               タイトル・メタ情報・「戻す」は常に見える位置に留まる */
            overflow: hidden;
          }
          /* ヘッダ右のかたまり（id / detail / ゴミ箱 / 保存）の見た目の間隔を揃える。
             box 同士の gap は 8px で一定だが、ボタンごとに内側の余白が違うため
             glyph 間の余白は 16 / 27 / 19px とばらつく。detail ボタンの左右で補正して
             保存ボタン側の 19px に合わせる */
          #editor-panel #node-detail-btn {
            /* id との間隔だけは他の 1/3 に詰める（id はラベル、detail 以降は操作ボタン） */
            margin-left: -6px;
            margin-right: -4px;
          }
          #node-detail-dialog { z-index: 200; }
          #conflict-dialog { z-index: 210; }
          #node-compare-overlay { z-index: 205; }
          #node-compare-panel {
            width: min(86vw, calc(100vw - 2rem));
            height: min(78vh, calc(100vh - 2rem));
            max-width: calc(100vw - 2rem);
            max-height: calc(100vh - 2rem);
            overflow: hidden;
          }
          .node-detail-history-layout {
            display: grid;
            grid-template-columns: minmax(300px, 0.9fr) minmax(360px, 1.1fr);
            gap: 16px;
            min-height: 0;
          }
          /* 一覧の枠。列見出しを固定したまま、行だけがスクロールする */
          .node-detail-history-pane {
            display: flex;
            flex-direction: column;
            min-height: 0;
          }
          #node-detail-history-list {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
          }
          /* 履歴行は「ラジオ列 + 行ボタン」の2段構成。選択・hover の背景を行ボタン側だけで
             塗るとラジオ列だけ白く欠けるため、item 側に統一して塗る */
          .node-detail-history-item {
            display: grid;
            grid-template-columns: 34px 1fr;
            align-items: stretch;
            border-bottom: 1px solid #e5e7eb;
          }
          .node-detail-history-item:hover .node-detail-history-row,
          .node-detail-history-item:hover .node-detail-history-radio-cell { background: #f8fafc; }
          .node-detail-history-item.is-selected .node-detail-history-row,
          .node-detail-history-item.is-selected .node-detail-history-radio-cell { background: #dbeafe; }
          .node-detail-history-row {
            display: grid;
            grid-template-columns: minmax(145px, 0.8fr) minmax(160px, 1.2fr);
            gap: 12px;
            width: 100%;
            padding: 10px 12px;
            text-align: left;
          }
          .node-detail-history-radio-cell {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0 4px;
          }
          .node-detail-history-radio-cell input {
            accent-color: #3b82f6;
            cursor: pointer;
          }
          /* 無効ボタンは押せないことが見た目で分かるように薄くする（Tailwind v2 CDN は disabled:opacity-40 が効かない） */
          #node-detail-compare-btn:disabled,
          #node-detail-restore-btn:disabled { opacity: 0.4; cursor: not-allowed; }
          /* 比較オーバーレイのユニファイド差分行。+ / − は ::before で付ける */
          .node-compare-diff-line {
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 12.5px;
            line-height: 1.6;
            padding: 0 16px;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
          }
          .node-compare-diff-line.added { background: #e6ffec; }
          .node-compare-diff-line.added::before { content: "+ "; color: #1a7f37; font-weight: 600; }
          .node-compare-diff-line.removed { background: #ffebe9; }
          .node-compare-diff-line.removed::before { content: "- "; color: #cf222e; font-weight: 600; }
          /* 差分ナビ帯。本文スクロールコンテナ(#node-compare-diff)の外に置き、
             目盛位置は本文の scrollHeight 比例で JS が実測して出す（行番号換算は折返しでズレる） */
          #node-compare-diff-strip {
            position: relative;
            flex: 0 0 24px;
            background: #f8fafc;
            border-left: 1px solid #e5e7eb;
          }
          .node-compare-tick {
            position: absolute;
            left: 2px;
            right: 2px;
            min-height: 4px;
            padding: 0;
            border: none;
            border-radius: 2px;
            cursor: pointer;
          }
          /* 目盛の色は diff 行の背景（#e6ffec / #ffebe9）と差分文字色（#1a7f37 / #cf222e）の中間値 */
          .node-compare-tick.added { background: #80bf92; }
          .node-compare-tick.removed { background: #e7868c; }
          .node-compare-tick:hover,
          .node-compare-tick:focus-visible { left: 0; right: 0; }
          /* 目盛のホバー/クリックに応じて本文側の該当ブロックを強調する。
             outline はレイアウトに影響しない */
          .node-compare-diff-hunk.is-hover { outline: 2px solid rgba(59, 130, 246, 0.55); outline-offset: -2px; }
          @keyframes node-compare-flash {
            from { outline-color: rgba(59, 130, 246, 0.85); }
            to { outline-color: transparent; }
          }
          .node-compare-diff-hunk.is-flash {
            outline: 2px solid;
            outline-offset: -2px;
            animation: node-compare-flash 1.2s ease-out 1 forwards;
          }
          @media (prefers-reduced-motion: reduce) {
            .node-compare-diff-hunk.is-flash { animation: none; outline-color: transparent; }
          }
          #node-detail-preview {
            flex: 1;
            min-height: 0;
            overflow: auto;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
          }
          /* 親ノードチップは折り返さない。折り返すとヘッダが2〜3行になり、その分だけ本文の高さが減る。
             幅が足りないときはメタ側から削る（flex-shrink を 100:1 にして優先順位を付ける）。
             メタが限界まで縮んでもなお足りないときだけ、チップのラベルが端から切れる */
          #editor-panel .header-parents > .parents-chip-wrap {
            flex: 0 1 auto;
            min-width: 0;
          }
          #editor-panel .parents-chip-toggle {
            white-space: nowrap;
            overflow: hidden;
            min-width: 0;
            /* ボタンは inline-flex なので、これが無いと親が縮んでも幅を保って右へはみ出す */
            max-width: 100%;
          }
          /* 下端スペーサー。space-y-4 のマージンを打ち消しておかないと、
             最大スクロール時にスペーサーが 0 にクランプされて末尾にデッドゾーンが出る */
          #editor-panel #editor-scroll-spacer {
            margin-top: 0;
          }
          #editor-panel .editor-content-section {
            position: relative;
            --editor-content-header-height: 0px;
            --editor-toolbar-height: 0px;
            --editor-toolbar-sticky-top: 0px;
          }
          #editor-panel .editor-content-header {
            position: sticky;
            top: 0;
            z-index: 30;
            background: #ffffff;
            padding-top: 6px;
            padding-bottom: 0px;
            box-shadow: 0 10px 14px -16px rgba(15, 23, 42, 0.45);
          }
          #editor-panel .editor-content-body {
            position: relative;
            z-index: 1;
          }
          /* 狭幅では検索inputを縮めて右側ボタン（コピー/再読込/印字）を画面内に保つ。
             inputのwidthが固定だとflex自動最小サイズ（min-width:auto）が400px程度に張り付き、
             右グループが1pxも縮まないためoverflow-x:hiddenにはみ出していた。
             グループ→inputまでmin-width:0で縮小を通し、ボタン側は縮めない */
          #content-editor-header > .ml-auto {
            min-width: 0;
          }
          #content-editor-header > .ml-auto > button {
            flex-shrink: 0;
          }
          .content-search-group {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            min-width: 0;
          }
          .content-search-input {
            width: 260px;
            min-width: 0;
            height: 28px;
            padding: 0 8px;
            font-size: 12px;
            border: 1px solid #e5e7eb;
            border-radius: 6px;
            background: #ffffff;
            color: #374151;
          }
          .content-search-input:focus {
            outline: none;
            border-color: #93c5fd;
            box-shadow: 0 0 0 2px rgba(147, 197, 253, 0.4);
          }
          .content-search-submit-btn {
            width: 28px;
            height: 28px;
            flex-shrink: 0;
            border: 1px solid #e5e7eb;
            border-radius: 6px;
            background: #ffffff;
            color: #6b7280;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: all 0.16s ease;
          }
          .content-search-submit-btn:hover {
            background: #f8fafc;
            color: #111827;
          }
          .content-search-hit-nav {
            display: none;
            align-items: center;
            gap: 4px;
          }
          .content-search-hit-count {
            font-size: 11px;
            color: #1d4ed8;
            min-width: 32px;
            text-align: center;
            font-variant-numeric: tabular-nums;
          }
          .content-search-hit-btn {
            border: 1px solid #93c5fd;
            background: #fff;
            color: #1d4ed8;
            border-radius: 4px;
            width: 22px;
            height: 22px;
            line-height: 1;
            font-size: 13px;
            padding: 0;
            cursor: pointer;
          }
          .content-search-hit-btn:hover {
            background: #eff6ff;
          }
          .content-search-hit-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
          }
          .content-search-hit-highlight {
            background: #fde68a;
            border-radius: 2px;
            padding: 0 1px;
          }
          .content-search-hit-highlight.current {
            background: #fb923c;
            color: #1f2937;
            box-shadow: 0 0 0 1px #c2410c;
          }
          #editor-panel .editor-content-section.has-sticky-toolbar .bytemd-toolbar {
            position: sticky;
            top: var(--editor-toolbar-sticky-top);
            z-index: 29;
            background: #ffffff;
            border-top: none;
            border-bottom: 1px solid #e5e7eb;
            box-shadow: 0 10px 14px -16px rgba(15, 23, 42, 0.45);
          }
          #editor-panel .editor-content-section.has-sticky-toolbar .bytemd {
            position: relative;
            z-index: 1;
          }
          /* ByteMD全画面表示のときは左右ペインのsplit lineを隠す */
          #main-container:has(.bytemd-fullscreen) #resize-handle {
            display: none !important;
          }
          /* ByteMD全画面表示のときは固定ヘッダを隠す */
          body:has(.bytemd-fullscreen) #tree-header {
            display: none !important;
          }
          /* ヘッダ非表示時は本文を画面全体に広げる */
          body:has(.bytemd-fullscreen) #main-container {
            margin-top: 0 !important;
            height: 100vh !important;
          }
          body:has(.bytemd-fullscreen) #editor-panel .editor-content-header {
            display: none !important;
          }
          /* :has 非対応ブラウザ向け（JSでbodyへクラスを付与） */
          body.editor-content-fullscreen #tree-header {
            display: none !important;
          }
          body.editor-content-fullscreen #main-container {
            margin-top: 0 !important;
            height: 100vh !important;
          }
          body.editor-content-fullscreen #resize-handle {
            display: none !important;
          }
          body.editor-content-fullscreen #editor-panel .editor-content-header {
            display: none !important;
          }
          /* リサイズハンドル: ホバー時にドラッグカーソルを表示 */
          #resize-handle {
            cursor: col-resize;
          }
          /* ByteMD コンテナサイズ */
          #node-content-editor {
            min-height: 180px;
            height: 265px;
          }
          #node-content-editor .bytemd {
            height: 100%;
            font-size: 14px;
          }
          /* Tailwind Preflight override for ByteMD - flex layout only, no display overrides */
          .bytemd { display: flex !important; flex-direction: column !important; }
          .bytemd-body { display: flex !important; flex: 1 !important; overflow: hidden !important; min-height: 0 !important; }
          .bytemd-editor { flex: 1; overflow: auto; min-width: 0; }
          .bytemd-preview { flex: 1; overflow: auto; min-width: 0; }
          /* Preview-only mode: hide editor, force preview visible, toolbar stays for exiting */
          .bytemd-preview-only .bytemd-editor { display: none !important; }
          .bytemd-preview-only .bytemd-preview { display: block !important; border-left: none !important; }
          /* ByteMD fullscreen: ensure it covers the full viewport */
          .bytemd-fullscreen.bytemd { z-index: 9999 !important; }
          body:has(.bytemd-fullscreen) #main-container,
          body:has(.bytemd-fullscreen) #editor-pane,
          body:has(.bytemd-fullscreen) #editor-panel,
          body:has(.bytemd-fullscreen) .editor-scroll-area,
          body:has(.bytemd-fullscreen) .editor-content-section,
          body:has(.bytemd-fullscreen) .editor-content-body,
          body:has(.bytemd-fullscreen) #node-content-editor { overflow: visible !important; }
          /* Markdown preview content: match the editor pane base size */
          .bytemd-preview .markdown-body { font-size: 14px !important; }
          /* Fullscreen preview should use the available width instead of github-markdown-css max-width */
          .bytemd-fullscreen .bytemd-preview .markdown-body { max-width: none !important; width: 100% !important; margin: 0 !important; }
          /* Preview-only mode should also use the available width */
          .bytemd-preview-only .bytemd-preview .markdown-body { max-width: none !important; width: 100% !important; margin: 0 !important; }
          /* ノードリンク記法 [タイトル (id:xxxxxx)]（タイトルと (id: の間の半角スペースは
             0個以上。nodeLinkPlugin が生成）。
             github-markdown-css の .markdown-body a より強い specificity を持たせる */
          .bytemd-preview .markdown-body a.zeeta-node-link,
          .bytemd-preview a.zeeta-node-link {
            color: #667eea;
            text-decoration: underline;
            cursor: pointer;
          }
          /* Rendered Mermaid diagrams open in a dedicated zoomable viewer. */
          .bytemd-preview .bytemd-mermaid[data-mermaid-viewer-ready="true"] {
            cursor: pointer;
            border-radius: 6px;
            outline: 2px solid transparent;
            outline-offset: 2px;
            transition: background-color 120ms ease, outline-color 120ms ease;
          }
          .bytemd-preview .bytemd-mermaid[data-mermaid-viewer-ready="true"]:hover {
            background-color: #f8fafc;
            outline-color: #cbd5e1;
          }
          .bytemd-preview .bytemd-mermaid[data-mermaid-viewer-ready="true"]:focus-visible {
            outline-color: #2563eb;
          }
          /* HTML code blocks open rendered in a sandboxed viewer tab. */
          .bytemd-preview pre[data-html-viewer-ready="true"] {
            cursor: pointer;
            outline: 2px solid transparent;
            outline-offset: 2px;
            transition: outline-color 120ms ease, box-shadow 120ms ease;
          }
          .bytemd-preview pre[data-html-viewer-ready="true"]:hover {
            outline-color: #cbd5e1;
            box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
          }
          .bytemd-preview pre[data-html-viewer-ready="true"]:focus-visible {
            outline-color: #2563eb;
          }
          /* Markdown preview images open in a dedicated zoomable viewer. */
          .bytemd-preview .markdown-body img[data-image-viewer-ready="true"] {
            cursor: pointer;
            border-radius: 6px;
            outline: 2px solid transparent;
            outline-offset: 2px;
            transition: outline-color 120ms ease, box-shadow 120ms ease;
          }
          .bytemd-preview .markdown-body img[data-image-viewer-ready="true"]:hover {
            outline-color: #cbd5e1;
            box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
          }
          .bytemd-preview .markdown-body img[data-image-viewer-ready="true"]:focus-visible {
            outline-color: #2563eb;
          }
          /* Markdown preview content: fix Tailwind reset for tables */
          .bytemd-preview .markdown-body table { border-collapse: collapse !important; }
          .bytemd-preview .markdown-body th,
          .bytemd-preview .markdown-body td { border: 1px solid #d0d7de !important; padding: 6px 13px !important; }
          .bytemd-preview .markdown-body th { background-color: #f6f8fa !important; font-weight: 600 !important; }
          .bytemd-preview .markdown-body h1,
          .bytemd-preview .markdown-body h2,
          .bytemd-preview .markdown-body h3,
          .bytemd-preview .markdown-body h4 { font-weight: 600 !important; margin-top: 1.2em !important; margin-bottom: 0.6em !important; }
          .bytemd-preview .markdown-body h1 { font-size: 1.8em !important; border-bottom: 1px solid #d0d7de; padding-bottom: 0.3em; }
          .bytemd-preview .markdown-body h2 { font-size: 1.4em !important; border-bottom: 1px solid #d0d7de; padding-bottom: 0.3em; }
          .bytemd-preview .markdown-body p { margin-bottom: 0.8em !important; }
          .bytemd-preview .markdown-body ul,
          .bytemd-preview .markdown-body ol { padding-left: 2em !important; margin-bottom: 0.8em !important; }
          .bytemd-preview .markdown-body ul { list-style-type: disc !important; }
          .bytemd-preview .markdown-body ul ul { list-style-type: circle !important; }
          .bytemd-preview .markdown-body ul ul ul { list-style-type: square !important; }
          .bytemd-preview .markdown-body ol { list-style-type: decimal !important; }
          .bytemd-preview .markdown-body code { background-color: #f6f8fa !important; padding: 2px 5px !important; border-radius: 3px !important; font-size: 0.9em !important; }
          .bytemd-preview .markdown-body pre { background-color: #f6f8fa !important; padding: 12px !important; border-radius: 6px !important; overflow-x: auto !important; font-size: 14px !important; line-height: 1.55 !important; }
          .bytemd-preview .markdown-body pre code { background: none !important; padding: 0 !important; font-size: 1em !important; line-height: inherit !important; }
          .bytemd-preview .markdown-body blockquote { border-left: 4px solid #d0d7de !important; padding-left: 1em !important; color: #656d76 !important; margin: 0.8em 0 !important; }
          .bytemd-toolbar { display: flex !important; align-items: center !important; flex-shrink: 0 !important; }
          .bytemd-toolbar-left, .bytemd-toolbar-right { display: flex !important; align-items: center !important; }
          .bytemd-toolbar-icon { margin-left: 1px !important; margin-right: 1px !important; }
          .markdown-preview {
            line-height: 1.6;
            color: #333;
          }
          .markdown-preview h1 { font-size: 2em; font-weight: bold; margin-top: 0.67em; margin-bottom: 0.67em; }
          .markdown-preview h2 { font-size: 1.5em; font-weight: bold; margin-top: 0.83em; margin-bottom: 0.83em; }
          .markdown-preview h3 { font-size: 1.17em; font-weight: bold; margin-top: 1em; margin-bottom: 1em; }
          .markdown-preview p { margin-top: 1em; margin-bottom: 1em; }
          .markdown-preview ul, .markdown-preview ol { margin-left: 2em; margin-top: 1em; margin-bottom: 1em; }
          .markdown-preview li { margin-top: 0.5em; margin-bottom: 0.5em; }
          .markdown-preview code { background-color: #f4f4f4; padding: 2px 4px; border-radius: 3px; font-family: monospace; }
          .markdown-preview pre { background-color: #f4f4f4; padding: 1em; border-radius: 4px; overflow-x: auto; }
          .markdown-preview pre code { background-color: transparent; padding: 0; }
          .markdown-preview blockquote { border-left: 4px solid #ddd; padding-left: 1em; color: #666; margin: 1em 0; }
          .markdown-preview a { color: #3b82f6; text-decoration: underline; }
          .markdown-preview img { max-width: 100%; height: auto; }
          .markdown-preview table { border-collapse: collapse; width: 100%; margin: 1em 0; }
          .markdown-preview th, .markdown-preview td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          .markdown-preview th { background-color: #f3f4f6; font-weight: bold; }
          .tab-btn { cursor: pointer; padding: 0.5rem 1rem; border-bottom: 2px solid transparent; }
          .tab-btn.active { border-bottom-color: #3b82f6; color: #3b82f6; font-weight: 600; }
          .tree-pane-toolbar {
            padding: 14px 14px 10px;
            border-bottom: 1px solid #e5e7eb;
            background: #ffffff;
          }
          .tree-pane-toolbar-inner {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0;
          }
          .tree-view-tabs {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            padding: 2px;
            border: 1px solid #e5e7eb;
            border-radius: 10px;
            background: #f8fafc;
          }
          .tree-view-tab {
            cursor: pointer;
            transition: all 0.16s ease;
            border: none !important;
            background: transparent;
            color: #6b7280;
            border-radius: 8px;
            padding: 7px 12px;
          }
          .tree-view-tab.active {
            color: #111827;
            background: #ffffff;
            box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
          }
          .tree-view-tab:hover {
            color: #111827;
          }
          .tree-view-tab.tree-view-tab-danger:hover {
            color: #b91c1c;
          }
          .tree-pane-icon-btn {
            width: 32px;
            height: 32px;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            background: #ffffff;
            color: #6b7280;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: all 0.16s ease;
            margin-left: 0;
          }
          .tree-pane-icon-btn:hover {
            background: #f8fafc;
            color: #111827;
          }
          .tree-pane-toolbar-inner .tree-pane-icon-btn + .tree-pane-icon-btn {
            margin-left: 6px;
          }
          #tree-pane {
            background: #ffffff;
          }
          #tree-pane-scroll {
            padding: 10px 12px 14px;
            overflow-x: auto;
            min-width: 0;
          }
          
          /* ローディングオーバーレイ */
          #loading-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            z-index: 9999;
            align-items: center;
            justify-content: center;
          }
          .loading-spinner {
            text-align: center;
            color: white;
          }
          .spinner {
            border: 4px solid rgba(255, 255, 255, 0.3);
            border-top: 4px solid white;
            border-radius: 50%;
            width: 50px;
            height: 50px;
            animation: spin 1s linear infinite;
            margin: 0 auto 16px;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          .loading-text {
            font-size: 16px;
            font-weight: 500;
          }
          
          /* トースト通知 */
          .toast {
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 16px 20px;
            border-radius: 8px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
            display: flex;
            align-items: center;
            gap: 12px;
            z-index: 10000;
            min-width: 320px;
            transform: translateX(400px);
            transition: transform 0.3s ease-out;
          }
          .toast.show {
            transform: translateX(0);
          }
          .toast-success {
            background: #10b981;
            color: white;
          }
          .toast-error {
            background: #ef4444;
            color: white;
          }
          .toast-info {
            background: #2563eb;
            color: white;
          }
          .toast-icon {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            background: white;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            font-size: 16px;
          }
          .toast-success .toast-icon {
            color: #10b981;
          }
          .toast-error .toast-icon {
            color: #ef4444;
          }
          .toast-info .toast-icon {
            color: #2563eb;
          }
          .toast-message {
            flex: 1;
            font-size: 15px;
            font-weight: 500;
            color: white;
          }
          .toast-close {
            background: none;
            border: none;
            font-size: 20px;
            color: white;
            opacity: 0.8;
            cursor: pointer;
            padding: 0;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 4px;
            transition: all 0.2s;
            flex-shrink: 0;
          }
          .toast-close:hover {
            opacity: 1;
            background: rgba(255, 255, 255, 0.2);
          }

          /* デフォルト: フル表示・短縮非表示 */
          .role-label-short {
            display: none;
          }

          @media (max-width: 767px) {
            #node-detail-dialog-panel {
              min-width: calc(100vw - 1rem);
            }
            .node-detail-history-layout {
              grid-template-columns: 1fr;
            }
            /* ヘッダー: 横スクロール対応 */
            #tree-header {
              overflow-x: auto;
              overflow-y: hidden;
            }
            #tree-header > div:first-child {
              gap: 4px !important;
              flex-shrink: 0;
            }
            #history-back-btn {
              margin-left: 2px !important;
            }

            /* ヘッダー: 短縮表示に切り替え */
            .role-label-full {
              display: none;
            }
            .role-label-short {
              display: inline;
            }

            /* 縦並びに切り替え */
            #main-container {
              flex-direction: column !important;
              overflow-y: auto !important;
              overflow-x: hidden !important;
              height: auto !important;
              min-height: calc(100vh - var(--tree-header-height, 48px)) !important;
            }

            /* ツリーペイン: 全幅・高さ固定・縦横スクロール */
            #tree-pane {
              width: 100% !important;
              height: 45vh;
              min-height: 200px;
              overflow-y: auto;
              overflow-x: auto;
              border-right: none !important;
              border-bottom: 1px solid #e5e7eb;
              flex-shrink: 0;
            }

            /* ツリー内スクロールラッパー: 横スクロールを通す */
            #tree-pane-scroll {
              overflow-x: auto;
              overflow-y: auto;
            }

            /* リサイズハンドル: 非表示 */
            #resize-handle {
              display: none !important;
            }

            /* エディタペイン: 全幅・残余スペース */
            #editor-pane {
              width: 100% !important;
              flex: none !important;
              min-height: 55vh;
              overflow-y: auto;
            }
            #editor-panel .editor-content-header {
              top: 0;
            }
            /* 本文の全画面中は裏のページを動かさない（本文の端まで来たスクロールがページへ伝わると、
               iOS では全画面の本文ごとずれる）。高さ・位置は JS が visualViewport に合わせる */
            html.mobile-content-fullscreen,
            html.mobile-content-fullscreen body {
              overflow: hidden !important;
            }
            .bytemd-fullscreen.bytemd {
              height: 100dvh !important;
              bottom: auto;
            }
            .bytemd-fullscreen .bytemd-preview,
            .bytemd-fullscreen .CodeMirror-scroll,
            .bytemd-fullscreen .cm-scroller {
              overscroll-behavior: contain;
            }
          }

          /* --- ダークテーマ（html.theme-dark 配下でのみ効く上書き） ---
             共通の dark.css は Tailwind ユーティリティしか上書きしないため、
             この <style> で定義したページ固有クラスはここで個別に上書きする。
             既存ルールは変更せず追記のみ。トーンは #0f172a/#111827/#1f2937（面）、
             文字 #f3f4f6/#e5e7eb、枠 #374151/#4b5563 で統一する。 */

          /* ツリーヘッダー・ツリーペイン */
          html.theme-dark #tree-header {
            background: #111827;
            border-bottom-color: #374151;
          }
          html.theme-dark .tree-item { color: #f3f4f6; }
          html.theme-dark .tree-item:hover { background-color: #111827; }
          html.theme-dark .tree-item.active {
            background-color: rgba(59, 130, 246, 0.25);
            color: #f3f4f6;
          }
          html.theme-dark .tree-item.duplicate-active {
            background-color: rgba(167, 139, 250, 0.16);
            border-color: #a78bfa;
          }
          html.theme-dark .tree-item-actions {
            background: linear-gradient(to right, rgba(31, 41, 55, 0), #1f2937 14px);
          }
          html.theme-dark .tree-item:hover .tree-item-actions {
            background: linear-gradient(to right, rgba(17, 24, 39, 0), #111827 14px);
          }
          html.theme-dark .tree-item.active .tree-item-actions {
            background: linear-gradient(to right, rgba(59, 130, 246, 0), rgba(59, 130, 246, 0.25) 14px);
          }
          html.theme-dark .tree-item.duplicate-active .tree-item-actions {
            background: linear-gradient(to right, rgba(167, 139, 250, 0), rgba(167, 139, 250, 0.16) 14px);
          }
          html.theme-dark .tree-guide-line { background: rgba(148, 163, 184, 0.18); }
          html.theme-dark .tree-pane-toolbar { background: #1f2937; border-bottom-color: #374151; }
          html.theme-dark .tree-view-tabs { background: #0f172a; border-color: #374151; }
          html.theme-dark .tree-view-tab { color: #9ca3af; }
          html.theme-dark .tree-view-tab.active { color: #f3f4f6; background: #1f2937; }
          html.theme-dark .tree-view-tab:hover { color: #f3f4f6; }
          html.theme-dark .tree-view-tab.tree-view-tab-danger:hover { color: #fca5a5; }
          html.theme-dark .tree-pane-icon-btn { background: #1f2937; border-color: #374151; color: #9ca3af; }
          html.theme-dark .tree-pane-icon-btn:hover { background: #111827; color: #f3f4f6; }
          html.theme-dark #tree-pane { background: #1f2937; border-bottom-color: #374151; }

          /* 履歴ダイアログ・比較オーバーレイ */
          html.theme-dark .node-detail-history-item { border-bottom-color: #374151; }
          html.theme-dark .node-detail-history-item:hover .node-detail-history-row,
          html.theme-dark .node-detail-history-item:hover .node-detail-history-radio-cell { background: #111827; }
          html.theme-dark .node-detail-history-item.is-selected .node-detail-history-row,
          html.theme-dark .node-detail-history-item.is-selected .node-detail-history-radio-cell { background: rgba(59, 130, 246, 0.25); }
          html.theme-dark .node-compare-diff-line.added { background: rgba(46, 160, 67, 0.15); }
          html.theme-dark .node-compare-diff-line.added::before { color: #3fb950; }
          html.theme-dark .node-compare-diff-line.removed { background: rgba(248, 81, 73, 0.15); }
          html.theme-dark .node-compare-diff-line.removed::before { color: #f85149; }
          html.theme-dark #node-compare-diff-strip { background: #111827; border-left-color: #374151; }

          /* CONTENT ヘッダー・本文検索 */
          html.theme-dark #editor-panel .editor-content-header { background: #1f2937; }
          html.theme-dark .content-search-input { background: #111827; border-color: #374151; color: #e5e7eb; }
          html.theme-dark .content-search-input:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.35); }
          html.theme-dark .content-search-submit-btn { background: #1f2937; border-color: #374151; color: #9ca3af; }
          html.theme-dark .content-search-submit-btn:hover { background: #111827; color: #f3f4f6; }
          html.theme-dark .content-search-hit-count { color: #93c5fd; }
          html.theme-dark .content-search-hit-btn { background: #1f2937; border-color: rgba(96, 165, 250, 0.45); color: #93c5fd; }
          html.theme-dark .content-search-hit-btn:hover { background: rgba(59, 130, 246, 0.25); }
          html.theme-dark .content-search-hit-highlight { background: rgba(251, 191, 36, 0.4); color: #f3f4f6; }

          /* プレビュー内ビューア起動対象（mermaid / html / img）のhover枠 */
          html.theme-dark .bytemd-preview .bytemd-mermaid[data-mermaid-viewer-ready="true"]:hover {
            background-color: rgba(255, 255, 255, 0.04);
            outline-color: #4b5563;
          }
          html.theme-dark .bytemd-preview pre[data-html-viewer-ready="true"]:hover { outline-color: #4b5563; }
          html.theme-dark .bytemd-preview .markdown-body img[data-image-viewer-ready="true"]:hover { outline-color: #4b5563; }

          /* ByteMD 本体（GitHub dark 相当） */
          html.theme-dark #editor-panel .editor-content-section.has-sticky-toolbar .bytemd-toolbar {
            background: #161b22;
            border-bottom-color: #30363d;
          }
          html.theme-dark .bytemd { color: #e6edf3; border-color: #30363d; background-color: #0d1117; }
          html.theme-dark .bytemd-toolbar { background-color: #161b22; border-bottom-color: #30363d; }
          html.theme-dark .bytemd-toolbar-icon:hover { background-color: rgba(255, 255, 255, 0.08); }
          html.theme-dark .bytemd-toolbar-tab-active,
          html.theme-dark .bytemd-toolbar-icon-active { color: #58a6ff; }
          html.theme-dark .bytemd-sidebar ul { color: #8b949e; }
          html.theme-dark .bytemd-sidebar-close:hover { color: #58a6ff; }
          html.theme-dark .bytemd-toc-active { color: #58a6ff; background-color: #161b22; }
          html.theme-dark .bytemd-dropdown-title { border-bottom-color: #30363d; color: #c9d1d9; }
          html.theme-dark .bytemd-dropdown-item:hover { background-color: #161b22; }
          html.theme-dark .bytemd-status { border-top-color: #30363d; }
          html.theme-dark .bytemd-split .bytemd-preview { border-left-color: #30363d; }

          /* Markdown プレビュー（github-markdown-css は直値色で配信されるため直値で上書き） */
          html.theme-dark .bytemd-preview .markdown-body {
            color-scheme: dark;
            color: #e6edf3;
            background-color: #0d1117;
          }
          html.theme-dark .bytemd-preview .markdown-body a { color: #58a6ff; }
          html.theme-dark .bytemd-preview .markdown-body h1,
          html.theme-dark .bytemd-preview .markdown-body h2 { border-bottom-color: #30363d; }
          html.theme-dark .bytemd-preview .markdown-body th,
          html.theme-dark .bytemd-preview .markdown-body td { border-color: #30363d !important; }
          html.theme-dark .bytemd-preview .markdown-body th { background-color: #161b22 !important; }
          html.theme-dark .bytemd-preview .markdown-body td { background-color: #0d1117 !important; }
          html.theme-dark .bytemd-preview .markdown-body code { background-color: rgba(110, 118, 129, 0.4) !important; }
          html.theme-dark .bytemd-preview .markdown-body pre { background-color: #161b22 !important; color: #e6edf3 !important; }
          html.theme-dark .bytemd-preview .markdown-body blockquote { border-left-color: #30363d !important; color: #8b949e !important; }
          html.theme-dark .bytemd-preview .markdown-body img { background-color: transparent; }
          html.theme-dark .bytemd-preview .markdown-body hr { background-color: #30363d; }
          html.theme-dark .bytemd-preview .markdown-body kbd {
            background-color: rgba(110, 118, 129, 0.4);
            border-color: #30363d;
            color: #e6edf3;
          }

          /* CodeMirror（編集ペイン。通常は preview-only で非表示）は最低限の暗色化 */
          html.theme-dark .CodeMirror { background: #0d1117; color: #e6edf3; }
          html.theme-dark .CodeMirror-gutters { background: #0d1117; border-right-color: #30363d; }
          html.theme-dark .CodeMirror-linenumber { color: #484f58; }
          html.theme-dark .CodeMirror-cursor { border-left-color: #e6edf3; }
          html.theme-dark .CodeMirror-selected,
          html.theme-dark .CodeMirror-focused .CodeMirror-selected { background: rgba(56, 139, 253, 0.25); }
          html.theme-dark .cm-s-default .cm-keyword { color: #ff7b72; }
          html.theme-dark .cm-s-default .cm-atom { color: #bc8cff; }
          html.theme-dark .cm-s-default .cm-number { color: #79c0ff; }
          html.theme-dark .cm-s-default .cm-def { color: #d2a8ff; }
          html.theme-dark .cm-s-default .cm-variable { color: #e6edf3; }
          html.theme-dark .cm-s-default .cm-variable-2,
          html.theme-dark .cm-s-default .cm-variable-3,
          html.theme-dark .cm-s-default .cm-type { color: #ffa657; }
          html.theme-dark .cm-s-default .cm-property { color: #79c0ff; }
          html.theme-dark .cm-s-default .cm-operator { color: #ff7b72; }
          html.theme-dark .cm-s-default .cm-comment { color: #8b949e; }
          html.theme-dark .cm-s-default .cm-string,
          html.theme-dark .cm-s-default .cm-string-2 { color: #a5d6ff; }
          html.theme-dark .cm-s-default .cm-meta { color: #79c0ff; }
          html.theme-dark .cm-s-default .cm-tag { color: #7ee787; }
          html.theme-dark .cm-s-default .cm-attribute { color: #79c0ff; }
          html.theme-dark .cm-s-default .cm-header { color: #79c0ff; }
          html.theme-dark .cm-s-default .cm-link { color: #a5d6ff; }
          html.theme-dark .bytemd-editor .CodeMirror pre.CodeMirror-placeholder { color: #484f58; }

          /* app.js 側でTailwindクラス化した要素のうち dark.css に対応が無い色 */
          html.theme-dark .text-blue-700 { color: #93c5fd; }
          html.theme-dark .text-green-700 { color: #86efac; }
          html.theme-dark .text-red-900 { color: #fecaca; }
          html.theme-dark .bg-red-100 { background-color: rgba(248, 113, 113, 0.16); }
          html.theme-dark .border-blue-300 { border-color: rgba(96, 165, 250, 0.5); }
          html.theme-dark .border-green-300 { border-color: rgba(134, 239, 172, 0.45); }
        </style>
    </head>
    <body class="bg-gray-50">
        <!-- Tree Header (populated by app.js) -->
        <div id="tree-header"></div>

        <div class="flex" id="main-container" style="height: calc(100vh - var(--tree-header-height, 48px)); margin-top: var(--tree-header-height, 48px); overflow: hidden;">
            ${treeRailHtml}

            <!-- 左ペイン: ツリー表示 -->
            <div class="bg-white border-r border-gray-200 flex flex-col" id="tree-pane" style="width: 33.333%">
                <!-- 固定ヘッダー部分 -->
                <div class="tree-pane-toolbar flex-shrink-0">
                    <div class="tree-pane-toolbar-inner">
                        <div class="tree-view-tabs">
                            <button class="tree-view-tab active text-sm font-medium" data-view="normal" id="normal-view-tab">
                                <i class="fas fa-stream mr-1"></i><span data-i18n="editor.normalView">通常</span> <i class="fas fa-caret-down ml-1 text-xs"></i>
                            </button>
                            <button class="tree-view-tab text-sm font-medium" data-view="reverse">
                                <i class="fas fa-level-up-alt mr-1"></i><span data-i18n="editor.reverseTree">逆ツリー</span>
                            </button>
                            <button class="tree-view-tab tree-view-tab-danger text-sm font-medium" data-view="trash" title="ゴミ箱" aria-label="ゴミ箱" data-i18n-attr="title:editor.trash;aria-label:editor.trash">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                        <div class="flex items-center">
                            <button
                                id="tree-search-btn"
                                class="tree-pane-icon-btn"
                                type="button"
                                title="検索 (Alt+F)"
                                aria-label="検索"
                                data-i18n-attr="title:editor.searchTitle;aria-label:editor.search"
                            >
                                <i class="fas fa-search"></i>
                            </button>
                            <button
                                id="reload-tree-btn"
                                class="tree-pane-icon-btn"
                                type="button"
                                title="ノードを再読み込み (Alt+R)"
                                aria-label="ノードを再読み込み"
                                data-i18n-attr="title:editor.reloadNodesTitle;aria-label:editor.reloadNodes"
                            >
                                <i class="fas fa-sync-alt"></i>
                            </button>
                        </div>
                    </div>
                </div>
                
                <!-- スクロール可能なツリーコンテナ -->
                <div class="flex-1 overflow-y-auto" id="tree-pane-scroll">
                    <div id="tree-container"></div>
                </div>
            </div>
            
            <!-- リサイズハンドル -->
            <div id="resize-handle" class="w-1 bg-gray-300 hover:bg-blue-500 transition-colors"></div>

            <!-- 右ペイン: ノード詳細 -->
            <div class="flex-1 p-0 overflow-hidden" id="editor-pane">
                <div id="editor-panel" class="bg-white rounded-lg shadow px-6 pb-2 pt-0 h-full">
                    <div class="text-center text-gray-400 py-12">
                        <i class="fas fa-arrow-left text-4xl mb-4"></i>
                        <p data-i18n="editor.selectNodePrompt">左側のノードを選択してください</p>
                    </div>
                </div>
            </div>
        </div>

        <!-- Node Detail / Content History Dialog -->
        <div id="node-detail-dialog" class="fixed inset-0 bg-black bg-opacity-50 hidden items-center justify-center z-40" role="dialog" aria-modal="true" aria-labelledby="node-detail-dialog-title">
            <div id="node-detail-dialog-panel" class="bg-white rounded-lg shadow-xl flex flex-col">
                <div class="px-6 py-4 border-b border-gray-200 flex items-center justify-between gap-4">
                    <h2 id="node-detail-dialog-title" class="text-xl font-bold text-gray-800" data-i18n="editor.nodeDetail">node detail</h2>
                    <button id="node-detail-dialog-close" type="button" class="text-gray-400 hover:text-gray-600" aria-label="閉じる" data-i18n-attr="aria-label:common.close">
                        <i class="fas fa-times text-xl"></i>
                    </button>
                </div>
                <div class="px-6 py-3 border-b border-gray-200 text-sm text-gray-600 flex flex-wrap gap-x-6 gap-y-1">
                    <span><span data-i18n="editor.authorLabel">作成者:</span> <span id="node-detail-author"></span></span>
                    <span><span data-i18n="editor.createdDateLabel">作成日:</span> <span id="node-detail-created-at"></span></span>
                    <span><span data-i18n="editor.updaterLabel">更新者:</span> <span id="node-detail-updated-by"></span></span>
                    <span><span data-i18n="editor.updatedDateLabel">更新日:</span> <span id="node-detail-updated-at"></span></span>
                </div>
                <div class="px-6 py-4 flex items-center justify-between gap-4">
                    <h3 class="text-sm font-semibold tracking-widest text-gray-600">CONTENT History</h3>
                    <div class="flex items-center gap-2">
                        <button id="node-detail-compare-btn" type="button" class="px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed" disabled data-i18n="editor.compareVersions">比較</button>
                        <button id="node-detail-restore-btn" type="button" class="hidden px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed" disabled data-i18n="editor.restoreContentVersion">戻す</button>
                    </div>
                </div>
                <div class="node-detail-history-layout px-6 pb-6 flex-1">
                    <div class="node-detail-history-pane border border-gray-200 rounded overflow-hidden min-h-0">
                        <div class="node-detail-history-item bg-gray-50" aria-hidden="true">
                            <span class="node-detail-history-radio-cell"></span>
                            <div class="node-detail-history-row text-xs font-semibold text-gray-500">
                                <span data-i18n="editor.authoredAt" title="その内容が更新された日時" data-i18n-attr="title:editor.authoredAtHelp">更新日時</span>
                                <span data-i18n="editor.updatedBy">更新者</span>
                            </div>
                        </div>
                        <div id="node-detail-history-list"></div>
                    </div>
                    <div class="border border-gray-200 rounded min-h-0 flex flex-col">
                        <div class="px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 flex items-center justify-between gap-2">
                            <span data-i18n="editor.preview">preview</span>
                            <button id="node-detail-copy-btn" type="button" class="w-7 h-7 text-sm border border-gray-200 text-gray-600 rounded hover:bg-gray-100 flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed" title="内容をコピー" aria-label="内容をコピー" data-i18n-attr="title:editor.copyContent;aria-label:editor.copyContent" disabled>
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                    <rect x="5" y="5" width="8" height="9" rx="1.5"></rect>
                                    <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v7A1.5 1.5 0 0 0 3.5 12H5"></path>
                                </svg>
                            </button>
                        </div>
                        <div id="node-detail-preview" class="p-4 text-sm text-gray-800 flex-1"></div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Node History Compare Overlay -->
        <div id="node-compare-overlay" class="fixed inset-0 bg-black bg-opacity-50 hidden items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="node-compare-title">
            <div id="node-compare-panel" class="bg-white rounded-lg shadow-xl flex flex-col">
                <div class="px-6 py-4 border-b border-gray-200 flex items-center justify-between gap-4">
                    <h2 id="node-compare-title" class="text-lg font-bold text-gray-800" data-i18n="editor.compareTitle">履歴の比較</h2>
                    <button id="node-compare-close" type="button" class="text-gray-400 hover:text-gray-600" aria-label="閉じる" data-i18n-attr="aria-label:common.close">
                        <i class="fas fa-times text-xl"></i>
                    </button>
                </div>
                <div class="px-6 py-3 border-b border-gray-200 text-sm text-gray-600 flex flex-wrap gap-x-8 gap-y-1">
                    <span><span class="font-semibold" data-i18n="editor.compareOldLabel">旧:</span> <span id="node-compare-old-label"></span></span>
                    <span><span class="font-semibold" data-i18n="editor.compareNewLabel">新:</span> <span id="node-compare-new-label"></span></span>
                </div>
                <div id="node-compare-status" class="hidden px-6 py-4 text-sm text-gray-500"></div>
                <div id="node-compare-diff-wrap" class="flex-1 min-h-0 flex">
                    <div id="node-compare-diff" class="flex-1 min-h-0 overflow-auto py-2 relative"></div>
                    <div id="node-compare-diff-strip"></div>
                </div>
            </div>
        </div>

        <!-- Version Conflict Resolution Dialog -->
        <div id="conflict-dialog" class="fixed inset-0 bg-black bg-opacity-50 hidden items-center justify-center z-50">
            <div class="bg-white rounded-lg shadow-xl max-w-4xl w-full mx-4 overflow-y-auto" style="max-height: 90vh;">
                <div class="p-6 border-b border-gray-200">
                    <div class="flex items-center justify-between">
                        <h2 class="text-2xl font-bold text-gray-800">
                            <i class="fas fa-exclamation-triangle text-yellow-500 mr-2"></i>
                            <span data-i18n="editor.conflictDetected">競合が検出されました</span>
                        </h2>
                        <button id="conflict-dialog-close" class="text-gray-400 hover:text-gray-600">
                            <i class="fas fa-times text-xl"></i>
                        </button>
                    </div>
                    <p class="text-gray-600 mt-2" data-i18n="editor.conflictDescription">
                        このノードは他のユーザーによって更新されました。以下のいずれかを選択してください。
                    </p>
                </div>

                <div class="p-6 space-y-6">
                    <!-- Your Version -->
                    <div class="border border-blue-200 rounded-lg p-4 bg-blue-50">
                        <h3 class="text-lg font-semibold text-blue-900 mb-3">
                            <i class="fas fa-user mr-2"></i><span data-i18n="editor.yourChanges">あなたの変更</span>
                        </h3>
                        <div class="space-y-3 bg-white p-4 rounded">
                            <div>
                                <label class="text-sm font-medium text-gray-700" data-i18n="editor.titleLabel">タイトル:</label>
                                <div id="conflict-your-title" class="text-gray-900 mt-1"></div>
                            </div>
                            <div>
                                <label class="text-sm font-medium text-gray-700" data-i18n="editor.contentLabel">内容:</label>
                                <div id="conflict-your-content" class="text-gray-900 mt-1 whitespace-pre-wrap max-h-40 overflow-y-auto"></div>
                            </div>
                        </div>
                    </div>

                    <!-- Server Version -->
                    <div class="border border-green-200 rounded-lg p-4 bg-green-50">
                        <h3 class="text-lg font-semibold text-green-900 mb-3">
                            <i class="fas fa-server mr-2"></i><span data-i18n="editor.latestServerVersion">サーバー上の最新バージョン</span>
                        </h3>
                        <div class="space-y-3 bg-white p-4 rounded">
                            <div>
                                <label class="text-sm font-medium text-gray-700" data-i18n="editor.titleLabel">タイトル:</label>
                                <div id="conflict-server-title" class="text-gray-900 mt-1"></div>
                            </div>
                            <div>
                                <label class="text-sm font-medium text-gray-700" data-i18n="editor.contentLabel">内容:</label>
                                <div id="conflict-server-content" class="text-gray-900 mt-1 whitespace-pre-wrap max-h-40 overflow-y-auto"></div>
                            </div>
                            <div class="text-sm text-gray-500">
                                <span><span data-i18n="editor.updatedByLabel">更新者:</span> <span id="conflict-server-author"></span></span>
                                <span class="ml-4"><span data-i18n="editor.versionLabel">バージョン:</span> <span id="conflict-server-version"></span></span>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="p-6 border-t border-gray-200 bg-gray-50 flex gap-3">
                    <button id="conflict-use-server" class="flex-1 px-6 py-3 bg-green-500 text-white rounded-lg hover:bg-green-600 font-medium">
                        <i class="fas fa-check mr-2"></i><span data-i18n="editor.useServerVersion">サーバー版を使用</span>
                        <p class="text-sm mt-1 opacity-90" data-i18n="editor.useServerDescription">あなたの変更を破棄し、サーバーの最新版を使用します</p>
                    </button>
                    <button id="conflict-use-mine" class="flex-1 px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-medium">
                        <i class="fas fa-save mr-2"></i><span data-i18n="editor.keepMyVersion">自分の版を維持</span>
                        <p class="text-sm mt-1 opacity-90" data-i18n="editor.keepMyDescription">サーバー版を上書きして、あなたの変更を保存します</p>
                    </button>
                    <button id="conflict-cancel" class="px-6 py-3 bg-gray-500 text-white rounded-lg hover:bg-gray-600 font-medium">
                        <i class="fas fa-times mr-2"></i><span data-i18n="common.cancel">キャンセル</span>
                    </button>
                </div>
            </div>
        </div>

        <!-- ツリー管理モーダルは body 末尾に置く（編集画面の既存ボタンより後ろにして、文書順での取り違えを防ぐ） -->
        ${treeModalsHtml}

        <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js" integrity="sha384-VekiXfVDZuqx75T/YaGfn7/p6+e+D0f/G8UoZ5GBOCMZ89kMW4wTo8PSn6GSzOEl" crossorigin="anonymous"></script>
        <script src="https://cdn.jsdelivr.net/npm/marked@11.0.0/marked.min.js" integrity="sha384-4Tu0AVV0VM7dUwfPXGZDt6OI+2sNBSrQZe1Gmz87gzoio1n3IeHCMwRrfqSi4/Oh" crossorigin="anonymous"></script>
        <script src="https://cdn.jsdelivr.net/npm/dompurify@3.4.17/dist/purify.min.js" integrity="sha384-P0JNneQf81HOl9VwNXK76cQ9VMD6Nfsnepxb0cCOg8+UzEdzgPHAPV4wVQrvYQSx" crossorigin="anonymous"></script>
        <script src="/static/auth-session.js"></script>
        <script src="/static/notifications.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/bytemd@1.22.0/dist/index.umd.js" integrity="sha384-bIIv3xtXUGpes1ZcdLIuJTl+tSoI4kruALsatRoNS8n1OZt5g0rTaFtL+SKXP/l6" crossorigin="anonymous"></script>
        <script src="https://cdn.jsdelivr.net/npm/@bytemd/plugin-gfm@1.22.0/dist/index.umd.js" integrity="sha384-E2I7HIaqzslp/ofDe5mT4ikRcLlXJ1snxTUupAaI4WSyumeAfgEfGV7+Q4r+Khab" crossorigin="anonymous"></script>
        <script src="https://cdn.jsdelivr.net/npm/diff@8.0.2/dist/diff.min.js" integrity="sha384-oPSCx8WsJHSoGaPlrUMvQixHtl2+IG/sMcKvXy1k+sXxglupjN5LOu7e24GzAHRp" crossorigin="anonymous"></script>
        <script>window.__BUILD_STAMP__ = '${__BUILD_STAMP__}';</script>
        <script src="/static/table-editor.js?v=${__BUILD_STAMP__}"></script>
        <script src="/static/version-check.js?v=${__BUILD_STAMP__}"></script>
        <script src="/static/tree-rail.js?v=${__BUILD_STAMP__}"></script>
        <!-- ここまで解析してから最初の描画をする（左バーを前ページの一覧で描いた後に、切替アニメーションの比較をさせる） -->
        <div id="tree-rail-render-ready" hidden></div>
        <script src="/static/app.js?v=${__BUILD_STAMP__}"></script>
    </body>
    </html>
  `

// Root route - Editor
app.get('/', (c) => c.html(localizedHtml(c, getEditorHTML())))

// /index.html route - Same as root
app.get('/index.html', (c) => c.html(localizedHtml(c, getEditorHTML())))

export default app
