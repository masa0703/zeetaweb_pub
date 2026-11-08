import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import {
  BASE_URL,
  DEFAULT_REDIRECT_URI,
  SCOPE_READ,
  SCOPE_WRITE,
  base64Url,
  callMcpWithBearer,
  completeAuthorizationCodeFlow,
  createPkcePair,
  mcpResourceUrl,
  openConsentPage,
  registerClient,
  submitConsent,
} from './helpers/mcp-oauth.js'

const DB_PATH =
  '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/1d75e8d9dbbf9cabcd01dd2d401aa0f9dcd6cab003b0dda8e6c31948c6e680b7.sqlite'

/** ローカルD1(sqlite)を直接叩く。時刻を絡めた検証で使う（tests/audit-http.spec.ts と同じ方式） */
function dbQuery(sql) {
  try {
    return execSync(`sqlite3 "${DB_PATH}" "${sql.replace(/"/g, '""')}"`, {
      cwd: process.cwd(),
      encoding: 'utf-8',
    }).trim()
  } catch {
    return ''
  }
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/** refresh token の平文から DB 上の行IDを引く */
function refreshTokenRowId(token) {
  return dbQuery(
    `SELECT id FROM mcp_oauth_tokens WHERE token_hash='${sha256Hex(token)}' AND token_type='refresh'`
  )
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** audit_logs の行数（WHERE句つき）。audit_logs はテスト間で消えないため
 *  失敗ログの検証は before/after の差分で行う */
function countAudit(whereClause) {
  return Number(dbQuery(`SELECT COUNT(*) FROM audit_logs WHERE ${whereClause}`) || '0')
}

/** 特定 client の生存中 refresh token 本数 */
function liveRefreshCount(clientId) {
  return Number(
    dbQuery(
      `SELECT COUNT(*) FROM mcp_oauth_tokens WHERE client_id='${clientId}' AND token_type='refresh' AND revoked_at IS NULL AND expires_at > datetime('now')`
    ) || '0'
  )
}
async function clearTestData(page) {
  await page.request.delete(`${BASE_URL}/api/test/clear`)
}

async function testLogin(page, userId = 1) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`)
  await waitForAppReady(page)
}

async function createTree(page, name) {
  const res = await page.request.post(`${BASE_URL}/api/trees`, {
    data: { name, description: 'MCP OAuth test tree' }
  })
  const data = await res.json()
  expect(res.ok()).toBeTruthy()
  expect(data.success).toBeTruthy()
  return data.data
}

async function getTreeRootNodeId(page, treeId) {
  const res = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes`)
  const data = await res.json()
  expect(res.ok()).toBeTruthy()
  return String(data.root_node_id)
}

async function addTreeMember(page, treeId, userId, role) {
  const res = await page.request.post(`${BASE_URL}/api/trees/${treeId}/members`, {
    data: { user_id: userId, role }
  })
  const data = await res.json()
  expect(res.ok()).toBeTruthy()
  expect(data.success).toBeTruthy()
}

async function removeTreeMember(page, treeId, userId) {
  const res = await page.request.delete(`${BASE_URL}/api/trees/${treeId}/members/${userId}`)
  const data = await res.json()
  expect(res.ok()).toBeTruthy()
  expect(data.success).toBeTruthy()
}

test.describe('MCP OAuth (OAuth 2.1 / MCP Authorization)', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
    await testLogin(page, 1)
  })

  test('TC-MCP-OAUTH-001: メタデータ文書と401チャレンジ', async ({ page }) => {
    const tree = await createTree(page, 'OAuth Metadata Tree')

    // Authorization Server Metadata (RFC 8414)
    const asRes = await page.request.get(`${BASE_URL}/.well-known/oauth-authorization-server`)
    const asDoc = await asRes.json()
    expect(asRes.status()).toBe(200)
    expect(asDoc.issuer).toBe(BASE_URL)
    expect(asDoc.authorization_endpoint).toBe(`${BASE_URL}/oauth/authorize`)
    expect(asDoc.token_endpoint).toBe(`${BASE_URL}/oauth/token`)
    expect(asDoc.registration_endpoint).toBe(`${BASE_URL}/oauth/register`)
    expect(asDoc.revocation_endpoint).toBe(`${BASE_URL}/oauth/revoke`)
    expect(asDoc.code_challenge_methods_supported).toEqual(['S256'])
    expect(asDoc.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    expect(asDoc.token_endpoint_auth_methods_supported).toEqual(['none'])
    expect(asDoc.scopes_supported).toEqual([SCOPE_READ, SCOPE_WRITE])
    // RFC 9207 のフラグは意図的に公開しない。true にすると Codex CLI が認可レスポンスの
    // iss 検証に失敗し（iss を返していても missing 扱いになる）token交換に進めない。
    // 詳細は src/oauth/mcp-oauth.ts の buildAuthorizationServerMetadata のコメント参照。
    expect(asDoc.authorization_response_iss_parameter_supported).toBeUndefined()

    // パス挿入型でも同じ文書を返す
    const asPathRes = await page.request.get(
      `${BASE_URL}/.well-known/oauth-authorization-server/api/mcp/trees/${tree.id}`
    )
    expect(asPathRes.status()).toBe(200)
    expect((await asPathRes.json()).issuer).toBe(BASE_URL)

    // Protected Resource Metadata (RFC 9728)
    const prmRes = await page.request.get(
      `${BASE_URL}/.well-known/oauth-protected-resource/api/mcp/trees/${tree.id}`
    )
    const prmDoc = await prmRes.json()
    expect(prmRes.status()).toBe(200)
    expect(prmDoc.resource).toBe(mcpResourceUrl(tree.id))
    expect(prmDoc.authorization_servers).toEqual([BASE_URL])
    expect(prmDoc.bearer_methods_supported).toEqual(['header'])
    // 未認証で取得できる文書なのでツリー名を含めない
    expect(JSON.stringify(prmDoc)).not.toContain('OAuth Metadata Tree')

    // 認証なしのMCPリクエストは 401 + WWW-Authenticate(resource_metadata)
    const unauthorizedRes = await page.request.post(mcpResourceUrl(tree.id), {
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(unauthorizedRes.status()).toBe(401)
    const challenge = unauthorizedRes.headers()['www-authenticate']
    expect(challenge).toContain('Bearer')
    expect(challenge).toContain(
      `resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/api/mcp/trees/${tree.id}"`
    )

    // 不正トークンは invalid_token
    const invalidRes = await callMcpWithBearer(page, tree.id, 'zoa_not_a_real_token', {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    })
    expect(invalidRes.status()).toBe(401)
    expect(invalidRes.headers()['www-authenticate']).toContain('error="invalid_token"')

    // GET / DELETE は 405
    const getRes = await page.request.get(mcpResourceUrl(tree.id), { maxRedirects: 0 })
    expect(getRes.status()).toBe(405)
    const deleteRes = await page.request.delete(mcpResourceUrl(tree.id))
    expect(deleteRes.status()).toBe(405)
  })

  test('TC-MCP-OAUTH-002: 動的クライアント登録の検証', async ({ page }) => {
    const ok = await registerClient(page)
    expect(ok.res.status()).toBe(201)
    expect(ok.body.client_id.startsWith('zcl_')).toBeTruthy()
    expect(ok.body.token_endpoint_auth_method).toBe('none')
    expect(ok.body.redirect_uris).toEqual([DEFAULT_REDIRECT_URI])
    expect(ok.body.client_secret).toBeUndefined()

    // 実クライアントの最小形: client_uri を送らないケース。
    // 任意メタデータは null ではなくキーごと省略しなければならない。
    // Claude Code の MCP SDK は登録レスポンスを Zod で検証するため、null を返すと
    // 「expected string, received null」で認可フロー開始前に失敗する。
    const minimal = await registerClient(page, { client_name: 'Claude Code (minimal)' })
    expect(minimal.res.status()).toBe(201)
    expect('client_uri' in minimal.body).toBeFalsy()
    for (const [key, value] of Object.entries(minimal.body)) {
      expect(value, `${key} は null を返してはいけない`).not.toBeNull()
    }

    // redirect_uris 必須
    const missing = await registerClient(page, { redirect_uris: undefined })
    expect(missing.res.status()).toBe(400)
    expect(missing.body.error).toBe('invalid_redirect_uri')

    // loopback 以外の http は拒否
    const insecure = await registerClient(page, { redirect_uris: ['http://example.com/callback'] })
    expect(insecure.res.status()).toBe(400)
    expect(insecure.body.error).toBe('invalid_redirect_uri')

    // fragment 付きは拒否
    const fragment = await registerClient(page, { redirect_uris: ['https://example.com/cb#frag'] })
    expect(fragment.res.status()).toBe(400)

    // https は許可（claude.ai コネクタ等）
    const https = await registerClient(page, { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })
    expect(https.res.status()).toBe(201)

    // confidential client（client_secret_post 等）は非対応
    const confidential = await registerClient(page, { token_endpoint_auth_method: 'client_secret_post' })
    expect(confidential.res.status()).toBe(400)
    expect(confidential.body.error).toBe('invalid_client_metadata')

    // 未知の grant_type / scope は拒否
    const badGrant = await registerClient(page, { grant_types: ['implicit'] })
    expect(badGrant.res.status()).toBe(400)
    const badScope = await registerClient(page, { scope: 'mcp:admin' })
    expect(badScope.res.status()).toBe(400)
  })

  test('TC-MCP-OAUTH-003: authorize のパラメータ検証（PKCE / resource / redirect_uri）', async ({ page }) => {
    const tree = await createTree(page, 'OAuth Authorize Tree')
    const { body: client } = await registerClient(page)
    const { codeChallenge } = createPkcePair()
    const resource = mcpResourceUrl(tree.id)

    // 未登録クライアントは画面エラー（リダイレクトしない）
    const unknownClient = await openConsentPage(page, {
      client_id: 'zcl_unknown', redirect_uri: DEFAULT_REDIRECT_URI, code_challenge: codeChallenge, resource,
    })
    expect(unknownClient.res.status()).toBe(400)

    // 未登録 redirect_uri は画面エラー（リダイレクトしない）
    const badRedirect = await openConsentPage(page, {
      client_id: client.client_id,
      redirect_uri: 'http://localhost:19999/other',
      code_challenge: codeChallenge,
      resource,
    })
    expect(badRedirect.res.status()).toBe(400)

    // 同意画面より前のエラーは、ログイン済みでもクライアントへリダイレクトせず画面エラー（open redirect 防止・2026-11-08 LaF1Kt）

    // PKCE 必須（plain は拒否）
    const plainPkce = await openConsentPage(page, {
      client_id: client.client_id,
      redirect_uri: DEFAULT_REDIRECT_URI,
      code_challenge: codeChallenge,
      code_challenge_method: 'plain',
      resource,
    })
    expect(plainPkce.res.status()).toBe(400)
    expect(plainPkce.res.headers()['location']).toBeUndefined()

    // code_challenge なしは拒否
    const noChallenge = await openConsentPage(page, {
      client_id: client.client_id, redirect_uri: DEFAULT_REDIRECT_URI, resource,
    })
    expect(noChallenge.res.status()).toBe(400)
    expect(noChallenge.res.headers()['location']).toBeUndefined()

    // response_type=token は拒否
    const badResponseType = await openConsentPage(page, {
      client_id: client.client_id,
      redirect_uri: DEFAULT_REDIRECT_URI,
      code_challenge: codeChallenge,
      response_type: 'token',
      resource,
    })
    expect(badResponseType.res.status()).toBe(400)
    expect(badResponseType.res.headers()['location']).toBeUndefined()

    // resource 必須
    const noResource = await openConsentPage(page, {
      client_id: client.client_id, redirect_uri: DEFAULT_REDIRECT_URI, code_challenge: codeChallenge,
    })
    expect(noResource.res.status()).toBe(400)
    expect(noResource.res.headers()['location']).toBeUndefined()

    // 他オリジン / 別形式の resource は拒否
    const foreignResource = await openConsentPage(page, {
      client_id: client.client_id,
      redirect_uri: DEFAULT_REDIRECT_URI,
      code_challenge: codeChallenge,
      resource: 'https://evil.example.com/api/mcp/trees/1',
    })
    expect(foreignResource.res.status()).toBe(400)
    expect(foreignResource.res.headers()['location']).toBeUndefined()

    // 未知scope は invalid_scope
    const badScope = await openConsentPage(page, {
      client_id: client.client_id,
      redirect_uri: DEFAULT_REDIRECT_URI,
      code_challenge: codeChallenge,
      resource,
      scope: 'mcp:read mcp:admin',
    })
    expect(badScope.res.status()).toBe(400)
    expect(badScope.res.headers()['location']).toBeUndefined()

    // 正常系: 同意画面にツリー名と付与scopeが表示され、state は保持される
    const consent = await openConsentPage(page, {
      client_id: client.client_id,
      redirect_uri: DEFAULT_REDIRECT_URI,
      code_challenge: codeChallenge,
      resource,
      state: 'keep-me',
    })
    expect(consent.res.status()).toBe(200)
    expect(consent.html).toContain('OAuth Authorize Tree')
    expect(consent.html).toContain('mcp:write')
    expect(consent.res.headers()['content-security-policy']).toContain('http://localhost:19876')

    // 拒否した場合は access_denied で戻る
    const denied = await submitConsent(page, consent.requestId, 'deny')
    expect(denied.res.status()).toBe(302)
    expect(denied.location).toContain('error=access_denied')
    expect(new URL(denied.location).searchParams.get('state')).toBe('keep-me')

    // 消費済み request_id は再利用できない
    const replay = await submitConsent(page, consent.requestId, 'approve')
    expect(replay.res.status()).toBe(400)
  })

  test('MCP OAuth hardening: 同意画面はclient_uriを信用表示せず外部ホストを強調する', async ({ page }) => {
    const tree = await createTree(page, 'Consent Safety Tree')
    const client = await registerClient(page, {
      client_name: 'Claude Code',
      client_uri: 'https://claude.ai',
      redirect_uris: ['https://evil.example/callback'],
    })
    expect(client.res.status()).toBe(201)
    const { codeChallenge } = createPkcePair()
    const consent = await openConsentPage(page, {
      client_id: client.body.client_id,
      redirect_uri: 'https://evil.example/callback',
      code_challenge: codeChallenge,
      resource: mcpResourceUrl(tree.id),
    })
    expect(consent.res.status()).toBe(200)
    expect(consent.html).not.toContain('https://claude.ai')
    expect(consent.html).toMatch(/evil\.example.{0,200}(承認すると|移動)/s)
  })

  test('MCP OAuth hardening: 未ログイン時の認可エラーはclientへ302しない', async ({ page }) => {
    const client = await registerClient(page)
    await page.context().clearCookies()
    const { codeChallenge } = createPkcePair()
    const response = await page.request.get(`${BASE_URL}/oauth/authorize?${new URLSearchParams({
      client_id: client.body.client_id,
      redirect_uri: DEFAULT_REDIRECT_URI,
      response_type: 'token',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })}`, { maxRedirects: 0 })
    expect(response.status()).toBe(400)
    expect(response.headers().location).toBeUndefined()
  })

  test('MCP OAuth hardening: DCR本文は16KBを超えると413', async ({ page }) => {
    const response = await page.request.post(`${BASE_URL}/oauth/register`, {
      data: JSON.stringify({ client_name: 'x'.repeat(17000), redirect_uris: [DEFAULT_REDIRECT_URI] }),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status()).toBe(413)
  })

  test('MCP OAuth hardening: redirect_uris 9件以上は即400', async ({ page }) => {
    const response = await registerClient(page, {
      redirect_uris: Array.from({ length: 9 }, (_, i) => `http://localhost:${19876 + i}/callback`),
    })
    expect(response.res.status()).toBe(400)
    expect(response.body.error).toBe('invalid_redirect_uri')
  })

  test('TC-MCP-OAUTH-004: token（PKCE検証 / code一回限り / resource不一致）', async ({ page }) => {
    const tree = await createTree(page, 'OAuth Token Tree')
    const { body: client } = await registerClient(page)
    const resource = mcpResourceUrl(tree.id)

    const issueCode = async () => {
      const { codeVerifier, codeChallenge } = createPkcePair()
      const consent = await openConsentPage(page, {
        client_id: client.client_id,
        redirect_uri: DEFAULT_REDIRECT_URI,
        code_challenge: codeChallenge,
        resource,
      })
      const approved = await submitConsent(page, consent.requestId)
      return {
        code: new URL(approved.location).searchParams.get('code'),
        codeVerifier,
      }
    }

    const postToken = (form) => page.request.post(`${BASE_URL}/oauth/token`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      form,
    })

    // PKCE 検証失敗
    const wrongVerifier = await issueCode()
    const wrongRes = await postToken({
      grant_type: 'authorization_code',
      code: wrongVerifier.code,
      code_verifier: base64Url(crypto.randomBytes(48)),
      client_id: client.client_id,
      redirect_uri: DEFAULT_REDIRECT_URI,
    })
    expect(wrongRes.status()).toBe(400)
    expect((await wrongRes.json()).error).toBe('invalid_grant')

    // redirect_uri 不一致
    const mismatched = await issueCode()
    const mismatchRes = await postToken({
      grant_type: 'authorization_code',
      code: mismatched.code,
      code_verifier: mismatched.codeVerifier,
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    })
    expect(mismatchRes.status()).toBe(400)
    expect((await mismatchRes.json()).error).toBe('invalid_grant')

    // resource 不一致
    const otherTree = await createTree(page, 'OAuth Other Tree')
    const wrongResource = await issueCode()
    const wrongResourceRes = await postToken({
      grant_type: 'authorization_code',
      code: wrongResource.code,
      code_verifier: wrongResource.codeVerifier,
      client_id: client.client_id,
      redirect_uri: DEFAULT_REDIRECT_URI,
      resource: mcpResourceUrl(otherTree.id),
    })
    expect(wrongResourceRes.status()).toBe(400)
    expect((await wrongResourceRes.json()).error).toBe('invalid_target')

    // 別クライアントIDでの交換は拒否
    const { body: otherClient } = await registerClient(page)
    const otherClientCode = await issueCode()
    const otherClientRes = await postToken({
      grant_type: 'authorization_code',
      code: otherClientCode.code,
      code_verifier: otherClientCode.codeVerifier,
      client_id: otherClient.client_id,
      redirect_uri: DEFAULT_REDIRECT_URI,
    })
    expect(otherClientRes.status()).toBe(400)
    expect((await otherClientRes.json()).error).toBe('invalid_grant')

    // 未知 client_id は invalid_client
    const unknownClientRes = await postToken({
      grant_type: 'authorization_code',
      code: 'zoc_dummy',
      code_verifier: base64Url(crypto.randomBytes(48)),
      client_id: 'zcl_unknown',
      redirect_uri: DEFAULT_REDIRECT_URI,
    })
    expect(unknownClientRes.status()).toBe(401)
    expect((await unknownClientRes.json()).error).toBe('invalid_client')

    // 未対応 grant_type
    const badGrantRes = await postToken({ grant_type: 'password', client_id: client.client_id })
    expect(badGrantRes.status()).toBe(400)
    expect((await badGrantRes.json()).error).toBe('unsupported_grant_type')

    // 正常系 + code の一回限り使用
    const valid = await issueCode()
    const okRes = await postToken({
      grant_type: 'authorization_code',
      code: valid.code,
      code_verifier: valid.codeVerifier,
      client_id: client.client_id,
      redirect_uri: DEFAULT_REDIRECT_URI,
      resource,
    })
    const okBody = await okRes.json()
    expect(okRes.status()).toBe(200)
    expect(okBody.token_type).toBe('Bearer')
    expect(okBody.expires_in).toBe(3600)
    expect(okBody.scope).toBe(`${SCOPE_READ} ${SCOPE_WRITE}`)
    expect(okRes.headers()['cache-control']).toContain('no-store')

    const replayRes = await postToken({
      grant_type: 'authorization_code',
      code: valid.code,
      code_verifier: valid.codeVerifier,
      client_id: client.client_id,
      redirect_uri: DEFAULT_REDIRECT_URI,
    })
    expect(replayRes.status()).toBe(400)
    expect((await replayRes.json()).error).toBe('invalid_grant')
  })

  test('TC-MCP-OAUTH-005: access token でMCPを操作でき、resource束縛が効く', async ({ page }) => {
    const tree = await createTree(page, 'OAuth MCP Tree')
    const otherTree = await createTree(page, 'OAuth MCP Other Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const { token } = await completeAuthorizationCodeFlow(page, tree.id)

    // tools/list（旧仕様互換の単純POST）
    const listRes = await callMcpWithBearer(page, tree.id, token.access_token, {
      jsonrpc: '2.0', id: 'list', method: 'tools/list',
    })
    const listBody = await listRes.json()
    expect(listRes.status()).toBe(200)
    expect(listBody.result.tools.some(t => t.name === 'create_node')).toBeTruthy()

    // get_root_node_id はAPIキー方式と同じ public id を返す
    const rootRes = await callMcpWithBearer(page, tree.id, token.access_token, {
      jsonrpc: '2.0', id: 'root', method: 'tools/call',
      params: { name: 'get_root_node_id', arguments: {} },
    })
    const rootBody = await rootRes.json()
    expect(rootBody.result.structuredContent.id).toBe(rootNodeId)

    // 書き込みツールも editor/owner なら実行できる
    const createRes = await callMcpWithBearer(page, tree.id, token.access_token, {
      jsonrpc: '2.0', id: 'create', method: 'tools/call',
      params: { name: 'create_node', arguments: { title: 'oauth-created', parent_ids: [rootNodeId] } },
    })
    const createBody = await createRes.json()
    expect(createBody.result.structuredContent.id).toBeTruthy()
    expect(createBody.result.isError).toBeFalsy()

    // 2026-07-28 modern transport でも動作する
    const modernRes = await page.request.post(mcpResourceUrl(tree.id), {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token.access_token}`,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'get_root_node_id',
      },
      data: {
        jsonrpc: '2.0', id: 'modern', method: 'tools/call',
        params: {
          name: 'get_root_node_id',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
    })
    const modernBody = await modernRes.json()
    expect(modernRes.status()).toBe(200)
    expect(modernBody.result.resultType).toBe('complete')
    expect(modernBody.result._meta['io.modelcontextprotocol/serverInfo']).toBeTruthy()

    // 別ツリーのMCP URLへ同じtokenは使えない（audience/resource binding）
    const crossRes = await callMcpWithBearer(page, otherTree.id, token.access_token, {
      jsonrpc: '2.0', id: 'cross', method: 'tools/list',
    })
    expect(crossRes.status()).toBe(403)
    expect(crossRes.headers()['www-authenticate']).toContain('error="invalid_token"')

    // クエリトークンでは認証できない
    const queryTokenRes = await page.request.post(
      `${mcpResourceUrl(tree.id)}?token=${encodeURIComponent(token.access_token)}`,
      { data: { jsonrpc: '2.0', id: 'q', method: 'tools/list' } }
    )
    expect(queryTokenRes.status()).toBe(401)
  })

  test('TC-MCP-OAUTH-006: refresh token のローテーションと生存chainへのリトライ', async ({ page }) => {
    const tree = await createTree(page, 'OAuth Refresh Tree')
    const { client, token } = await completeAuthorizationCodeFlow(page, tree.id)

    const postToken = (form) => page.request.post(`${BASE_URL}/oauth/token`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      form,
    })

    // scope 拡大は拒否される（refresh の scope を超えられない）
    const tooWideRes = await postToken({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
      client_id: client.client_id,
      scope: 'mcp:read mcp:admin',
    })
    expect(tooWideRes.status()).toBe(400)
    expect((await tooWideRes.json()).error).toBe('invalid_scope')

    // 正常なローテーション
    const rotatedRes = await postToken({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
      client_id: client.client_id,
    })
    const rotated = await rotatedRes.json()
    expect(rotatedRes.status()).toBe(200)
    expect(rotated.refresh_token).not.toBe(token.refresh_token)
    expect(rotated.access_token).not.toBe(token.access_token)

    // 旧 access token は失効している
    const oldAccessRes = await callMcpWithBearer(page, tree.id, token.access_token, {
      jsonrpc: '2.0', id: 'old', method: 'tools/list',
    })
    expect(oldAccessRes.status()).toBe(401)

    // 新 access token は使える
    const newAccessRes = await callMcpWithBearer(page, tree.id, rotated.access_token, {
      jsonrpc: '2.0', id: 'new', method: 'tools/list',
    })
    expect(newAccessRes.status()).toBe(200)

    // chain がまだ生きている限り、経過時間に関わらず旧 refresh の再提示は
    // 「rotation のリトライ」として扱い、グラントを殺さず新しいトークン対を返す
    // （後継は supersede される）
    const replayRes = await postToken({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
      client_id: client.client_id,
    })
    const replayed = await replayRes.json()
    expect(replayRes.status()).toBe(200)
    expect(replayed.access_token).toBeTruthy()
    expect(replayed.refresh_token).toBeTruthy()
    expect(replayed.access_token).not.toBe(rotated.access_token)
    expect(replayed.refresh_token).not.toBe(rotated.refresh_token)

    // 新しく返ったトークンは使える（グラントは生きている）
    const replayAccessRes = await callMcpWithBearer(page, tree.id, replayed.access_token, {
      jsonrpc: '2.0', id: 'replay', method: 'tools/list',
    })
    expect(replayAccessRes.status()).toBe(200)

    // supersede された側の access token は失効している
    const supersededRes = await callMcpWithBearer(page, tree.id, rotated.access_token, {
      jsonrpc: '2.0', id: 'superseded', method: 'tools/list',
    })
    expect(supersededRes.status()).toBe(401)

    // 生存中の refresh は常に1本（family が分岐して残らない）
    expect(liveRefreshCount(client.client_id)).toBe(1)

    // 経過時間が長くても（クライアントが新しい refresh_token を保存し直さず、
    // 旧 refresh を使い続けるケース）chain が生きていればリトライとして成功する
    const oldRowId = refreshTokenRowId(token.refresh_token)
    expect(oldRowId).not.toBe('')
    dbQuery(
      `UPDATE mcp_oauth_tokens SET revoked_at = datetime('now','-3600 seconds') WHERE id=${oldRowId}`
    )
    const staleReplayRes = await postToken({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
      client_id: client.client_id,
    })
    expect(staleReplayRes.status()).toBe(200)
    expect(liveRefreshCount(client.client_id)).toBe(1)
  })

  test('TC-MCP-OAUTH-012: 並行 rotation でも refresh は1本しか生き残らない（CAS）', async ({ page }) => {
    const tree = await createTree(page, 'OAuth Concurrent Rotate Tree')
    const { client, token } = await completeAuthorizationCodeFlow(page, tree.id)

    const postToken = (form) => page.request.post(`${BASE_URL}/oauth/token`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      form,
    })

    // 同じ refresh token で同時に4回 rotation を要求する
    const form = {
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
      client_id: client.client_id,
    }
    const responses = await Promise.all([1, 2, 3, 4].map(() => postToken(form)))
    const bodies = await Promise.all(responses.map((r) => r.json()))

    // 誰もロックアウトされない（グラント全滅が起きない）
    for (const res of responses) {
      expect(res.status()).toBe(200)
    }
    const refreshTokens = new Set(bodies.map((b) => b.refresh_token))
    expect(refreshTokens.size).toBe(responses.length)

    // 競合しても生存 refresh は常に1本（family が分岐しない・0本にもならない）
    expect(liveRefreshCount(client.client_id)).toBe(1)

    // 生き残った1本の access token だけが通る
    const results = await Promise.all(
      bodies.map((b, i) =>
        callMcpWithBearer(page, tree.id, b.access_token, {
          jsonrpc: '2.0', id: `c${i}`, method: 'tools/list',
        })
      )
    )
    expect(results.filter((r) => r.status() === 200).length).toBe(1)
  })

  test('TC-MCP-OAUTH-013: family全体が明示的に失効した後の再利用は拒否され、別グラントは残る', async ({ page }) => {
    const tree = await createTree(page, 'OAuth Reuse Grace Tree')

    // 同一ツリーに対して独立した2つのグラント（別クライアント登録）を作る
    const grantA = await completeAuthorizationCodeFlow(page, tree.id)
    const grantB = await completeAuthorizationCodeFlow(page, tree.id)

    const postToken = (form) => page.request.post(`${BASE_URL}/oauth/token`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      form,
    })

    // grantA を1回 rotation する
    const rotatedRes = await postToken({
      grant_type: 'refresh_token',
      refresh_token: grantA.token.refresh_token,
      client_id: grantA.client.client_id,
    })
    const rotated = await rotatedRes.json()
    expect(rotatedRes.status()).toBe(200)

    // 生きている現行 refresh を明示 revoke する（アプリ側の切断操作を模す）。
    // これで family には生存 refresh が1本も残らなくなる
    const revokeRes = await page.request.post(`${BASE_URL}/oauth/revoke`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      form: { token: rotated.refresh_token, client_id: grantA.client.client_id },
    })
    expect(revokeRes.status()).toBe(200)
    expect(liveRefreshCount(grantA.client.client_id)).toBe(0)

    // family が死んでいるので、古い（rotation済みの）refresh を再提示しても拒否される
    const reuseRes = await postToken({
      grant_type: 'refresh_token',
      refresh_token: grantA.token.refresh_token,
      client_id: grantA.client.client_id,
    })
    expect(reuseRes.status()).toBe(400)
    expect((await reuseRes.json()).error).toBe('invalid_grant')

    // chain 上の後継 access token は失効する
    const chainRes = await callMcpWithBearer(page, tree.id, rotated.access_token, {
      jsonrpc: '2.0', id: 'chain', method: 'tools/list',
    })
    expect(chainRes.status()).toBe(401)

    // 無関係な別グラントは影響を受けない
    const otherRes = await callMcpWithBearer(page, tree.id, grantB.token.access_token, {
      jsonrpc: '2.0', id: 'other', method: 'tools/list',
    })
    expect(otherRes.status()).toBe(200)

    const otherRefreshRes = await postToken({
      grant_type: 'refresh_token',
      refresh_token: grantB.token.refresh_token,
      client_id: grantB.client.client_id,
    })
    expect(otherRefreshRes.status()).toBe(200)
  })

  test('TC-MCP-OAUTH-007: revoke で access/refresh を失効できる', async ({ page }) => {
    const tree = await createTree(page, 'OAuth Revoke Tree')
    const { client, token } = await completeAuthorizationCodeFlow(page, tree.id)

    const okBefore = await callMcpWithBearer(page, tree.id, token.access_token, {
      jsonrpc: '2.0', id: 'before', method: 'tools/list',
    })
    expect(okBefore.status()).toBe(200)

    const revokeRes = await page.request.post(`${BASE_URL}/oauth/revoke`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      form: { token: token.refresh_token, client_id: client.client_id },
    })
    expect(revokeRes.status()).toBe(200)

    // refresh の失効に伴い派生 access token も失効する
    const afterRes = await callMcpWithBearer(page, tree.id, token.access_token, {
      jsonrpc: '2.0', id: 'after', method: 'tools/list',
    })
    expect(afterRes.status()).toBe(401)

    const refreshAfterRes = await page.request.post(`${BASE_URL}/oauth/token`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      form: { grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: client.client_id },
    })
    expect(refreshAfterRes.status()).toBe(400)

    // 未知トークンでも 200（RFC 7009）
    const unknownRes = await page.request.post(`${BASE_URL}/oauth/revoke`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      form: { token: 'zor_unknown_token' },
    })
    expect(unknownRes.status()).toBe(200)
  })

  test('TC-MCP-OAUTH-008: 非メンバーは認可されず、viewerは読み取り専用になる', async ({ page }) => {
    const tree = await createTree(page, 'OAuth Membership Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    await testLogin(page, 2)
    await testLogin(page, 1)

    // 非メンバー（user 2）は access_denied
    await testLogin(page, 2)
    const { body: client } = await registerClient(page)
    const { codeChallenge } = createPkcePair()
    const nonMember = await openConsentPage(page, {
      client_id: client.client_id,
      redirect_uri: DEFAULT_REDIRECT_URI,
      code_challenge: codeChallenge,
      resource: mcpResourceUrl(tree.id),
    })
    expect(nonMember.res.status()).toBe(400)
    expect(nonMember.res.headers()['location']).toBeUndefined()

    // viewer として招待
    await testLogin(page, 1)
    await addTreeMember(page, tree.id, 2, 'viewer')

    await testLogin(page, 2)
    const viewerFlow = await completeAuthorizationCodeFlow(page, tree.id)
    // viewer は mcp:write を要求しても read へダウングレードされる
    expect(viewerFlow.token.scope).toBe(SCOPE_READ)
    expect(viewerFlow.consentHtml).toContain('閲覧者権限のため読み取り専用')

    // tools/list は read ツールのみ
    const listRes = await callMcpWithBearer(page, tree.id, viewerFlow.token.access_token, {
      jsonrpc: '2.0', id: 'list', method: 'tools/list',
    })
    const listBody = await listRes.json()
    expect(listBody.result.tools.some(t => t.name === 'create_node')).toBeFalsy()
    expect(listBody.result.tools.some(t => t.name === 'read_node')).toBeTruthy()

    // 読み取りはできる
    const readRes = await callMcpWithBearer(page, tree.id, viewerFlow.token.access_token, {
      jsonrpc: '2.0', id: 'root', method: 'tools/call',
      params: { name: 'get_root_node_id', arguments: {} },
    })
    expect((await readRes.json()).result.structuredContent.id).toBe(rootNodeId)

    // 書き込みツールは 403 insufficient_scope
    const writeRes = await callMcpWithBearer(page, tree.id, viewerFlow.token.access_token, {
      jsonrpc: '2.0', id: 'create', method: 'tools/call',
      params: { name: 'create_node', arguments: { title: 'denied', parent_ids: [rootNodeId] } },
    })
    expect(writeRes.status()).toBe(403)
    const writeBody = await writeRes.json()
    expect(writeBody.error).toBe('insufficient_scope')
    expect(writeRes.headers()['www-authenticate']).toContain('error="insufficient_scope"')
    expect(writeRes.headers()['www-authenticate']).toContain(`scope="${SCOPE_WRITE}"`)
  })

  test('TC-MCP-OAUTH-009: editor から viewer への降格とメンバー解除が即時反映される', async ({ page }) => {
    const tree = await createTree(page, 'OAuth Role Change Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    await testLogin(page, 2)
    await testLogin(page, 1)
    await addTreeMember(page, tree.id, 2, 'editor')

    await testLogin(page, 2)
    const { token } = await completeAuthorizationCodeFlow(page, tree.id)
    expect(token.scope).toBe(`${SCOPE_READ} ${SCOPE_WRITE}`)

    const writeOkRes = await callMcpWithBearer(page, tree.id, token.access_token, {
      jsonrpc: '2.0', id: 'create-1', method: 'tools/call',
      params: { name: 'create_node', arguments: { title: 'editor-ok', parent_ids: [rootNodeId] } },
    })
    expect(writeOkRes.status()).toBe(200)
    expect((await writeOkRes.json()).result.isError).toBeFalsy()

    // viewer へ降格 → 既存 token でも書き込み不可（scope は role で絞られる）
    await testLogin(page, 1)
    const roleRes = await page.request.put(`${BASE_URL}/api/trees/${tree.id}/members/2/role`, {
      data: { role: 'viewer' },
    })
    expect(roleRes.ok()).toBeTruthy()

    const writeDeniedRes = await callMcpWithBearer(page, tree.id, token.access_token, {
      jsonrpc: '2.0', id: 'create-2', method: 'tools/call',
      params: { name: 'create_node', arguments: { title: 'downgraded', parent_ids: [rootNodeId] } },
    })
    expect(writeDeniedRes.status()).toBe(403)
    expect((await writeDeniedRes.json()).error).toBe('insufficient_scope')

    // 読み取りはまだできる
    const readRes = await callMcpWithBearer(page, tree.id, token.access_token, {
      jsonrpc: '2.0', id: 'root', method: 'tools/call',
      params: { name: 'get_root_node_id', arguments: {} },
    })
    expect(readRes.status()).toBe(200)

    // メンバー解除 → token 即時無効
    await removeTreeMember(page, tree.id, 2)
    const afterRemovalRes = await callMcpWithBearer(page, tree.id, token.access_token, {
      jsonrpc: '2.0', id: 'after', method: 'tools/list',
    })
    expect(afterRemovalRes.status()).toBe(401)
    expect(afterRemovalRes.headers()['www-authenticate']).toContain('error="invalid_token"')
  })

  test('TC-MCP-OAUTH-014: OAuth失敗（401/400）が audit_logs に記録される', async ({ page }) => {
    const tree = await createTree(page, 'OAuth Audit Failure Tree')
    const { client, token } = await completeAuthorizationCodeFlow(page, tree.id)

    const postToken = (form) => page.request.post(`${BASE_URL}/oauth/token`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      form,
    })

    // audit_logs はテスト間で消えないため、対象行のベースラインを取って差分で検証する
    const where = {
      noBearer: `action='mcp_oauth.request_unauthorized' AND target_type='tree' AND tree_id=${tree.id} AND target_id='no_bearer'`,
      invalidAccess: `action='mcp_oauth.request_unauthorized' AND target_type='tree' AND tree_id=${tree.id} AND target_id='access_token_invalid'`,
      unknownClient: `action='mcp_oauth.token_error' AND target_type='oauth_client' AND target_id='invalid_client:client_id_unknown'`,
      refreshRevoked: `action='mcp_oauth.token_error' AND target_type='oauth_client' AND target_id='invalid_grant:refresh_revoked' AND tree_id=${tree.id}`,
      refreshRevokedWithUser: `action='mcp_oauth.token_error' AND target_type='oauth_client' AND target_id='invalid_grant:refresh_revoked' AND tree_id=${tree.id} AND user_id IS NOT NULL`,
      reuseDetected: `action='mcp_oauth.token_reuse_detected' AND tree_id=${tree.id}`,
    }
    const before = Object.fromEntries(
      Object.entries(where).map(([key, clause]) => [key, countAudit(clause)])
    )

    // --- /mcp への認証失敗（Bearer 無し）は 401 ---
    const noBearerRes = await page.request.post(mcpResourceUrl(tree.id), {
      data: { jsonrpc: '2.0', id: 'nb', method: 'tools/list' },
    })
    expect(noBearerRes.status()).toBe(401)

    // --- /mcp への認証失敗（不正 access token）は 401 ---
    const invalidTokenRes = await callMcpWithBearer(page, tree.id, 'zoa_not_a_real_token', {
      jsonrpc: '2.0', id: 'it', method: 'tools/list',
    })
    expect(invalidTokenRes.status()).toBe(401)

    // --- token endpoint の 401（未知 client_id）---
    const unknownClientRes = await postToken({
      grant_type: 'authorization_code',
      code: 'zoc_dummy',
      code_verifier: base64Url(crypto.randomBytes(48)),
      client_id: 'zcl_unknown',
      redirect_uri: DEFAULT_REDIRECT_URI,
    })
    expect(unknownClientRes.status()).toBe(401)
    expect((await unknownClientRes.json()).error).toBe('invalid_client')

    // --- family を明示失効させた後の refresh 再利用は 400 invalid_grant ---
    const revokeRes = await page.request.post(`${BASE_URL}/oauth/revoke`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      form: { token: token.refresh_token, client_id: client.client_id },
    })
    expect(revokeRes.status()).toBe(200)
    const reuseRes = await postToken({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
      client_id: client.client_id,
    })
    expect(reuseRes.status()).toBe(400)
    expect((await reuseRes.json()).error).toBe('invalid_grant')

    // 監査ログは waitUntil で応答後に非同期書き込みされるため、反映を待つ
    await sleep(800)

    // /mcp の 401 は request_unauthorized として tree_id 付きで記録される
    expect(countAudit(where.noBearer)).toBeGreaterThan(before.noBearer)
    expect(countAudit(where.invalidAccess)).toBeGreaterThan(before.invalidAccess)

    // token endpoint の 401 は token_error として記録される
    expect(countAudit(where.unknownClient)).toBeGreaterThan(before.unknownClient)

    // family 死亡後の refresh 再利用は token_reuse_detected に加えて
    // エラー応答（invalid_grant:refresh_revoked）も user_id / tree_id 付きで記録される
    expect(countAudit(where.refreshRevoked)).toBeGreaterThan(before.refreshRevoked)
    expect(countAudit(where.refreshRevokedWithUser)).toBeGreaterThan(before.refreshRevokedWithUser)
    expect(countAudit(where.reuseDetected)).toBeGreaterThan(before.reuseDetected)
  })

  test('TC-MCP-OAUTH-011: 未ログイン時はログイン画面へ誘導される', async ({ page }) => {
    const tree = await createTree(page, 'OAuth Login Redirect Tree')
    const { body: client } = await registerClient(page)
    const { codeChallenge } = createPkcePair()

    // セッションを破棄
    await page.request.post(`${BASE_URL}/auth/logout`)
    await page.context().clearCookies()

    const res = await openConsentPage(page, {
      client_id: client.client_id,
      redirect_uri: DEFAULT_REDIRECT_URI,
      code_challenge: codeChallenge,
      resource: mcpResourceUrl(tree.id),
    })
    expect(res.res.status()).toBe(302)
    const location = res.res.headers()['location']
    expect(location.startsWith('/login?redirect=')).toBeTruthy()
    expect(decodeURIComponent(location)).toContain('/oauth/authorize')
  })

  test('TC-MCP-OAUTH-015: ログアウト済みセッションのCookieでは認可を進められない', async ({ page }) => {
    const tree = await createTree(page, 'OAuth Revoked Session Tree')
    const { body: client } = await registerClient(page)
    const { codeChallenge } = createPkcePair()
    const params = {
      client_id: client.client_id,
      redirect_uri: DEFAULT_REDIRECT_URI,
      code_challenge: codeChallenge,
      resource: mcpResourceUrl(tree.id),
    }

    const consent = await openConsentPage(page, params)
    expect(consent.res.status()).toBe(200)
    expect(consent.requestId).toBeTruthy()

    // ログアウトでサーバー側のセッションを失効させた後、署名・期限が有効な旧Cookieを戻す
    const revokedCookie = (await page.context().cookies()).find((cookie) => cookie.name === 'session')
    expect(revokedCookie).toBeTruthy()
    await page.request.post(`${BASE_URL}/auth/logout`)
    await page.context().addCookies([revokedCookie])

    const apiRes = await page.request.get(`${BASE_URL}/api/trees`)
    expect(apiRes.status()).toBe(401)

    const reopened = await openConsentPage(page, params)
    expect(reopened.res.status()).toBe(302)
    expect(reopened.res.headers()['location'].startsWith('/login?redirect=')).toBeTruthy()

    const submitted = await submitConsent(page, consent.requestId, 'approve')
    expect(submitted.res.status()).toBe(401)
    expect(submitted.location).not.toContain('code=')
  })
})
