import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

const BASE_URL = 'http://localhost:3000'
const REFERENCE = 3
const ACTIVE = /(^|\s)active(\s|$)/

async function login(page, userId = 1) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
}

async function createChild(page, treeId, title, parentNodeId, content = '') {
  const res = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes/with-parent`, {
    data: { title, content, author_user_id: 1, parent_node_id: parentNodeId }
  })
  expect(res.status()).toBe(201)
  return (await res.json()).data.node
}

async function addReference(page, treeId, parentId, childId) {
  const res = await page.request.post(`${BASE_URL}/api/trees/${treeId}/relations`, {
    data: { parent_node_id: parentId, child_node_id: childId, relation_type_id: REFERENCE }
  })
  expect(res.status()).toBe(201)
}

// root 直下に X・Z（この順）。A は Z の下が STRUCTURAL、X の下が REFERENCE
async function createSharedChildTree(page) {
  const treeRes = await page.request.post(`${BASE_URL}/api/trees`, { data: { name: 'URL open structural', description: '' } })
  const tree = (await treeRes.json()).data
  const rootRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes`)
  const rootId = String((await rootRes.json()).root_node_id)
  const x = await createChild(page, tree.id, 'X', rootId)
  const z = await createChild(page, tree.id, 'Z', rootId)
  const a = await createChild(page, tree.id, 'A', z.id)
  await addReference(page, tree.id, x.id, a.id)
  return { tree, rootId, x, z, a }
}

const item = (page, path) => page.locator(`.tree-item[data-node-path="${path}"]`)

test.describe('URL・ノードリンクでノードを開くときは STRUCTURAL の経路だけを開く', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.delete(`${BASE_URL}/api/test/clear`)
    await login(page)
  })

  test('TC-URLOPEN-001: URL で開くと STRUCTURAL の経路（Z>A）が選ばれて見え、REFERENCE の親 X は閉じたまま', async ({ page }) => {
    const { tree, x, z, a } = await createSharedChildTree(page)

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${a.id}`)
    await waitForAppReady(page)

    await expect(page.locator('#node-title')).toHaveValue('A')
    await expect(item(page, `${z.id}-${a.id}`)).toHaveClass(ACTIVE)
    await expect(item(page, `${z.id}-${a.id}`)).toBeVisible()
    await expect(item(page, `${x.id}-${a.id}`)).toBeHidden()
  })

  test('TC-URLOPEN-002: 本文のノードリンクから開いても STRUCTURAL の経路（Z>A）が選ばれ、X は閉じたまま', async ({ page }) => {
    const { tree, rootId, x, z, a } = await createSharedChildTree(page)
    const source = await createChild(page, tree.id, 'Source', rootId, `[A (id:${a.id})]`)

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${source.id}`)
    await waitForAppReady(page)
    await page.locator('.bytemd-preview .zeeta-node-link').click()

    await expect(page.locator('#node-title')).toHaveValue('A')
    await expect(item(page, `${z.id}-${a.id}`)).toHaveClass(ACTIVE)
    await expect(item(page, `${z.id}-${a.id}`)).toBeVisible()
    await expect(item(page, `${x.id}-${a.id}`)).toBeHidden()
  })

  test('TC-URLOPEN-003: 選択パスが見つからないとき、閉じた親の中の要素より見えている要素を選ぶ', async ({ page }) => {
    const { tree, x, z, a } = await createSharedChildTree(page)
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await waitForAppReady(page)

    // X は閉じ（A は先読みで描画されるが見えない）、Z は開いた状態で、存在しないパスのまま再描画する
    const selectedPath = await page.evaluate(({ x, z, a }) => {
      expandedNodePaths.delete(String(x))
      expandedNodePaths.add(String(z))
      selectedNodeId = a
      selectedNodePath = 'no-such-path'
      renderTree()
      return selectedNodePath
    }, { x: x.id, z: z.id, a: a.id })

    expect(selectedPath).toBe(`${z.id}-${a.id}`)
  })
})
