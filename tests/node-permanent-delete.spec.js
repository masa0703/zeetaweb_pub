import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

async function clearTestData(page) {
  await page.request.delete('/api/test/clear')
}

async function testLogin(page, userId = 1) {
  await page.goto(`/auth/test-login?user_id=${userId}`)
  await waitForAppReady(page)
}

async function createTree(page, name) {
  const res = await page.request.post('/api/trees', { data: { name, description: 'permanent delete test' } })
  const data = await res.json()
  expect(res.ok()).toBeTruthy()
  expect(data.success).toBeTruthy()
  return data.data
}

async function getTreeRootNodeId(page, treeId) {
  const res = await page.request.get(`/api/trees/${treeId}/nodes`)
  const data = await res.json()
  expect(res.ok()).toBeTruthy()
  expect(data.success).toBeTruthy()
  return String(data.root_node_id)
}

async function createChildNode(page, treeId, title, parentNodeId) {
  const res = await page.request.post(`/api/trees/${treeId}/nodes/with-parent`, {
    data: { title, content: '', author_user_id: 1, parent_node_id: parentNodeId },
  })
  expect(res.status()).toBe(201)
  const data = await res.json()
  expect(data.success).toBeTruthy()
  return data.data.node
}

test.describe('ゴミ箱完全削除（D1バインド変数上限 回帰）', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
    await testLogin(page, 1)
  })

  test('TC-PERMANENT-001: 100ノード超のサブツリーをゴミ箱から完全削除できる', async ({ page }) => {
    // 親1 + 子110 = 完全削除対象111件（D1のバインド変数上限100を超える）
    const tree = await createTree(page, 'Permanent Delete Limit Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const parent = await createChildNode(page, tree.id, 'bulk-parent', rootNodeId)
    for (let i = 0; i < 110; i += 1) {
      await createChildNode(page, tree.id, `perm-child-${i + 1}`, parent.id)
    }

    const trashRes = await page.request.delete(`/api/trees/${tree.id}/nodes/${parent.id}`)
    const trashData = await trashRes.json()
    expect(trashRes.status()).toBe(200)
    expect(trashData.success).toBeTruthy()

    // 修正前: DELETE FROM nodes WHERE tree_id = ? AND id IN (?, ×111) が
    // バインド変数 112 個となり "too many SQL variables" で 500 になる
    const permanentRes = await page.request.delete(`/api/trees/${tree.id}/nodes/${parent.id}/permanent`)
    const permanentData = await permanentRes.json()
    expect(permanentRes.status(), JSON.stringify(permanentData)).toBe(200)
    expect(permanentData.success).toBeTruthy()
    expect(permanentData.deleted_count).toBe(111)
    expect(permanentData.skipped_count).toBe(0)
  })

  test('TC-PERMANENT-002: 完全削除で親が1人になった子の関係は STRUCTURAL になる', async ({ page }) => {
    const REFERENCE = 3
    const tree = await createTree(page, 'Permanent Delete Sole Parent Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const trashedParent = await createChildNode(page, tree.id, 'trashed-parent', rootNodeId)
    const outsideParent = await createChildNode(page, tree.id, 'outside-parent', rootNodeId)
    const sharedChild = await createChildNode(page, tree.id, 'shared-child', trashedParent.id)
    const ownedChild = await createChildNode(page, tree.id, 'owned-child', trashedParent.id)
    const linkRes = await page.request.post(`/api/trees/${tree.id}/relations`, {
      data: { parent_node_id: outsideParent.id, child_node_id: sharedChild.id, relation_type_id: REFERENCE },
    })
    expect(linkRes.status()).toBe(201)

    const trashRes = await page.request.delete(`/api/trees/${tree.id}/nodes/${trashedParent.id}`)
    expect(trashRes.status()).toBe(200)
    const permanentRes = await page.request.delete(`/api/trees/${tree.id}/nodes/${trashedParent.id}/permanent`)
    const permanentData = await permanentRes.json()
    expect(permanentRes.status(), JSON.stringify(permanentData)).toBe(200)
    // 外側の親を持つ shared-child は残り、親だけを失った owned-child は消える
    expect(permanentData.deleted_count).toBe(2)
    expect(permanentData.skipped_count).toBe(1)

    const relationsRes = await page.request.get(`/api/trees/${tree.id}/relations`)
    const relations = ((await relationsRes.json()).data || []).filter(r => r.child_node_id === sharedChild.id)
    expect(relations.map(r => [r.parent_node_id, Number(r.relation_type_id)]))
      .toEqual([[outsideParent.id, 1]])
    expect((await page.request.get(`/api/trees/${tree.id}/nodes/${ownedChild.id}`)).status()).toBe(404)
  })
})
