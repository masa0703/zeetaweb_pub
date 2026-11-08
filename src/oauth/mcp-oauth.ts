/**
 * MCP OAuth 2.1 Authorization Server / Resource Server helpers
 *
 * Zeeta 自身が Authorization Server と Resource Server を兼ねる。
 *
 * 設計上の固定要件:
 * - Authorization Code + PKCE(S256) のみ。implicit / password grant は非対応
 * - public client のみ（token_endpoint_auth_method = none）
 * - access token / refresh token / authorization code は平文保存せず SHA-256 hex を保存
 * - token は resource（ツリー固有 MCP URL）へ完全一致で束縛される
 * - 権限は token の scope と「毎リクエスト時点の tree_members.role」の積で決まる
 */

import type { Role } from '../utils/permissions'
import type { McpPermissionPreset } from '../mcp/tool-registry'

export const MCP_OAUTH_SCOPE_READ = 'mcp:read'
export const MCP_OAUTH_SCOPE_WRITE = 'mcp:write'
export const MCP_OAUTH_SUPPORTED_SCOPES = [MCP_OAUTH_SCOPE_READ, MCP_OAUTH_SCOPE_WRITE] as const

export type McpOAuthScope = typeof MCP_OAUTH_SUPPORTED_SCOPES[number]

export const MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60
export const MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
export const MCP_OAUTH_CODE_TTL_SECONDS = 60
export const MCP_OAUTH_AUTHORIZATION_REQUEST_TTL_SECONDS = 10 * 60

const MCP_OAUTH_ACCESS_TOKEN_PREFIX = 'zoa_'
const MCP_OAUTH_REFRESH_TOKEN_PREFIX = 'zor_'
const MCP_OAUTH_CODE_PREFIX = 'zoc_'
const MCP_OAUTH_CLIENT_ID_PREFIX = 'zcl_'

const MCP_OAUTH_MAX_REDIRECT_URIS = 8
export const MCP_OAUTH_REGISTER_MAX_BODY_BYTES = 16 * 1024
const MCP_OAUTH_MAX_URI_LENGTH = 512
const MCP_OAUTH_MAX_CLIENT_NAME_LENGTH = 120

export const MCP_RESOURCE_PATH_PREFIX = '/api/mcp/trees/'

export type McpOAuthClientRow = {
  id: number
  client_id: string
  client_name: string | null
  client_uri: string | null
  redirect_uris: string
  grant_types: string
  response_types: string
  token_endpoint_auth_method: string
  scope: string | null
}

export type McpOAuthAuthorizationRequestRow = {
  id: number
  request_id: string
  client_id: string
  user_id: number
  tree_id: number
  resource: string
  scope: string
  redirect_uri: string
  state: string | null
  code_challenge: string
  code_challenge_method: string
}

export type McpOAuthCodeRow = {
  id: number
  client_id: string
  user_id: number
  tree_id: number
  resource: string
  scope: string
  redirect_uri: string
  code_challenge: string
  code_challenge_method: string
}

export type McpOAuthTokenRow = {
  id: number
  token_type: string
  client_id: string
  user_id: number
  tree_id: number
  resource: string
  scope: string
  refresh_token_id: number | null
  rotation_root_id: number | null
  expires_at: string
  revoked_at: string | null
  /** access token の場合、発行元 refresh token の失効日時（NULLなら親は有効） */
  parent_revoked_at?: string | null
}

export type McpOAuthTreeRow = {
  id: number
  name: string
  root_node_id: number
}

export type IssuedTokenPair = {
  accessToken: string
  refreshToken: string
  expiresIn: number
  scope: string
  /** 発行した refresh token の行ID */
  refreshTokenId: number | null
  /** この token 対が属する rotation chain の識別子 */
  rotationRootId: number | null
}

// ============================================
// 低レベルユーティリティ
// ============================================

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomSecret(prefix: string): string {
  const random = new Uint8Array(32)
  crypto.getRandomValues(random)
  return `${prefix}${base64UrlFromBytes(random)}`
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function toSqlDatetime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

function expiresAtFromNow(seconds: number): string {
  return toSqlDatetime(new Date(Date.now() + seconds * 1000))
}

/**
 * PKCE S256 検証。code_verifier は RFC 7636 の文字種・長さ制約も検証する。
 */
export async function verifyPkceS256(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) {
    return false
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  return base64UrlFromBytes(new Uint8Array(digest)) === codeChallenge
}

// ============================================
// resource（ツリー固有 MCP URL）
// ============================================

export function buildMcpResourceUrl(origin: string, treeId: number): string {
  return `${origin}${MCP_RESOURCE_PATH_PREFIX}${treeId}`
}

/**
 * RFC 8707 の resource indicator を正規化する。
 * fragment 付き・相対URL・末尾スラッシュ差異は許容しない（末尾スラッシュのみ除去）。
 */
export function normalizeResourceIndicator(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.hash) return null
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const pathname = url.pathname.length > 1 && url.pathname.endsWith('/')
    ? url.pathname.slice(0, -1)
    : url.pathname
  return `${url.origin.toLowerCase()}${pathname}${url.search}`
}

/**
 * resource が「このオリジンのツリー固有 MCP URL」であることを検証し tree_id を返す。
 */
export function parseTreeIdFromResource(resource: string, origin: string): number | null {
  const normalized = normalizeResourceIndicator(resource)
  if (!normalized) return null
  const expectedPrefix = `${origin.toLowerCase()}${MCP_RESOURCE_PATH_PREFIX}`
  if (!normalized.startsWith(expectedPrefix)) return null
  const rest = normalized.slice(expectedPrefix.length)
  if (!/^[1-9][0-9]{0,17}$/.test(rest)) return null
  return Number(rest)
}

export async function getActiveTree(db: D1Database, treeId: number): Promise<McpOAuthTreeRow | null> {
  const row = await db.prepare(
    `SELECT id, name, root_node_id
     FROM trees
     WHERE id = ? AND (is_deleted = 0 OR is_deleted IS NULL)`
  ).bind(treeId).first<McpOAuthTreeRow>()
  return row || null
}

// ============================================
// scope と role
// ============================================

export function isMcpOAuthScope(value: string): value is McpOAuthScope {
  return value === MCP_OAUTH_SCOPE_READ || value === MCP_OAUTH_SCOPE_WRITE
}

/**
 * scope パラメータを解析する。未知の scope が含まれる場合は null（invalid_scope）。
 * 未指定（空文字/undefined）は null ではなく空配列ではなく「省略」として undefined を返す。
 */
export function parseScopeParam(raw: string | undefined | null): McpOAuthScope[] | null | undefined {
  if (raw === undefined || raw === null || raw.trim() === '') return undefined
  const requested = raw.trim().split(/\s+/)
  const parsed: McpOAuthScope[] = []
  for (const scope of requested) {
    if (!isMcpOAuthScope(scope)) return null
    if (!parsed.includes(scope)) parsed.push(scope)
  }
  return parsed
}

export function roleAllowedScopes(role: Role): McpOAuthScope[] {
  if (role === 'owner' || role === 'editor') {
    return [MCP_OAUTH_SCOPE_READ, MCP_OAUTH_SCOPE_WRITE]
  }
  return [MCP_OAUTH_SCOPE_READ]
}

/**
 * 要求 scope と role 許容 scope の積を取る。
 * - mcp:read は member であれば常に付与する
 * - viewer が mcp:write を要求した場合はエラーにせず read へダウングレードする
 */
export function grantedScopeForRole(requested: McpOAuthScope[] | undefined, role: Role): string {
  const allowed = roleAllowedScopes(role)
  const target = requested ?? allowed
  const granted = [MCP_OAUTH_SCOPE_READ, ...target.filter((scope) => allowed.includes(scope))]
  return Array.from(new Set(granted)).join(' ')
}

export function scopeIncludes(scope: string, target: McpOAuthScope): boolean {
  return scope.split(/\s+/).includes(target)
}

export function permissionPresetForOAuth(scope: string, role: Role): McpPermissionPreset {
  const canWrite = (role === 'owner' || role === 'editor') && scopeIncludes(scope, MCP_OAUTH_SCOPE_WRITE)
  return canWrite ? 'full_access' : 'read_only'
}

// ============================================
// クライアント登録（DCR）
// ============================================

export function isAllowedRedirectUri(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MCP_OAUTH_MAX_URI_LENGTH) {
    return false
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  // fragment 付き redirect_uri は禁止（RFC 6749 3.1.2）
  if (url.hash) return false
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    // loopback のみ HTTP を許可（CLI クライアントのローカルコールバック用）
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  }
  return false
}

export type ClientRegistrationInput = {
  clientName?: unknown
  clientUri?: unknown
  redirectUris?: unknown
  grantTypes?: unknown
  responseTypes?: unknown
  tokenEndpointAuthMethod?: unknown
  scope?: unknown
}

export type ClientRegistrationResult =
  | { ok: true; client: McpOAuthClientRow; redirectUris: string[] }
  | { ok: false; error: string; description: string }

function normalizeStringArray(value: unknown, maxItems?: number): string[] | null {
  if (!Array.isArray(value)) return null
  if (maxItems !== undefined && value.length > maxItems) return null
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    if (!result.includes(item)) result.push(item)
  }
  return result
}

export async function registerOAuthClient(
  db: D1Database,
  input: ClientRegistrationInput,
): Promise<ClientRegistrationResult> {
  if (Array.isArray(input.redirectUris) && input.redirectUris.length > MCP_OAUTH_MAX_REDIRECT_URIS) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description: `redirect_uris must contain ${MCP_OAUTH_MAX_REDIRECT_URIS} entries or less`,
    }
  }
  const redirectUris = normalizeStringArray(input.redirectUris, MCP_OAUTH_MAX_REDIRECT_URIS)
  if (!redirectUris || redirectUris.length === 0) {
    return { ok: false, error: 'invalid_redirect_uri', description: 'redirect_uris is required' }
  }
  for (const uri of redirectUris) {
    if (!isAllowedRedirectUri(uri)) {
      return {
        ok: false,
        error: 'invalid_redirect_uri',
        description: `redirect_uri is not allowed: ${uri} (https, or http on loopback only)`,
      }
    }
  }

  const grantTypes = input.grantTypes === undefined
    ? ['authorization_code', 'refresh_token']
    : normalizeStringArray(input.grantTypes)
  if (!grantTypes) {
    return { ok: false, error: 'invalid_client_metadata', description: 'grant_types must be an array of strings' }
  }
  for (const grantType of grantTypes) {
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      return {
        ok: false,
        error: 'invalid_client_metadata',
        description: `unsupported grant_type: ${grantType}`,
      }
    }
  }
  if (!grantTypes.includes('authorization_code')) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      description: 'grant_types must include authorization_code',
    }
  }

  const responseTypes = input.responseTypes === undefined ? ['code'] : normalizeStringArray(input.responseTypes)
  if (!responseTypes) {
    return { ok: false, error: 'invalid_client_metadata', description: 'response_types must be an array of strings' }
  }
  for (const responseType of responseTypes) {
    if (responseType !== 'code') {
      return {
        ok: false,
        error: 'invalid_client_metadata',
        description: `unsupported response_type: ${responseType}`,
      }
    }
  }

  const authMethod = input.tokenEndpointAuthMethod === undefined
    ? 'none'
    : String(input.tokenEndpointAuthMethod)
  if (authMethod !== 'none') {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      description: 'only public clients are supported (token_endpoint_auth_method must be none)',
    }
  }

  let scope: string | null = null
  if (input.scope !== undefined) {
    const parsed = parseScopeParam(String(input.scope))
    if (parsed === null) {
      return {
        ok: false,
        error: 'invalid_client_metadata',
        description: `scope must be a subset of: ${MCP_OAUTH_SUPPORTED_SCOPES.join(' ')}`,
      }
    }
    scope = parsed === undefined ? null : parsed.join(' ')
  }

  const clientName = typeof input.clientName === 'string'
    ? input.clientName.trim().slice(0, MCP_OAUTH_MAX_CLIENT_NAME_LENGTH)
    : null
  const clientUri = typeof input.clientUri === 'string' && input.clientUri.length <= MCP_OAUTH_MAX_URI_LENGTH
    ? input.clientUri
    : null

  const clientId = randomSecret(MCP_OAUTH_CLIENT_ID_PREFIX)
  const created = await db.prepare(
    `INSERT INTO mcp_oauth_clients
       (client_id, client_name, client_uri, redirect_uris, grant_types, response_types, token_endpoint_auth_method, scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id, client_id, client_name, client_uri, redirect_uris, grant_types, response_types, token_endpoint_auth_method, scope`
  ).bind(
    clientId,
    clientName,
    clientUri,
    JSON.stringify(redirectUris),
    JSON.stringify(grantTypes),
    JSON.stringify(responseTypes),
    authMethod,
    scope,
  ).first<McpOAuthClientRow>()

  if (!created) {
    return { ok: false, error: 'server_error', description: 'failed to register client' }
  }

  return { ok: true, client: created, redirectUris }
}

export async function getOAuthClient(db: D1Database, clientId: string): Promise<McpOAuthClientRow | null> {
  if (!clientId) return null
  const row = await db.prepare(
    `SELECT id, client_id, client_name, client_uri, redirect_uris, grant_types, response_types, token_endpoint_auth_method, scope
     FROM mcp_oauth_clients
     WHERE client_id = ?`
  ).bind(clientId).first<McpOAuthClientRow>()
  return row || null
}

export function clientRedirectUris(client: McpOAuthClientRow): string[] {
  try {
    const parsed = JSON.parse(client.redirect_uris)
    return Array.isArray(parsed) ? parsed.filter((uri): uri is string => typeof uri === 'string') : []
  } catch {
    return []
  }
}

export function clientGrantTypes(client: McpOAuthClientRow): string[] {
  try {
    const parsed = JSON.parse(client.grant_types)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

// ============================================
// authorization request（同意待ち）
// ============================================

/**
 * 期限切れの一時レコードを掃除する（best-effort・失敗しても本処理は継続する）。
 * 専用のバッチが無い構成なので、発行系の処理に相乗りさせて無制限な増加を防ぐ。
 */
async function purgeExpired(db: D1Database, table: string, keepInterval: string): Promise<void> {
  try {
    await db.prepare(`DELETE FROM ${table} WHERE expires_at < datetime('now', ?)`).bind(keepInterval).run()
  } catch {
    // best-effort
  }
}

/** DCR client records are cleaned opportunistically with the other OAuth records. */
export async function purgeExpiredOAuthClients(db: D1Database, now = new Date()): Promise<void> {
  const nowIso = now.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
  try {
    const stale = `(
      (created_at < datetime(?, '-1 day') AND NOT EXISTS (
        SELECT 1 FROM mcp_oauth_tokens t WHERE t.client_id = mcp_oauth_clients.client_id
      ))
      OR
      (NOT EXISTS (
        SELECT 1 FROM mcp_oauth_tokens t
        WHERE t.client_id = mcp_oauth_clients.client_id
          AND t.revoked_at IS NULL AND t.expires_at > datetime(?)
      ) AND EXISTS (
        SELECT 1 FROM mcp_oauth_tokens t WHERE t.client_id = mcp_oauth_clients.client_id
      ) AND (SELECT MAX(t.created_at) FROM mcp_oauth_tokens t
             WHERE t.client_id = mcp_oauth_clients.client_id) < datetime(?, '-30 day'))
    )`
    for (const table of ['mcp_oauth_authorization_requests', 'mcp_oauth_authorization_codes', 'mcp_oauth_tokens']) {
      await db.prepare(`DELETE FROM ${table} WHERE client_id IN (SELECT client_id FROM mcp_oauth_clients WHERE ${stale})`)
        .bind(nowIso, nowIso, nowIso).run()
    }
    await db.prepare(`DELETE FROM mcp_oauth_clients WHERE ${stale}`).bind(nowIso, nowIso, nowIso).run()
  } catch {
    // best-effort; registration/token issuance must continue
  }
}

export async function createAuthorizationRequest(
  db: D1Database,
  params: {
    clientId: string
    userId: number
    treeId: number
    resource: string
    scope: string
    redirectUri: string
    state: string | null
    codeChallenge: string
    codeChallengeMethod: string
  },
): Promise<string> {
  await purgeExpiredOAuthClients(db)
  await purgeExpired(db, 'mcp_oauth_authorization_requests', '-1 day')
  const requestId = randomSecret('zar_')
  await db.prepare(
    `INSERT INTO mcp_oauth_authorization_requests
       (request_id, client_id, user_id, tree_id, resource, scope, redirect_uri, state, code_challenge, code_challenge_method, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    requestId,
    params.clientId,
    params.userId,
    params.treeId,
    params.resource,
    params.scope,
    params.redirectUri,
    params.state,
    params.codeChallenge,
    params.codeChallengeMethod,
    expiresAtFromNow(MCP_OAUTH_AUTHORIZATION_REQUEST_TTL_SECONDS),
  ).run()
  return requestId
}

/**
 * 同意待ちリクエストを一回限りで消費する。
 */
export async function consumeAuthorizationRequest(
  db: D1Database,
  requestId: string,
): Promise<McpOAuthAuthorizationRequestRow | null> {
  if (!requestId) return null
  const row = await db.prepare(
    `UPDATE mcp_oauth_authorization_requests
     SET consumed_at = CURRENT_TIMESTAMP
     WHERE request_id = ? AND consumed_at IS NULL AND expires_at > datetime('now')
     RETURNING id, request_id, client_id, user_id, tree_id, resource, scope, redirect_uri, state, code_challenge, code_challenge_method`
  ).bind(requestId).first<McpOAuthAuthorizationRequestRow>()
  return row || null
}

// ============================================
// authorization code
// ============================================

export async function issueAuthorizationCode(
  db: D1Database,
  params: {
    clientId: string
    userId: number
    treeId: number
    resource: string
    scope: string
    redirectUri: string
    codeChallenge: string
    codeChallengeMethod: string
  },
): Promise<string> {
  await purgeExpired(db, 'mcp_oauth_authorization_codes', '-1 day')
  const code = randomSecret(MCP_OAUTH_CODE_PREFIX)
  await db.prepare(
    `INSERT INTO mcp_oauth_authorization_codes
       (code_hash, client_id, user_id, tree_id, resource, scope, redirect_uri, code_challenge, code_challenge_method, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    await sha256Hex(code),
    params.clientId,
    params.userId,
    params.treeId,
    params.resource,
    params.scope,
    params.redirectUri,
    params.codeChallenge,
    params.codeChallengeMethod,
    expiresAtFromNow(MCP_OAUTH_CODE_TTL_SECONDS),
  ).run()
  return code
}

/**
 * authorization code を一回限りで消費する（consumed_at を条件に含めて再利用を防ぐ）。
 */
export async function consumeAuthorizationCode(db: D1Database, code: string): Promise<McpOAuthCodeRow | null> {
  if (!code) return null
  const row = await db.prepare(
    `UPDATE mcp_oauth_authorization_codes
     SET consumed_at = CURRENT_TIMESTAMP
     WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > datetime('now')
     RETURNING id, client_id, user_id, tree_id, resource, scope, redirect_uri, code_challenge, code_challenge_method`
  ).bind(await sha256Hex(code)).first<McpOAuthCodeRow>()
  return row || null
}

// ============================================
// access / refresh token
// ============================================

export async function issueTokenPair(
  db: D1Database,
  params: {
    clientId: string
    userId: number
    treeId: number
    resource: string
    scope: string
    rotatedFromTokenId?: number | null
    /** rotation chain の識別子。省略時は発行した refresh 自身が chain の起点になる */
    rotationRootId?: number | null
  },
): Promise<IssuedTokenPair> {
  await purgeExpiredOAuthClients(db)
  await purgeExpired(db, 'mcp_oauth_tokens', '-30 day')
  const refreshToken = randomSecret(MCP_OAUTH_REFRESH_TOKEN_PREFIX)
  const refreshRow = await db.prepare(
    `INSERT INTO mcp_oauth_tokens
       (token_hash, token_type, client_id, user_id, tree_id, resource, scope, rotated_from_token_id, rotation_root_id, expires_at)
     VALUES (?, 'refresh', ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`
  ).bind(
    await sha256Hex(refreshToken),
    params.clientId,
    params.userId,
    params.treeId,
    params.resource,
    params.scope,
    params.rotatedFromTokenId ?? null,
    params.rotationRootId ?? null,
    expiresAtFromNow(MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS),
  ).first<{ id: number }>()

  // chain の起点は、rotation なら継承した値、新規認可なら発行した refresh 自身
  const rotationRootId = params.rotationRootId ?? refreshRow?.id ?? null
  if (params.rotationRootId == null && refreshRow?.id) {
    await db.prepare('UPDATE mcp_oauth_tokens SET rotation_root_id = id WHERE id = ?')
      .bind(refreshRow.id)
      .run()
  }

  const accessToken = randomSecret(MCP_OAUTH_ACCESS_TOKEN_PREFIX)
  await db.prepare(
    `INSERT INTO mcp_oauth_tokens
       (token_hash, token_type, client_id, user_id, tree_id, resource, scope, refresh_token_id, rotation_root_id, expires_at)
     VALUES (?, 'access', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    await sha256Hex(accessToken),
    params.clientId,
    params.userId,
    params.treeId,
    params.resource,
    params.scope,
    refreshRow?.id ?? null,
    rotationRootId,
    expiresAtFromNow(MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS),
  ).run()

  return {
    accessToken,
    refreshToken,
    expiresIn: MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    scope: params.scope,
    refreshTokenId: refreshRow?.id ?? null,
    rotationRootId,
  }
}

export async function findTokenRow(
  db: D1Database,
  token: string,
  tokenType: 'access' | 'refresh',
): Promise<McpOAuthTokenRow | null> {
  if (!token) return null
  const row = await db.prepare(
    `SELECT t.id, t.token_type, t.client_id, t.user_id, t.tree_id, t.resource, t.scope,
            t.refresh_token_id, t.rotation_root_id, t.expires_at, t.revoked_at,
            p.revoked_at AS parent_revoked_at
     FROM mcp_oauth_tokens t
     LEFT JOIN mcp_oauth_tokens p ON p.id = t.refresh_token_id
     WHERE t.token_hash = ? AND t.token_type = ?`
  ).bind(await sha256Hex(token), tokenType).first<McpOAuthTokenRow>()
  return row || null
}

export function isTokenRowUsable(row: McpOAuthTokenRow | null): boolean {
  if (!row) return false
  if (row.revoked_at) return false
  // 発行元 refresh が失効していれば access token も使えない。
  // rotation で family が入れ替わった直後の access token を、cascade UPDATE の
  // 到達漏れに依存せず確実に無効化するため、参照時に親を見る
  if (row.parent_revoked_at) return false
  return row.expires_at > toSqlDatetime(new Date())
}

export async function touchAccessToken(db: D1Database, tokenId: number): Promise<void> {
  await db.prepare('UPDATE mcp_oauth_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(tokenId)
    .run()
}

export async function revokeTokenRow(db: D1Database, tokenId: number): Promise<void> {
  await db.prepare(
    `UPDATE mcp_oauth_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL`
  ).bind(tokenId).run()
}

/**
 * refresh token を rotation する（旧 refresh とその派生 access を失効させる）。
 */
export async function revokeRefreshTokenFamily(db: D1Database, refreshTokenId: number): Promise<void> {
  await db.prepare(
    `UPDATE mcp_oauth_tokens
     SET revoked_at = CURRENT_TIMESTAMP
     WHERE revoked_at IS NULL AND (id = ? OR refresh_token_id = ?)`
  ).bind(refreshTokenId, refreshTokenId).run()
}

/**
 * 失効済み refresh token が属する rotation family（同じ rotation_root_id）に、
 * まだ生きている refresh token が存在するかを判定する。
 *
 * MCP クライアントは rotation で返ってきた新しい refresh_token を保存し直さず、
 * 古い refresh を使い続けることがある（複数プロセスでの資格情報共有、永続化漏れなど）。
 * 経過時間で判定すると、古い refresh を使い続けるだけの正常なクライアントを締め出して
 * しまうため、**時間ではなく family がまだ生きているか**で判定する。
 * 生きていればリトライとして新しいトークン対を再発行し、生きていない場合のみ
 * （明示 revoke / メンバー解除で family 全体が死んでいる場合のみ）拒否する。
 */
export async function isRefreshFamilyAlive(db: D1Database, refreshTokenId: number): Promise<boolean> {
  const row = await db.prepare(
    `SELECT EXISTS (
       SELECT 1 FROM mcp_oauth_tokens f
       WHERE f.rotation_root_id = (SELECT COALESCE(t.rotation_root_id, t.id) FROM mcp_oauth_tokens t WHERE t.id = ?)
         AND f.token_type = 'refresh'
         AND f.revoked_at IS NULL
         AND f.expires_at > datetime('now')
     ) AS family_alive`
  ).bind(refreshTokenId).first<{ family_alive: number }>()

  return row?.family_alive === 1
}

export type RotatedTokenPair = Pick<IssuedTokenPair, 'accessToken' | 'refreshToken' | 'expiresIn' | 'scope'>

/**
 * refresh token を rotation する（旧 refresh の失効・新しい refresh/access の発行・
 * 同じ chain に残っている古い生存者の prune）を **1回の D1 batch（単一トランザクション）** で行う。
 *
 * 目的: これらを逐次 `await` に分けていた旧実装では、旧 refresh を失効させた直後・
 * 新しい token 対を発行する前に例外（D1の一過性エラーなど）が起きると、後継を一切
 * 発行しないまま旧 refresh だけが失効済みで残った。この状態は family に生存 refresh が
 * 0本＝`isRefreshFamilyAlive()` が false になる状態そのもので、再認可以外に復旧手段が
 * 無くなる（本番の `mcp_oauth.server_error` 直後に `refresh_revoked` が発生した実例で確認）。
 * batch化により「全部成功」か「何も変わらない（旧 refresh は生きたまま）」のどちらかに
 * 限定し、中間状態が発生しないようにする。
 *
 * 新しい access token の `refresh_token_id` と prune 対象の比較 id は、batch 内で
 * INSERT が返す自動採番 id を JS 側で受け渡せない（D1 batch は各文を実行前に静的に
 * prepare するため）ので、事前に採番した `token_hash` をキーにした相関サブクエリで解決する。
 *
 * 起点（`oldRefreshTokenId`）を起点とした rotated_from_token_id の再帰 chain 全体を
 * 常に失効させる。通常の rotation では子孫が存在しないため実質「起点1本 + その派生
 * access」の失効になり、並行した重複リクエスト（同じ古い refresh を複数リクエストが
 * ほぼ同時に提示するケース）でも、後から実行される batch が前段の生存子孫を道連れに
 * 畳んでから新しい1本を積むため、family に生存 refresh が2本以上残る分岐が起きない。
 */
export async function rotateRefreshToken(
  db: D1Database,
  params: {
    oldRefreshTokenId: number
    rotationRootId: number
    clientId: string
    userId: number
    treeId: number
    resource: string
    scope: string
  },
): Promise<RotatedTokenPair> {
  await purgeExpired(db, 'mcp_oauth_tokens', '-30 day')

  const refreshToken = randomSecret(MCP_OAUTH_REFRESH_TOKEN_PREFIX)
  const refreshTokenHash = await sha256Hex(refreshToken)
  const accessToken = randomSecret(MCP_OAUTH_ACCESS_TOKEN_PREFIX)
  const accessTokenHash = await sha256Hex(accessToken)
  const refreshExpiresAt = expiresAtFromNow(MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS)
  const accessExpiresAt = expiresAtFromNow(MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS)

  await db.batch([
    // 1. 起点 refresh の rotation chain（子孫含む）と、そこから派生した access を失効させる
    db.prepare(
      `WITH RECURSIVE chain(id) AS (
         SELECT ?
         UNION
         SELECT t.id FROM mcp_oauth_tokens t JOIN chain c ON t.rotated_from_token_id = c.id
       )
       UPDATE mcp_oauth_tokens
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE revoked_at IS NULL
         AND (id IN (SELECT id FROM chain) OR refresh_token_id IN (SELECT id FROM chain))`
    ).bind(params.oldRefreshTokenId),

    // 2. 新しい refresh を発行
    db.prepare(
      `INSERT INTO mcp_oauth_tokens
         (token_hash, token_type, client_id, user_id, tree_id, resource, scope, rotated_from_token_id, rotation_root_id, expires_at)
       VALUES (?, 'refresh', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      refreshTokenHash,
      params.clientId,
      params.userId,
      params.treeId,
      params.resource,
      params.scope,
      params.oldRefreshTokenId,
      params.rotationRootId,
      refreshExpiresAt,
    ),

    // 3. 新しい access を発行（refresh_token_id は token_hash 経由の相関サブクエリで解決）
    db.prepare(
      `INSERT INTO mcp_oauth_tokens
         (token_hash, token_type, client_id, user_id, tree_id, resource, scope, refresh_token_id, rotation_root_id, expires_at)
       VALUES (?, 'access', ?, ?, ?, ?, ?,
         (SELECT id FROM mcp_oauth_tokens WHERE token_hash = ? AND token_type = 'refresh'),
         ?, ?)`
    ).bind(
      accessTokenHash,
      params.clientId,
      params.userId,
      params.treeId,
      params.resource,
      params.scope,
      refreshTokenHash,
      params.rotationRootId,
      accessExpiresAt,
    ),

    // 4. 同じ chain に残っている（並行 rotation で生じた）自分より古い生存 refresh を失効
    db.prepare(
      `UPDATE mcp_oauth_tokens
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE revoked_at IS NULL
         AND rotation_root_id = ?
         AND id < (SELECT id FROM mcp_oauth_tokens WHERE token_hash = ? AND token_type = 'refresh')`
    ).bind(params.rotationRootId, refreshTokenHash),
  ])

  return {
    accessToken,
    refreshToken,
    expiresIn: MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    scope: params.scope,
  }
}

/**
 * メンバー解除など、ユーザーがツリーへのアクセス権を失った場合に token を即時失効させる。
 */
export async function revokeTokensForUserTree(
  db: D1Database,
  params: { userId: number; treeId: number },
): Promise<void> {
  await db.prepare(
    `UPDATE mcp_oauth_tokens
     SET revoked_at = CURRENT_TIMESTAMP
     WHERE revoked_at IS NULL AND user_id = ? AND tree_id = ?`
  ).bind(params.userId, params.treeId).run()
}

export async function revokeTokenByValue(db: D1Database, token: string, clientId: string | null): Promise<void> {
  const tokenHash = await sha256Hex(token)
  if (clientId) {
    await db.prepare(
      `UPDATE mcp_oauth_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND client_id = ? AND revoked_at IS NULL`
    ).bind(tokenHash, clientId).run()
    return
  }
  await db.prepare(
    `UPDATE mcp_oauth_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND revoked_at IS NULL`
  ).bind(tokenHash).run()
}

// ============================================
// メタデータ文書
// ============================================

/**
 * Authorization Server Metadata（RFC 8414）。
 *
 * 注意: `authorization_response_iss_parameter_supported`（RFC 9207）は**意図的に含めない**。
 * このフラグを `true` で公開すると、Codex CLI（`codex-mcp-client/0.146.x`）は認可レスポンスの
 * `iss` を必須検証するが、こちらが `iss=<issuer>` を返していても
 * `Authorization server response missing required issuer` で失敗し、token交換に進めない
 * （`iss` のパラメータ順・percent-encoding有無・`iss` 自体の省略、いずれでも同じエラーになることを実測）。
 * フラグを外すとCodexはこの検証をスキップし、接続が成立する。
 *
 * 認可レスポンス自体には引き続き `iss` を付与しているため、`iss` を自発的に検証する
 * クライアントは mix-up 攻撃対策の恩恵を受けられる。再度このフラグを追加する場合は、
 * 対象クライアントで実接続を確認してからにすること。
 */
export function buildAuthorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: [...MCP_OAUTH_SUPPORTED_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    revocation_endpoint_auth_methods_supported: ['none'],
    service_documentation: `${origin}/help?tab=mcp`,
  }
}

/**
 * Protected Resource Metadata。
 * 未認証で取得できる文書のため、ツリー名などの中身は含めない。
 */
export function buildProtectedResourceMetadata(origin: string, treeId: number): Record<string, unknown> {
  return {
    resource: buildMcpResourceUrl(origin, treeId),
    authorization_servers: [origin],
    scopes_supported: [...MCP_OAUTH_SUPPORTED_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: `Zeeta MCP (tree #${treeId})`,
    resource_documentation: `${origin}/help?tab=mcp`,
  }
}

export function buildWwwAuthenticateHeader(params: {
  origin: string
  treeId: number
  error?: 'invalid_token' | 'insufficient_scope' | 'invalid_request'
  errorDescription?: string
  scope?: string
}): string {
  const resourceMetadata = `${params.origin}/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH_PREFIX}${params.treeId}`
  const parts = [`resource_metadata="${resourceMetadata}"`]
  if (params.error) {
    parts.unshift(`error="${params.error}"`)
    if (params.errorDescription) {
      parts.push(`error_description="${params.errorDescription.replace(/"/g, "'")}"`)
    }
  }
  if (params.scope) {
    parts.push(`scope="${params.scope}"`)
  }
  return `Bearer ${parts.join(', ')}`
}
