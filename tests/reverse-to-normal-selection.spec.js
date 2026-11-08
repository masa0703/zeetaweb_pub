import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

const BASE_URL = 'http://localhost:3000'
const REFERENCE = 3

async function login(page, userId = 1) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
}

async function createChild(page, treeId, title, parentNodeId) {
  const res = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes/with-parent`, {
    data: { title, content: '', author_user_id: 1, parent_node_id: parentNodeId }
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

// X・Y・Z の下に同じノード A がある（Z が STRUCTURAL、X・Y は REFERENCE）
async function createSharedChildTree(page) {
  const treeRes = await page.request.post(`${BASE_URL}/api/trees`, { data: { name: 'Reverse to normal', description: '' } })
  const tree = (await treeRes.json()).data
  const rootRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes`)
  const rootId = String((await rootRes.json()).root_node_id)
  const x = await createChild(page, tree.id, 'X', rootId)
  const y = await createChild(page, tree.id, 'Y', rootId)
  const z = await createChild(page, tree.id, 'Z', rootId)
  const a = await createChild(page, tree.id, 'A', z.id)
  await addReference(page, tree.id, x.id, a.id)
  await addReference(page, tree.id, y.id, a.id)
  return { tree, x, y, z, a }
}

const item = (page, path) => page.locator(`.tree-item[data-node-path="${path}"]`)

async function collapse(page, path) {
  const toggle = item(page, path).locator('.toggle-btn')
  if (await toggle.locator('.caret-expanded').count()) await toggle.click()
  await expect(toggle.locator('.caret-expanded')).toHaveCount(0)
}

// 通常表示で X・Y を閉じ、Z の下の A を選んだ状態にする
async function selectAUnderZ(page, { tree, x, y, z, a }) {
  await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${a.id}`)
  await expect(page.locator('#node-title')).toHaveValue('A', { timeout: 15000 })
  await collapse(page, x.id)
  await collapse(page, y.id)
  await item(page, `${z.id}-${a.id}`).locator('.tree-item-title').click()
  await expect(item(page, `${z.id}-${a.id}`)).toHaveClass(/(^|\s)active(\s|$)/)
}

async function switchView(page, view) {
  await page.locator(`button[data-view="${view}"]`).click()
}

test.describe('逆ツリーから通常に戻ったときの選択と展開', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.delete(`${BASE_URL}/api/test/clear`)
    await login(page)
  })

  test('TC-REVNORM-001: 通常で選んでいた位置（Z>A）に戻り、閉じていた X・Y は展開されない', async ({ page }) => {
    const nodes = await createSharedChildTree(page)
    const { x, y, z, a } = nodes
    await selectAUnderZ(page, nodes)

    await switchView(page, 'reverse')
    await expect(item(page, a.id)).toHaveClass(/(^|\s)active(\s|$)/)
    await switchView(page, 'normal')

    await expect(item(page, `${z.id}-${a.id}`)).toHaveClass(/(^|\s)active(\s|$)/)
    await expect(item(page, `${x.id}-${a.id}`)).toBeHidden()
    await expect(item(page, `${y.id}-${a.id}`)).toBeHidden()
    await expect(page.locator('#node-title')).toHaveValue('A')
  })

  test('TC-REVNORM-002: 逆ツリーで別のノード（B）を選んで戻ると、見えている Z>B を選び、閉じていた X は展開されない', async ({ page }) => {
    // X・Z の下に B（Z が STRUCTURAL、X は REFERENCE）、B の下に A
    const treeRes = await page.request.post(`${BASE_URL}/api/trees`, { data: { name: 'Reverse to normal 2', description: '' } })
    const tree = (await treeRes.json()).data
    const rootRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes`)
    const rootId = String((await rootRes.json()).root_node_id)
    const x = await createChild(page, tree.id, 'X', rootId)
    const z = await createChild(page, tree.id, 'Z', rootId)
    const b = await createChild(page, tree.id, 'B', z.id)
    const a = await createChild(page, tree.id, 'A', b.id)
    await addReference(page, tree.id, x.id, b.id)

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${a.id}`)
    await expect(page.locator('#node-title')).toHaveValue('A', { timeout: 15000 })
    await collapse(page, x.id)
    await item(page, `${z.id}-${b.id}-${a.id}`).locator('.tree-item-title').click()
    await expect(item(page, `${z.id}-${b.id}-${a.id}`)).toHaveClass(/(^|\s)active(\s|$)/)

    await switchView(page, 'reverse')
    await item(page, `${a.id}-${b.id}`).locator('.tree-item-title').click()
    await expect(page.locator('#node-title')).toHaveValue('B')
    await switchView(page, 'normal')

    await expect(item(page, `${z.id}-${b.id}`)).toHaveClass(/(^|\s)active(\s|$)/)
    await expect(item(page, `${x.id}-${b.id}`)).toBeHidden()
    await expect(page.locator('#node-title')).toHaveValue('B')
  })
})
