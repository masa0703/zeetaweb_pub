import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

const BASE_URL = 'http://localhost:3000'

async function login(page, userId) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
}

async function createTree(page, name) {
  const response = await page.request.post(`${BASE_URL}/api/trees`, { data: { name } })
  expect(response.ok()).toBe(true)
  return (await response.json()).data
}

async function createNode(page, treeId, rootId, title, content) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes`, {
    data: { title, content, author_user_id: 1 }
  })
  expect(response.ok()).toBe(true)
  const node = (await response.json()).data
  await addRelation(page, treeId, rootId, node.id)
  return node
}

async function addRelation(page, treeId, parentId, childId, relationTypeId = 1) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/relations`, {
    data: { parent_node_id: parentId, child_node_id: childId, relation_type_id: relationTypeId }
  })
  expect(response.ok()).toBe(true)
}

async function openNode(page, treeId, nodeId) {
  await page.goto(`${BASE_URL}/index.html?tree=${treeId}&node=${nodeId}`)
  await page.waitForSelector('#editor-panel', { timeout: 15000 })
  await expect(page.locator('#node-title')).not.toHaveValue('', { timeout: 15000 })
}

async function openParentsAccordion(page) {
  const accordionToggle = page.locator('button.parents-chip-toggle')
  await expect(accordionToggle).toBeVisible()
  await accordionToggle.click()
  await expect(page.locator('#parents-accordion-overlay')).toBeVisible()
}

test.describe('親ノード表示のゴミ箱対応', () => {
  let tree
  let trashParent
  let normalParent
  let childNode

  test.beforeEach(async ({ page }) => {
    await page.request.delete(`${BASE_URL}/api/test/clear`)
    await login(page, 1)
    tree = await createTree(page, 'Parent trash tree')
    trashParent = await createNode(page, tree.id, tree.root_node_id, '親A', 'trash parent body')
    normalParent = await createNode(page, tree.id, tree.root_node_id, '親C', 'normal parent body')
    childNode = await createNode(page, tree.id, tree.root_node_id, '子B', 'child body')
    // 子Bは root / 親A / 親C の3親持ちにする（親Aをゴミ箱へ移しても root 経由で通常ビューに残る）
    await addRelation(page, tree.id, trashParent.id, childNode.id)
    await addRelation(page, tree.id, normalParent.id, childNode.id)
  })

  test('ゴミ箱専用の親にはバッジが表示され、通常の親には表示されない', async ({ page }) => {
    const trashResponse = await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${trashParent.id}`)
    expect(trashResponse.ok()).toBe(true)

    await openNode(page, tree.id, childNode.id)
    await expect(page.locator('.tree-view-tab[data-view="normal"]')).toHaveClass(/active/, { timeout: 15000 })
    await openParentsAccordion(page)

    const trashBadge = page.locator('.parent-item-badge-trash')
    await expect(trashBadge).toHaveCount(1)
    await expect(trashBadge).toHaveText('🗑 ゴミ箱')

    // バッジはゴミ箱専用親（親A）の行に付き、通常親（親C）・root の行には付かない
    const trashRow = page.locator('.parent-name-link:has-text("親A")').locator('xpath=ancestor::div[contains(@class,"justify-between")][1]')
    await expect(trashRow.locator('.parent-item-badge-trash')).toHaveCount(1)
    const normalRow = page.locator('.parent-name-link:has-text("親C")').locator('xpath=ancestor::div[contains(@class,"justify-between")][1]')
    await expect(normalRow.locator('.parent-item-badge-trash')).toHaveCount(0)
  })

  test('ゴミ箱専用の親をクリックするとゴミ箱ビューに切り替わってから開く', async ({ page }) => {
    const trashResponse = await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${trashParent.id}`)
    expect(trashResponse.ok()).toBe(true)

    await openNode(page, tree.id, childNode.id)
    await openParentsAccordion(page)

    await page.locator('.parent-name-link:has-text("親A")').click()

    await expect(page.locator('.tree-view-tab[data-view="trash"]')).toHaveClass(/active/, { timeout: 15000 })
    await expect(page.locator('#node-title')).toHaveValue('親A', { timeout: 15000 })
  })

  test('通常の親をクリックした場合は従来どおり通常ビューで開く', async ({ page }) => {
    const trashResponse = await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${trashParent.id}`)
    expect(trashResponse.ok()).toBe(true)

    await openNode(page, tree.id, childNode.id)
    await openParentsAccordion(page)

    await page.locator('.parent-name-link:has-text("親C")').click()

    await expect(page.locator('.tree-view-tab[data-view="normal"]')).toHaveClass(/active/, { timeout: 15000 })
    await expect(page.locator('#node-title')).toHaveValue('親C', { timeout: 15000 })
  })

  test('参照リンクで通常側に残るノードの子孫もゴミ箱でグレーになる', async ({ page }) => {
    const shared = await createNode(page, tree.id, trashParent.id, 'f1', '')
    const scope = await createNode(page, tree.id, shared.id, 'f1_スコープ', '')
    const detail = await createNode(page, tree.id, scope.id, 'スコープ詳細', '')
    const trashOnly = await createNode(page, tree.id, trashParent.id, 'ゴミ箱専用', '')
    await addRelation(page, tree.id, normalParent.id, shared.id, 3)
    const response = await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${trashParent.id}`)
    expect(response.ok()).toBe(true)

    await openNode(page, tree.id, normalParent.id)
    const row = (id) => page.locator(`.tree-item[data-node-id="${id}"]`)
    const expand = async (id) => {
      const toggle = row(id).locator('.toggle-btn')
      if (await toggle.locator('.caret-expanded').count() === 0) await toggle.click()
    }
    // 通常側で参照リンクを通じて子孫まで表示できる。
    await expand(normalParent.id)
    await expand(shared.id)
    await expand(scope.id)
    await expect(row(detail.id)).toBeVisible()

    await page.locator('.tree-view-tab[data-view="trash"]').click()
    await expand(trashParent.id)
    await expand(shared.id)
    await expand(scope.id)
    for (const node of [shared, scope, detail]) {
      await expect(row(node.id)).toBeVisible()
      await expect(row(node.id).locator('.tree-item-title')).toHaveCSS('color', 'rgb(156, 163, 175)')
    }
    for (const node of [trashParent, trashOnly]) {
      await expect(row(node.id).locator('.tree-item-title')).not.toHaveCSS('color', 'rgb(156, 163, 175)')
    }
  })

  test('通常側で活きている子孫の親にはゴミ箱バッジを付けず通常ビューで開く', async ({ page }) => {
    const shared = await createNode(page, tree.id, trashParent.id, 'f1', '')
    const scope = await createNode(page, tree.id, shared.id, 'f1_スコープ', '')
    const detail = await createNode(page, tree.id, scope.id, 'スコープ詳細', '')
    const source = await createNode(page, tree.id, tree.root_node_id, '参照元', `[f1_スコープ (id:${scope.id})]`)
    await addRelation(page, tree.id, normalParent.id, shared.id, 3)
    const response = await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${trashParent.id}`)
    expect(response.ok()).toBe(true)

    await openNode(page, tree.id, detail.id)
    await openParentsAccordion(page)
    await expect(page.locator('.parent-name-link')).toHaveText('f1_スコープ')
    await expect(page.locator('.parent-item-badge-trash')).toHaveCount(0)
    await expect(page.locator('.tree-view-tab[data-view="normal"]')).toHaveClass(/active/)

    await page.locator('#parents-accordion-overlay').click({ position: { x: 20, y: 300 } })
    await page.locator('.tree-view-tab[data-view="trash"]').click()
    await openParentsAccordion(page)
    await page.locator('.parent-name-link').click()
    await expect(page.locator('#node-title')).toHaveValue('f1_スコープ')
    await expect(page.locator('.tree-view-tab[data-view="normal"]')).toHaveClass(/active/)

    await openNode(page, tree.id, source.id)
    await page.locator('.bytemd-preview .zeeta-node-link').click()
    await expect(page.locator('#node-title')).toHaveValue('f1_スコープ')
    await expect(page.locator('.tree-view-tab[data-view="normal"]')).toHaveClass(/active/)

    await page.locator('.tree-view-tab[data-view="trash"]').click()
    await page.locator('#tree-search-btn').click()
    await page.locator('.search-popup-input').fill('f1_スコープ')
    await page.locator('.search-popup-submit').click()
    const result = page.locator(`.search-popup-item[data-node-id="${scope.id}"]`)
    await expect(result).toHaveAttribute('data-location-class', 'shared')
    await expect(result.locator('.search-popup-item-badge-trash')).toHaveCount(0)
    await result.click()
    await expect(page.locator('.tree-view-tab[data-view="normal"]')).toHaveClass(/active/)
  })
})
