import { test, expect } from './helpers/fixtures.js'
import { waitForAppReady, testLogin, openTreeEditor } from './helpers/app.js'

// ツリーごとに最後に選択したノードを覚え、URL にノード指定が無く開いたときに復元する。
// 仕様の正は zeeta「最後のノードを記憶する (id:1Dck6L)」の実装計画。

const STORAGE_PREFIX = 'zeeta:last-selected-node:'

async function clearTestData(page) {
  await page.request.delete('/api/test/clear')
}

async function createTree(page, name) {
  const response = await page.request.post('/api/trees', { data: { name } })
  expect(response.status()).toBe(201)
  return (await response.json()).data
}

async function createChildNode(page, treeId, title) {
  const rootRes = await page.request.get(`/api/trees/${treeId}/nodes`)
  const rootNodeId = String((await rootRes.json()).root_node_id)
  const me = (await (await page.request.get('/auth/me')).json()).data
  const res = await page.request.post(`/api/trees/${treeId}/nodes/with-parent`, {
    data: { title, content: '', author_user_id: me.id, parent_node_id: rootNodeId }
  })
  expect(res.status()).toBe(201)
  return (await res.json()).data.node
}

async function clickNode(page, title) {
  await page.locator('.tree-item', { hasText: title }).first().click()
  await expect(page.locator('#node-title')).toHaveValue(title)
}

async function switchTreeByRail(page, treeId) {
  await page.locator(`#tree-rail-list .tree-rail-chip[data-tree-id="${treeId}"]`).click()
  await waitForAppReady(page)
  await expect.poll(() => new URL(page.url()).searchParams.get('tree')).toBe(String(treeId))
}

async function readStoredMap(page) {
  return page.evaluate((prefix) => {
    const key = Object.keys(localStorage).find(k => k.startsWith(prefix))
    return key ? JSON.parse(localStorage.getItem(key)) : null
  }, STORAGE_PREFIX)
}

test.describe('最後に選択したノードの復元', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
    await testLogin(page, 1)
  })

  test('TC-LASTNODE-001: 左バーで別ツリーへ行って戻ると、前に選んでいたノードが選ばれている', async ({ page }) => {
    const treeA = await createTree(page, 'Tree A')
    const treeB = await createTree(page, 'Tree B')
    await createChildNode(page, treeA.id, 'A-1')
    await createChildNode(page, treeA.id, 'A-2')

    await openTreeEditor(page, treeA.id)
    await clickNode(page, 'A-2')

    await switchTreeByRail(page, treeB.id)
    await switchTreeByRail(page, treeA.id)

    await expect(page.locator('#node-title')).toHaveValue('A-2')
    await expect(page.locator('.tree-item.active')).toContainText('A-2')
  })

  test('TC-LASTNODE-002: ツリーごとに別々のノードを覚えている', async ({ page }) => {
    const treeA = await createTree(page, 'Tree A')
    const treeB = await createTree(page, 'Tree B')
    await createChildNode(page, treeA.id, 'A-1')
    await createChildNode(page, treeB.id, 'B-1')
    await createChildNode(page, treeB.id, 'B-2')

    await openTreeEditor(page, treeA.id)
    await clickNode(page, 'A-1')
    await switchTreeByRail(page, treeB.id)
    await clickNode(page, 'B-2')

    await switchTreeByRail(page, treeA.id)
    await expect(page.locator('#node-title')).toHaveValue('A-1')
    await switchTreeByRail(page, treeB.id)
    await expect(page.locator('#node-title')).toHaveValue('B-2')
  })

  test('TC-LASTNODE-003: F5 で再読み込みしても同じノードが選ばれている', async ({ page }) => {
    const tree = await createTree(page, 'Reload Tree')
    await createChildNode(page, tree.id, 'R-1')
    await createChildNode(page, tree.id, 'R-2')

    await openTreeEditor(page, tree.id)
    await clickNode(page, 'R-2')

    await page.reload()
    await waitForAppReady(page)
    await expect(page.locator('#node-title')).toHaveValue('R-2')
  })

  test('TC-LASTNODE-004: URL のノード指定は記録より優先される', async ({ page }) => {
    const tree = await createTree(page, 'Url Tree')
    const first = await createChildNode(page, tree.id, 'U-1')
    await createChildNode(page, tree.id, 'U-2')

    await openTreeEditor(page, tree.id)
    await clickNode(page, 'U-2')

    await openTreeEditor(page, tree.id, first.id)
    await expect(page.locator('#node-title')).toHaveValue('U-1')
  })

  for (const { label, remove } of [
    { label: 'ゴミ箱へ移した', remove: (page, treeId, nodeId) => page.request.delete(`/api/trees/${treeId}/nodes/${nodeId}`) },
    { label: '完全に削除した', remove: async (page, treeId, nodeId) => {
      const trashed = await page.request.delete(`/api/trees/${treeId}/nodes/${nodeId}`)
      expect(trashed.ok()).toBe(true)
      return page.request.delete(`/api/trees/${treeId}/nodes/${nodeId}/permanent`)
    } }
  ]) {
    test(`TC-LASTNODE-005: 記録したノードを${label}ときは、エラーを出さず何も選択しない`, async ({ page }) => {
      const tree = await createTree(page, 'Gone Tree')
      const node = await createChildNode(page, tree.id, 'G-1')

      await openTreeEditor(page, tree.id)
      await clickNode(page, 'G-1')
      expect((await readStoredMap(page))?.[String(tree.id)]?.nodeId).toBe(String(node.id))

      const res = await remove(page, tree.id, node.id)
      expect(res.ok()).toBe(true)

      await openTreeEditor(page, tree.id)
      await expect(page.locator('#editor-panel')).toContainText('左側のノードを選択してください')
      await expect(page.locator('.tree-item.active')).toHaveCount(0)
      await expect(page.locator('.tree-view-tab[data-view="normal"]')).toHaveClass(/active/)
      await expect(page.locator('.toast-message')).toHaveCount(0)
      expect((await readStoredMap(page))?.[String(tree.id)]).toBeUndefined()
    })
  }
})
