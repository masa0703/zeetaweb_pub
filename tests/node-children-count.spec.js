import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

/**
 * 右ペインのヘッダーで、「親ノード」ドロップダウンの右に「(N)」（直下の子の数）を表示する。
 * 見た目（フォントサイズ・色）はノードIDの表示（#node-id-copy）と同じ。
 */

const BASE_URL = 'http://localhost:3000'

async function testLogin(page) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=1`)
  await waitForAppReady(page)
}

async function createTree(page, name) {
  const res = await page.request.post(`${BASE_URL}/api/trees`, { data: { name, description: '' } })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data
}

async function getRootNodeId(page, treeId) {
  const res = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes`)
  return String((await res.json()).root_node_id)
}

async function createNode(page, treeId, parentNodeId, title) {
  const me = (await (await page.request.get(`${BASE_URL}/auth/me`)).json()).data
  const res = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes/with-parent`, {
    data: { title, content: '', author_user_id: me.id, parent_node_id: parentNodeId },
  })
  expect(res.status()).toBe(201)
  return (await res.json()).data.node
}

async function openNode(page, treeId, nodeId, title) {
  await page.goto(`${BASE_URL}/?tree=${treeId}&node=${nodeId}`)
  await page.waitForSelector('#editor-panel')
  await expect(page.locator('#node-title')).toHaveValue(title)
}

test.describe('子ノードの数を表示', () => {
  test.beforeEach(async ({ page }) => {
    await testLogin(page)
  })

  test('TC-CHILDREN-COUNT-001: 親ノードのドロップダウンの右に、直下の子の数を表示する', async ({ page }) => {
    const tree = await createTree(page, 'children-count')
    const rootId = await getRootNodeId(page, tree.id)
    const parent = await createNode(page, tree.id, rootId, 'Parent')
    const child1 = await createNode(page, tree.id, parent.id, 'Child 1')
    await createNode(page, tree.id, parent.id, 'Child 2')
    await createNode(page, tree.id, parent.id, 'Child 3')
    // 孫は数えない
    await createNode(page, tree.id, child1.id, 'Grandchild')

    await openNode(page, tree.id, parent.id, 'Parent')
    const count = page.locator('#node-children-count')
    await expect(count).toHaveText('(3)')

    // ドロップダウンの右側にある（同じ行で、左端がドロップダウンの右端以上）
    const toggleBox = await page.locator('button.parents-chip-toggle').boundingBox()
    const countBox = await count.boundingBox()
    expect(countBox.x).toBeGreaterThanOrEqual(toggleBox.x + toggleBox.width)
    const toggleCenterY = toggleBox.y + toggleBox.height / 2
    expect(countBox.y).toBeLessThan(toggleCenterY)
    expect(countBox.y + countBox.height).toBeGreaterThan(toggleCenterY)

    // 子の無いノードは 0
    await openNode(page, tree.id, child1.id, 'Child 1')
    await expect(count).toHaveText('(1)')
    const leaf = await createNode(page, tree.id, parent.id, 'Leaf')
    await openNode(page, tree.id, leaf.id, 'Leaf')
    await expect(count).toHaveText('(0)')
  })

  test('TC-CHILDREN-COUNT-002: フォントサイズと色はノードIDの表示と同じ', async ({ page }) => {
    const tree = await createTree(page, 'children-count-style')
    const rootId = await getRootNodeId(page, tree.id)
    const node = await createNode(page, tree.id, rootId, 'Styled')

    await openNode(page, tree.id, node.id, 'Styled')
    const styleOf = (selector) => page.locator(selector).evaluate((el) => {
      const s = getComputedStyle(el)
      return { fontSize: s.fontSize, color: s.color, fontFamily: s.fontFamily }
    })
    expect(await styleOf('#node-children-count')).toEqual(await styleOf('#node-id-copy'))
  })

  test('TC-CHILDREN-COUNT-003: 表示中のノードに子が増えると、選び直さなくても数が変わる', async ({ page }) => {
    const tree = await createTree(page, 'children-count-update')
    const rootId = await getRootNodeId(page, tree.id)
    const parent = await createNode(page, tree.id, rootId, 'Parent')
    await createNode(page, tree.id, parent.id, 'Child 1')
    const other = await createNode(page, tree.id, rootId, 'Other')

    await openNode(page, tree.id, parent.id, 'Parent')
    await expect(page.locator('#node-children-count')).toHaveText('(1)')

    // 参照の貼り付けと同じ処理で、表示中の Parent に Other を子として加える
    const added = await page.evaluate(([p, c]) => window.addRelation(p, c), [parent.id, other.id])
    expect(added).toBe(true)

    await expect(page.locator('#node-children-count')).toHaveText('(2)')
    await expect(page.locator('#node-title')).toHaveValue('Parent')
  })
})
