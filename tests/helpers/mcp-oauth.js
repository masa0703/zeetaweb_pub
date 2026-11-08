/**
 * MCP OAuth テスト用の共有ヘルパー。
 *
 * APIキー方式（`zk_` / `POST /api/mcp`）の廃止に伴い、MCP のテストは
 * すべて OAuth + ツリー固有エンドポイント（`POST /api/mcp/trees/:tree_id`）
 * を経由する。DCR → authorize → consent → token のフローが毎テストで必要に
 * なるため、`mcp-api.spec.js` / `mcp-oauth.spec.js` / `audit-mcp.spec.ts` で
 * 共有する。
 */
import { expect } from '@playwright/test'
import crypto from 'node:crypto'

export const BASE_URL = 'http://localhost:3000'

export const SCOPE_READ = 'mcp:read'
export const SCOPE_WRITE = 'mcp:write'
export const SCOPE_FULL = `${SCOPE_READ} ${SCOPE_WRITE}`

export const DEFAULT_REDIRECT_URI = 'http://localhost:19876/callback'

export function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function createPkcePair() {
  const codeVerifier = base64Url(crypto.randomBytes(48))
  const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest())
  return { codeVerifier, codeChallenge }
}

/** ツリー固有MCPエンドポイント。OAuth の resource 指定にもこの URL を使う */
export function mcpResourceUrl(treeId) {
  return `${BASE_URL}/api/mcp/trees/${treeId}`
}

export async function registerClient(page, overrides = {}) {
  const res = await page.request.post(`${BASE_URL}/oauth/register`, {
    data: {
      client_name: 'Zeeta E2E MCP Client',
      redirect_uris: [DEFAULT_REDIRECT_URI],
      ...overrides,
    }
  })
  return { res, body: await res.json() }
}

/** 同意画面を取得し、hidden の request_id を取り出す */
export async function openConsentPage(page, params) {
  const url = new URL(`${BASE_URL}/oauth/authorize`)
  const query = {
    response_type: 'code',
    code_challenge_method: 'S256',
    ...params,
  }
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  // playwright.config.js の locale: 'ja-JP' は APIRequestContext には反映されないため、
  // サーバーレンダリングされる同意画面の検証言語を明示する。
  const res = await page.request.get(url.toString(), {
    maxRedirects: 0,
    headers: { 'accept-language': 'ja' },
  })
  const html = res.status() === 200 ? await res.text() : ''
  const match = html.match(/name="request_id" value="([^"]+)"/)
  return { res, html, requestId: match ? match[1] : null }
}

export async function submitConsent(page, requestId, decision = 'approve') {
  const res = await page.request.post(`${BASE_URL}/oauth/authorize`, {
    maxRedirects: 0,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: BASE_URL,
    },
    form: { request_id: requestId, decision },
  })
  const location = res.headers()['location'] || ''
  return { res, location }
}

/** DCR → authorize → consent → token を通して access/refresh token を得る */
export async function completeAuthorizationCodeFlow(page, treeId, options = {}) {
  const { body: client } = await registerClient(page, options.clientOverrides || {})
  const { codeVerifier, codeChallenge } = createPkcePair()
  const resource = mcpResourceUrl(treeId)

  const consent = await openConsentPage(page, {
    client_id: client.client_id,
    redirect_uri: DEFAULT_REDIRECT_URI,
    code_challenge: codeChallenge,
    state: 'e2e-state',
    resource,
    scope: options.scope,
  })
  expect(consent.res.status()).toBe(200)
  expect(consent.requestId).toBeTruthy()

  const approved = await submitConsent(page, consent.requestId)
  expect(approved.res.status()).toBe(302)
  const code = new URL(approved.location).searchParams.get('code')
  expect(code).toBeTruthy()

  const tokenRes = await page.request.post(`${BASE_URL}/oauth/token`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    form: {
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      client_id: client.client_id,
      redirect_uri: DEFAULT_REDIRECT_URI,
      resource,
    },
  })
  const token = await tokenRes.json()
  expect(tokenRes.status()).toBe(200)
  expect(token.access_token).toBeTruthy()

  return { client, token, resource, codeVerifier, codeChallenge, consentHtml: consent.html }
}

/**
 * MCP 呼び出し用の認可コンテキストを1回で用意する。
 *
 * 旧 `issueApiKey()` の置き換え。戻り値の `key` に access token が入るため、
 * bearer を直接組み立てている既存アサーションはそのまま動く。
 *
 * `permissionPreset` は OAuth の scope へ写像される:
 * - `full_access` → `mcp:read mcp:write`（role が owner/editor のとき full_access 相当）
 * - `read_only`   → `mcp:read`
 */
export async function issueMcpAuth(page, treeId, permissionPreset = 'full_access', clientOverrides = undefined) {
  const scope = permissionPreset === 'read_only' ? SCOPE_READ : SCOPE_FULL
  const flow = await completeAuthorizationCodeFlow(page, treeId, { scope, clientOverrides })
  return {
    key: flow.token.access_token,
    refreshToken: flow.token.refresh_token,
    treeId,
    scope: flow.token.scope,
    client: flow.client,
    resource: flow.resource,
  }
}

/** bearer を直接渡す低レベル呼び出し */
export async function callMcpWithBearer(page, treeId, bearer, rpcPayload) {
  return page.request.post(mcpResourceUrl(treeId), {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
    },
    data: rpcPayload,
  })
}

/**
 * `issueMcpAuth()` の戻り値を渡して JSON-RPC を1件呼ぶ。
 * 旧 `callMcp()`（`GET /api/mcp/sse?token=...&rpc=...`）の置き換えで、
 * 戻り値は JSON-RPC レスポンス本体（旧実装と同じ形）。
 */
export async function callMcp(page, auth, rpcPayload) {
  const res = await callMcpWithBearer(page, auth.treeId, auth.key, rpcPayload)
  const text = await res.text()
  expect(res.ok(), `MCP call failed: ${res.status()} ${text}`).toBeTruthy()
  return JSON.parse(text)
}

/** 2026-07-28 仕様の `_meta` を載せた JSON-RPC ペイロードを組む */
export function modernMcpPayload(id, method, params = {}, protocolVersion = '2026-07-28') {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': protocolVersion,
        'io.modelcontextprotocol/clientInfo': { name: 'zeeta-e2e', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  }
}

/** modern（2026-07-28）仕様のヘッダーを組んで POST する */
export async function callModernMcp(page, auth, payload, headerOverrides = {}) {
  const headers = {
    authorization: `Bearer ${auth.key}`,
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': payload.params?._meta?.['io.modelcontextprotocol/protocolVersion'] || '2026-07-28',
    'mcp-method': payload.method,
    ...headerOverrides,
  }
  if (payload.method === 'tools/call' || payload.method === 'prompts/get') {
    headers['mcp-name'] = payload.params?.name || ''
  } else if (payload.method === 'resources/read') {
    headers['mcp-name'] = payload.params?.uri || ''
  }

  const response = await page.request.post(mcpResourceUrl(auth.treeId), {
    headers,
    data: payload,
  })
  const text = await response.text()
  return {
    response,
    body: text ? JSON.parse(text) : null,
  }
}
