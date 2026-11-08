/**
 * T4-test: MCP audit log integration test
 *
 * HTTPセッションで OAuth 認可フロー（DCR → authorize → consent → token）を通し、
 * 得た access token でツリー固有MCPエンドポイントに JSON-RPC を投げる。
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'

const BASE = 'http://localhost:3000'
const DB_PATH =
  '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/1d75e8d9dbbf9cabcd01dd2d401aa0f9dcd6cab003b0dda8e6c31948c6e680b7.sqlite'

async function fetchJson(path: string, opts?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, opts)
  const text = await res.text()
  try {
    return { status: res.status, data: JSON.parse(text), headers: res.headers }
  } catch {
    return { status: res.status, data: text, headers: res.headers }
  }
}

function getCookie(headers: Headers, name: string): string | null {
  const setCookie = headers.get('set-cookie') || ''
  const match = setCookie.match(new RegExp(`${name}=([^;]+)`))
  return match ? match[1] : null
}

function dbQuery(sql: string) {
  try {
    const out = execSync(`sqlite3 "${DB_PATH}" "${sql.replace(/"/g, '""')}"`, {
      cwd: process.cwd(),
      encoding: 'utf-8',
    })
    return out.trim()
  } catch {
    return ''
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * DCR → authorize → consent → token を素の fetch で通して access token を得る。
 * 同意画面はログイン済みセッション（Cookie）が必要なため cookieHeader を受け取る。
 */
async function obtainMcpAccessToken(cookieHeader: string, treeId: number): Promise<string> {
  const redirectUri = 'http://localhost:19876/callback'
  const resource = `${BASE}/api/mcp/trees/${treeId}`

  const regRes = await fetchJson('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'audit-mcp-test', redirect_uris: [redirectUri] }),
  })
  const clientId = regRes.data.client_id
  assert.ok(clientId, `DCR failed: ${JSON.stringify(regRes.data)}`)

  const codeVerifier = base64Url(crypto.randomBytes(48))
  const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest())

  const authorizeUrl = new URL(`${BASE}/oauth/authorize`)
  for (const [key, value] of Object.entries({
    response_type: 'code',
    code_challenge_method: 'S256',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    state: 'audit-mcp-state',
    resource,
    scope: 'mcp:read mcp:write',
  })) {
    authorizeUrl.searchParams.set(key, String(value))
  }
  const consentRes = await fetch(authorizeUrl.toString(), {
    headers: { Cookie: cookieHeader },
    redirect: 'manual',
  })
  const consentHtml = await consentRes.text()
  assert.equal(consentRes.status, 200, `authorize failed: ${consentRes.status}`)
  const requestId = consentHtml.match(/name="request_id" value="([^"]+)"/)?.[1]
  assert.ok(requestId, 'request_id not found in consent page')

  const approveRes = await fetch(`${BASE}/oauth/authorize`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader,
      Origin: BASE,
    },
    body: new URLSearchParams({ request_id: requestId, decision: 'approve' }).toString(),
    redirect: 'manual',
  })
  assert.equal(approveRes.status, 302, `consent failed: ${approveRes.status}`)
  const code = new URL(approveRes.headers.get('location') || '').searchParams.get('code')
  assert.ok(code, 'authorization code not found')

  const tokenRes = await fetchJson('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      client_id: clientId,
      redirect_uri: redirectUri,
      resource,
    }).toString(),
  })
  assert.ok(tokenRes.data.access_token, `token failed: ${JSON.stringify(tokenRes.data)}`)
  return tokenRes.data.access_token
}

async function callMcp(auth: { token: string; treeId: number }, method: string, params: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/mcp/trees/${auth.treeId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await res.text()
  try {
    return { status: res.status, data: JSON.parse(text) }
  } catch {
    return { status: res.status, data: text }
  }
}

async function run() {
  console.log('=== T4-test: MCP audit log integration ===\n')

  // 1. Test login
  const loginRes = await fetchJson('/auth/test-login', { redirect: 'manual' })
  assert.equal(loginRes.status, 302)
  const sessionCookie = getCookie(loginRes.headers, 'session')
  assert.ok(sessionCookie)
  const cookieHeader = `session=${sessionCookie}`
  console.log('1. Logged in')

  // Get user info
  const profileRes = await fetchJson('/api/profile', { headers: { Cookie: cookieHeader } })
  const userId = profileRes.data.data.id
  console.log(`   userId=${userId}`)

  // 2. Create tree for API key root_node_id
  const treeRes = await fetchJson('/api/trees', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ name: 'MCP Audit Test Tree' }),
  })
  assert.equal(treeRes.data.success, true, JSON.stringify(treeRes.data))
  const treeId = treeRes.data.data.id
  const rootNodeId = treeRes.data.data.root_node_id
  console.log(`2. Tree created (id=${treeId}, root_node_id=${rootNodeId})`)

  // 3. Obtain MCP access token via OAuth
  const accessToken = await obtainMcpAccessToken(cookieHeader, treeId)
  const auth = { token: accessToken, treeId }
  console.log('3. MCP access token obtained via OAuth')

  // Clear audit logs to get a clean baseline
  dbQuery('DELETE FROM audit_logs WHERE source = \'mcp\'')
  const baseline = parseInt(dbQuery("SELECT COUNT(*) FROM audit_logs WHERE source = 'mcp'") || '0', 10)
  console.log(`   MCP audit baseline: ${baseline}\n`)

  // 4. MCP: get_root_node_id (read)
  console.log('4. MCP get_root_node_id ...')
  const r1 = await callMcp(auth, 'tools/call', { name: 'get_root_node_id', arguments: {} })
  assert.equal(r1.data.result?.content?.[0]?.type, 'text')
  console.log('   ✓')

  // 5. MCP: search_nodes (read)
  console.log('5. MCP search_nodes ...')
  const r2 = await callMcp(auth, 'tools/call', { name: 'search_nodes', arguments: { keyword: 'MCP' } })
  assert.equal(r2.data.result?.content?.[0]?.type, 'text')
  console.log('   ✓')

  // 6. MCP: create_node (write)
  console.log('6. MCP create_node ...')
  const r3 = await callMcp(auth, 'tools/call', {
    name: 'create_node',
    arguments: { title: 'MCP Audit Node', content: 'test', parent_ids: [rootNodeId] },
  })
  assert.equal(r3.data.result?.content?.[0]?.type, 'text')
  const createdNode = JSON.parse(r3.data.result.content[0].text)
  const createdNodeId = createdNode.id
  console.log(`   ✓ node id=${createdNodeId}`)

  // 7. MCP: read_node (read)
  console.log('7. MCP read_node ...')
  const r4 = await callMcp(auth, 'tools/call', {
    name: 'read_node',
    arguments: { node_id: createdNodeId },
  })
  assert.equal(r4.data.result?.content?.[0]?.type, 'text')
  console.log('   ✓')

  // 監査ログは waitUntil で応答後に非同期書き込みされ、別プロセスの sqlite3 リーダーには
  // さらに遅れて見えるため、行が取得できるまでポーリングする
  let readNodeAudit = ''
  for (let attempt = 0; attempt < 20 && readNodeAudit === ''; attempt++) {
    await new Promise((r) => setTimeout(r, 500))
    readNodeAudit = dbQuery(
      "SELECT user_id, IFNULL(api_key_id, 'NULL') FROM audit_logs WHERE source = 'mcp' AND action = 'mcp.read.node' ORDER BY id DESC LIMIT 1"
    )
  }
  const [readNodeUserIdRaw, readNodeApiKeyIdRaw] = readNodeAudit.split('|')
  assert.equal(Number(readNodeUserIdRaw), userId, 'mcp.read.node user_id should match the token owner')
  // APIキー方式の廃止により api_key_id は常に NULL になる
  assert.equal(readNodeApiKeyIdRaw, 'NULL', 'mcp.read.node api_key_id should be NULL for OAuth access')

  // 8. MCP: update_node (write)
  console.log('8. MCP update_node ...')
  const r5 = await callMcp(auth, 'tools/call', {
    name: 'update_node',
    arguments: { node_id: createdNodeId, title: 'Updated MCP Node' },
  })
  assert.equal(r5.data.result?.content?.[0]?.type, 'text')
  console.log('   ✓')

  // 8-b. 回帰防止: update_node は mcp.node.append_content を出してはいけない。
  //
  // 以前は update_node の末尾に mcp.node.append_content の queueAuditLog が
  // 混入しており、①update_node 1回で監査ログが2行増える ②実際には起きていない
  // 追記が記録される ③本来の append_node_content は何も残さない、という状態だった。
  // 「必須アクションが揃っているか」だけを見るテストでは検出できなかったため、
  // ここで「まだ出ていないこと」を明示的に確認する。
  await new Promise((r) => setTimeout(r, 800))
  const appendBeforeStep9 = parseInt(
    dbQuery("SELECT COUNT(*) FROM audit_logs WHERE source = 'mcp' AND action = 'mcp.node.append_content'") || '0',
    10,
  )
  assert.equal(
    appendBeforeStep9,
    0,
    'update_node must not emit mcp.node.append_content (it did before the 2026-09-05 fix)',
  )
  console.log('8-b. update_node が append_content を出さないこと ... ✓')

  // 9. MCP: append_node_content (write)
  console.log('9. MCP append_node_content ...')
  const r6 = await callMcp(auth, 'tools/call', {
    name: 'append_node_content',
    arguments: { node_id: createdNodeId, content: '\n appended text' },
  })
  assert.equal(r6.data.result?.content?.[0]?.type, 'text')
  console.log('   ✓')

  // 9-b. append_node_content 自身が監査ログを出すこと（以前は1件も出していなかった）
  await new Promise((r) => setTimeout(r, 800))
  const appendAfterStep9 = parseInt(
    dbQuery("SELECT COUNT(*) FROM audit_logs WHERE source = 'mcp' AND action = 'mcp.node.append_content'") || '0',
    10,
  )
  assert.equal(appendAfterStep9, 1, 'append_node_content must emit exactly one mcp.node.append_content')
  console.log('9-b. append_node_content が監査ログを出すこと ... ✓')

  // 10. MCP: get_children (read)
  console.log('10. MCP get_children ...')
  const r7 = await callMcp(auth, 'tools/call', {
    name: 'get_children',
    arguments: { node_id: rootNodeId },
  })
  assert.equal(r7.data.result?.content?.[0]?.type, 'text')
  console.log('   ✓')

  // 11. MCP: get_parents (read)
  console.log('11. MCP get_parents ...')
  const r8 = await callMcp(auth, 'tools/call', {
    name: 'get_parents',
    arguments: { node_id: createdNodeId },
  })
  assert.equal(r8.data.result?.content?.[0]?.type, 'text')
  console.log('   ✓')

  // 12. MCP: link_node (write)
  // Create two nodes under root, then link them
  const r9a = await callMcp(auth, 'tools/call', {
    name: 'create_node',
    arguments: { title: 'Link Parent', content: '', parent_ids: [rootNodeId] },
  })
  const linkParentId = JSON.parse(r9a.data.result.content[0].text).id
  const r9b = await callMcp(auth, 'tools/call', {
    name: 'create_node',
    arguments: { title: 'Link Child', content: '', parent_ids: [rootNodeId] },
  })
  const linkChildId = JSON.parse(r9b.data.result.content[0].text).id
  await new Promise((r) => setTimeout(r, 500))
  console.log('12. MCP link_node ...')
  const r10 = await callMcp(auth, 'tools/call', {
    name: 'link_node',
    arguments: { parent_id: linkParentId, child_id: linkChildId },
  })
  assert.equal(r10.data.result?.content?.[0]?.type, 'text')
  console.log('   ✓')
  await new Promise((r) => setTimeout(r, 500))

  // 12-b. MCP: update_link_relation_type (write)
  //
  // このツールは 2026-09-05 まで監査ログを一切出していなかった
  // （mcp.update_link_relation_type は AuditAction 型に定義済みだが未発火）。
  // リレーション種別の変更が記録されない状態だったため、検証対象に加える。
  console.log('12-b. MCP update_link_relation_type ...')
  const r10b = await callMcp(auth, 'tools/call', {
    name: 'update_link_relation_type',
    arguments: { parent_id: linkParentId, child_id: linkChildId, relation_type: 'REFERENCE' },
  })
  assert.equal(r10b.data.result?.content?.[0]?.type, 'text')
  console.log('   ✓')
  await new Promise((r) => setTimeout(r, 500))

  // 13. MCP: unlink_node (write)
  console.log('13. MCP unlink_node ...')
  const r11 = await callMcp(auth, 'tools/call', {
    name: 'unlink_node',
    arguments: { parent_id: linkParentId, child_id: linkChildId },
  })
  assert.equal(r11.data.result?.content?.[0]?.type, 'text')
  console.log('   ✓')
  await new Promise((r) => setTimeout(r, 500))

  // 14. MCP: trash_node (write)
  console.log('14. MCP trash_node ...')
  const r12 = await callMcp(auth, 'tools/call', {
    name: 'trash_node',
    arguments: { node_id: linkChildId },
  })
  assert.equal(r12.data.result?.content?.[0]?.type, 'text')
  console.log('   ✓')

  // Wait for background writes
  await new Promise((r) => setTimeout(r, 800))

  // Verify audit_logs
  const finalCount = parseInt(dbQuery("SELECT COUNT(*) FROM audit_logs WHERE source = 'mcp'") || '0', 10)
  console.log(`\nFinal MCP audit_logs count: ${finalCount}`)

  const rows = dbQuery(`SELECT action, target_type, target_id, IFNULL(api_key_id, 'NULL') FROM audit_logs WHERE source = 'mcp' ORDER BY id DESC LIMIT 20`)
  console.log('\nRecent MCP audit_logs:')
  console.log(rows)

  const actions = dbQuery("SELECT action FROM audit_logs WHERE source = 'mcp' ORDER BY id DESC LIMIT 20").split('\n')
  const requiredActions = [
    'mcp.read.root_node_id',
    'mcp.read.search',
    'mcp.node.create',
    'mcp.read.node',
    'mcp.node.update',
    'mcp.node.append_content',
    'mcp.read.children',
    'mcp.read.parents',
    'mcp.link_node',
    'mcp.update_link_relation_type',
    'mcp.unlink_node',
    'mcp.trash_node',
  ]

  console.log('\n=== Action verification ===')
  for (const action of requiredActions) {
    const found = actions.includes(action)
    console.log(`  ${action}: ${found ? '✅' : '❌'}`)
    assert.ok(found, `Missing MCP audit action: ${action}`)
  }

  console.log('\n✅ All T4-test assertions passed!')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
