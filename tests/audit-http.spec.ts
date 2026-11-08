/**
 * T3-test: HTTP API audit log integration test
 *
 * Starts the dev server, calls key APIs, and verifies audit_logs entries.
 */

import assert from 'node:assert/strict'
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

async function run() {
  console.log('=== T3-test: HTTP API audit log integration ===\n')

  // 1. Test login
  console.log('1. Test login...')
  const loginRes = await fetchJson('/auth/test-login', { redirect: 'manual' })
  assert.equal(loginRes.status, 302, `Expected 302, got ${loginRes.status}`)
  const sessionCookie = getCookie(loginRes.headers, 'session')
  assert.ok(sessionCookie, 'Session cookie should be set')
  console.log('   ✓ Logged in')

  const cookieHeader = `session=${sessionCookie}`

  // Get user ID first
  const profileRes0 = await fetchJson('/api/profile', {
    headers: { Cookie: cookieHeader },
  })
  const userId = profileRes0.data.data.id

  // Count initial audit_logs
  const initialCount = parseInt(dbQuery('SELECT COUNT(*) FROM audit_logs') || '0', 10)
  console.log(`   Initial audit_logs count: ${initialCount}, userId=${userId}\n`)

  // 2. Create tree
  console.log('2. POST /api/trees ...')
  const treeRes = await fetchJson('/api/trees', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ name: 'Audit Test Tree', description: 'for t3-test' }),
  })
  assert.equal(treeRes.data.success, true, JSON.stringify(treeRes.data))
  const treeId = treeRes.data.data.id
  const rootNodeId = treeRes.data.data.root_node_id
  console.log(`   ✓ Tree created (id=${treeId}, root=${rootNodeId})`)

  // 3. Update tree
  console.log('3. PUT /api/trees/:id ...')
  const updateTreeRes = await fetchJson(`/api/trees/${treeId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ name: 'Updated Audit Tree' }),
  })
  assert.equal(updateTreeRes.data.success, true)
  console.log('   ✓ Tree updated')

  // 4. Create node
  console.log('4. POST /api/trees/:tree_id/nodes ...')
  const nodeRes = await fetchJson(`/api/trees/${treeId}/nodes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ title: 'Audit Node', content: 'test content', author_user_id: userId }),
  })
  assert.equal(nodeRes.data.success, true, JSON.stringify(nodeRes.data))
  const nodeId = nodeRes.data.data.id
  console.log(`   ✓ Node created (id=${nodeId})`)

  // 5. Read node
  console.log('5. GET /api/trees/:tree_id/nodes/:id ...')
  const readNodeRes = await fetchJson(`/api/trees/${treeId}/nodes/${nodeId}`, {
    headers: { Cookie: cookieHeader },
  })
  assert.equal(readNodeRes.data.success, true, JSON.stringify(readNodeRes.data))
  console.log('   ✓ Node read')

  // 6. Update node
  console.log('6. PUT /api/trees/:tree_id/nodes/:id ...')
  const updateNodeRes = await fetchJson(`/api/trees/${treeId}/nodes/${nodeId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ title: 'Updated Audit Node' }),
  })
  assert.equal(updateNodeRes.data.success, true)
  console.log('   ✓ Node updated')

  // 7. Delete node (trash)
  console.log('7. DELETE /api/trees/:tree_id/nodes/:id ...')
  const deleteNodeRes = await fetchJson(`/api/trees/${treeId}/nodes/${nodeId}`, {
    method: 'DELETE',
    headers: { Cookie: cookieHeader },
  })
  assert.equal(deleteNodeRes.data.success, true)
  console.log('   ✓ Node moved to trash')

  // 8. Read tree
  console.log('8. GET /api/trees/:id ...')
  const readTreeRes = await fetchJson(`/api/trees/${treeId}`, {
    headers: { Cookie: cookieHeader },
  })
  assert.equal(readTreeRes.data.success, true)
  console.log('   ✓ Tree read')

  // 9. Read profile
  console.log('9. GET /api/profile ...')
  const profileRes = await fetchJson('/api/profile', {
    headers: { Cookie: cookieHeader },
  })
  assert.equal(profileRes.data.success, true)
  console.log(`   ✓ Profile read (userId=${userId})`)

  // 10. Read API keys (skip if root_node_id not set for test user)
  console.log('10. GET /api/keys ...')
  const keysRes = await fetchJson('/api/keys', {
    headers: { Cookie: cookieHeader },
  })
  if (keysRes.data.success) {
    console.log('   ✓ API keys read')
  } else {
    console.log('   ⚠ API keys skipped (' + keysRes.data.error + ')')
  }

  // 11. Create relation
  console.log('11. POST /api/trees/:tree_id/relations ...')
  // Need another node to create relation. First create a parent node.
  const parentNodeRes = await fetchJson(`/api/trees/${treeId}/nodes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ title: 'Parent Node', content: '', author_user_id: userId }),
  })
  assert.equal(parentNodeRes.data.success, true, JSON.stringify(parentNodeRes.data))
  const parentNodeId = parentNodeRes.data.data.id

  const childNodeRes = await fetchJson(`/api/trees/${treeId}/nodes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ title: 'Child Node', content: '', author_user_id: userId }),
  })
  assert.equal(childNodeRes.data.success, true, JSON.stringify(childNodeRes.data))
  const childNodeId = childNodeRes.data.data.id

  // Attach child to root first so it has more than one parent; otherwise relation.delete rejects.
  const rootChildRelationRes = await fetchJson(`/api/trees/${treeId}/relations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ parent_node_id: rootNodeId, child_node_id: childNodeId }),
  })
  assert.equal(rootChildRelationRes.data.success, true, JSON.stringify(rootChildRelationRes.data))

  const relationRes = await fetchJson(`/api/trees/${treeId}/relations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify({ parent_node_id: parentNodeId, child_node_id: childNodeId }),
  })
  assert.equal(relationRes.data.success, true, JSON.stringify(relationRes.data))
  console.log('   ✓ Relation created')

  // 12. Delete relation
  console.log('12. DELETE /api/trees/:tree_id/relations/:parent_id/:child_id ...')
  const delRelationRes = await fetchJson(`/api/trees/${treeId}/relations/${parentNodeId}/${childNodeId}`, {
    method: 'DELETE',
    headers: { Cookie: cookieHeader },
  })
  assert.equal(delRelationRes.data.success, true)
  console.log('   ✓ Relation deleted')

  // 13. Search
  console.log('13. GET /api/search ...')
  const searchRes = await fetchJson(`/api/search?q=Audit`, {
    headers: { Cookie: cookieHeader },
  })
  assert.equal(searchRes.data.success, true)
  console.log('   ✓ Search executed')

  // 14. Logout
  console.log('14. POST /auth/logout ...')
  const logoutRes = await fetchJson('/auth/logout', {
    method: 'POST',
    headers: { Cookie: cookieHeader },
  })
  assert.equal(logoutRes.data.success, true)
  console.log('   ✓ Logout done')

  // Wait a bit for background writes
  await new Promise((r) => setTimeout(r, 500))

  // Verify audit_logs
  const finalCount = parseInt(dbQuery('SELECT COUNT(*) FROM audit_logs') || '0', 10)
  console.log(`\nFinal audit_logs count: ${finalCount}`)
  console.log(`Expected increase: +13 (tree.create, tree.update, node.create, read.node, node.update, node.delete, read.tree, read.profile, relation.create, relation.delete, read.search, auth.logout, auth.login)`)

  const rows = dbQuery(`SELECT action, target_type, target_id, tree_id, source FROM audit_logs ORDER BY id DESC LIMIT 20`)
  console.log('\nRecent audit_logs:')
  console.log(rows)

  // Check specific actions exist
  const actions = dbQuery(`SELECT action FROM audit_logs WHERE source = 'api' ORDER BY id DESC LIMIT 20`).split('\n')
  const requiredActions = [
    'tree.create',
    'tree.update',
    'node.create',
    'read.node',
    'node.update',
    'node.delete',
    'read.tree',
    'read.profile',
    'relation.create',
    'relation.delete',
    'read.search',
    'auth.logout',
    'auth.login',
  ]

  console.log('\n=== Action verification ===')
  for (const action of requiredActions) {
    const found = actions.includes(action)
    console.log(`  ${action}: ${found ? '✅' : '❌'}`)
    assert.ok(found, `Missing audit action: ${action}`)
  }

  const readNodeAudit = dbQuery(
    `SELECT audit_logs.user_id, nodes.public_id FROM audit_logs JOIN nodes ON audit_logs.target_id = nodes.id WHERE audit_logs.source = 'api' AND audit_logs.action = 'read.node' ORDER BY audit_logs.id DESC LIMIT 1`
  )
  const [readNodeUserIdRaw, readNodePublicId] = readNodeAudit.split('|')
  const readNodeUserId = Number(readNodeUserIdRaw)
  assert.equal(readNodeUserId, userId, 'read.node user_id should match the logged-in user')
  assert.equal(readNodePublicId, nodeId, 'read.node target_id should match the node')

  console.log('\n✅ All T3-test assertions passed!')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
