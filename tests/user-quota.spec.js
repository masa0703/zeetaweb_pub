import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { issueMcpAuth, callMcp } from './helpers/mcp-oauth.js'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const QUOTA_USER = 9901

// ローカル D1 を直接読み書きする（node_count を上限近くに設定するため）
function localD1(sql) {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'zeeta2-production', '--local', '--json', '--command', sql], { encoding: 'utf8' })
  return JSON.parse(out)[0].results
}

async function login(page) {
  const res = await page.request.get(`${BASE_URL}/auth/test-login?user_id=${QUOTA_USER}`, { maxRedirects: 0 })
  expect(res.status()).toBe(302)
}

async function deleteQuotaTrees(page) {
  const res = await page.request.get(`${BASE_URL}/api/trees`)
  const body = await res.json()
  const trees = Array.isArray(body.data) ? body.data : (body.data?.trees || [])
  for (const tree of trees) {
    if (String(tree.name || '').startsWith('quota-')) await page.request.delete(`${BASE_URL}/api/trees/${tree.id}`)
  }
}

async function createTree(page, name) {
  const res = await page.request.post(`${BASE_URL}/api/trees`, { data: { name } })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data
}

function nodeCount(treeId) {
  const [row] = localD1(`SELECT node_count, (SELECT COUNT(*) FROM nodes WHERE tree_id = ${treeId}) AS actual FROM trees WHERE id = ${treeId}`)
  return row
}

test.describe('user quotas', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await deleteQuotaTrees(page)
  })
  test.afterEach(async ({ page }) => {
    await deleteQuotaTrees(page)
  })

  test('rejects the 21st owned tree and does not count deleted trees', async ({ page }) => {
    const created = []
    for (let i = 0; i < 21; i++) {
      const response = await page.request.post(`${BASE_URL}/api/trees`, { data: { name: `quota-${Date.now()}-${i}` } })
      if (i < 20) expect(response.ok()).toBeTruthy()
      else {
        expect(response.status()).toBe(409)
        expect((await response.json()).error).toBe('Tree quota exceeded')
      }
      if (response.ok()) created.push((await response.json()).data.id)
    }
    expect(created).toHaveLength(20)
    const deleted = await page.request.delete(`${BASE_URL}/api/trees/${created[0]}`)
    expect(deleted.ok()).toBeTruthy()
    const afterDelete = await page.request.post(`${BASE_URL}/api/trees`, { data: { name: `quota-after-delete-${Date.now()}` } })
    expect(afterDelete.ok()).toBeTruthy()
  })

  test('node counter matches actual rows on create and permanent delete; tree list hides root and trash', async ({ page }) => {
    const tree = await createTree(page, `quota-count-${Date.now()}`)
    const start = nodeCount(tree.id)
    expect(start.node_count).toBe(start.actual)

    const res = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes/with-parent`, {
      data: { title: 'counted', content: '', author_user_id: QUOTA_USER, parent_node_id: tree.root_node_id },
    })
    let created = res.ok() ? ((await res.json()).data?.node || null) : null
    if (!created) {
      const plain = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes`, { data: { title: 'counted', content: '', author_user_id: QUOTA_USER } })
      expect(plain.ok()).toBeTruthy()
      created = (await plain.json()).data
    }
    const afterCreate = nodeCount(tree.id)
    expect(afterCreate.node_count).toBe(start.node_count + 1)
    expect(afterCreate.node_count).toBe(afterCreate.actual)

    const list = await (await page.request.get(`${BASE_URL}/api/trees`)).json()
    const listed = (Array.isArray(list.data) ? list.data : list.data?.trees || []).find((t) => t.id === tree.id)
    expect(listed.node_count).toBe(afterCreate.actual - 2)

    expect((await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${created.id}`)).ok()).toBeTruthy()
    expect((await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${created.id}/permanent`)).ok()).toBeTruthy()
    const afterDelete = nodeCount(tree.id)
    expect(afterDelete.node_count).toBe(start.node_count)
    expect(afterDelete.node_count).toBe(afterDelete.actual)
  })

  test('REST node creation stops at the per-tree limit', async ({ page }) => {
    const tree = await createTree(page, `quota-rest-${Date.now()}`)
    localD1(`UPDATE trees SET node_count = 19999 WHERE id = ${tree.id}`)
    const ok = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes`, { data: { title: 'last', content: '', author_user_id: QUOTA_USER } })
    expect(ok.status()).toBe(201)
    const over = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes`, { data: { title: 'over', content: '', author_user_id: QUOTA_USER } })
    expect(over.status()).toBe(409)
    expect((await over.json()).error).toBe('Node quota exceeded')
    expect(nodeCount(tree.id).node_count).toBe(20000)
  })

  test('MCP create_node_tree creates nothing when the total would exceed the limit', async ({ page }) => {
    const tree = await createTree(page, `quota-mcp-${Date.now()}`)
    const auth = await issueMcpAuth(page, tree.id)
    localD1(`UPDATE trees SET node_count = 19999 WHERE id = ${tree.id}`)
    const before = nodeCount(tree.id)
    const res = await callMcp(page, auth, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'create_node_tree', arguments: { parent_node_id: String(tree.root_node_id), nodes: [{ title: 'a', children: [{ title: 'b' }] }] } },
    })
    expect(res.result.isError).toBeTruthy()
    const after = nodeCount(tree.id)
    expect(after.actual).toBe(before.actual)
    expect(after.node_count).toBe(19999)
  })
})
