import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

const BASE_URL = 'http://localhost:3000'

async function login(page, userId = 1) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
}

async function createTree(page, name) {
  const response = await page.request.post(`${BASE_URL}/api/trees`, {
    data: { name, description: '' }
  })
  expect(response.ok()).toBe(true)
  return (await response.json()).data
}

async function createNode(page, treeId, title) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes`, {
    data: { title, content: '', author_user_id: 1 }
  })
  expect(response.ok()).toBe(true)
  return (await response.json()).data
}

async function addRelation(page, treeId, parentId, childId) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/relations`, {
    data: { parent_node_id: parentId, child_node_id: childId }
  })
  expect(response.ok()).toBe(true)
}

async function clearTestData(page) {
  const response = await page.request.delete(`${BASE_URL}/api/test/clear`)
  expect(response.ok()).toBe(true)
}

async function openNode(page, treeId, nodeId, title) {
  await page.goto(`${BASE_URL}/index.html?tree=${treeId}&node=${nodeId}`)
  await expect(page.locator('#node-title')).toHaveValue(title, { timeout: 15000 })
}

function nodeUrl(treeId, nodeId) {
  return `${BASE_URL}/api/trees/${treeId}/nodes/${nodeId}`
}

function parentsUrl(treeId, nodeId) {
  return `${BASE_URL}/api/trees/${treeId}/nodes/${nodeId}/parents`
}

async function waitForConnectionToast(page) {
  await expect(page.locator('.toast-message', { hasText: '通信に失敗しました' }).last()).toBeVisible({ timeout: 10000 })
}

test.describe('ノード取得失敗後の再試行', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('通常モードで同じノードを再クリックすると再試行できる', async ({ page }) => {
    await login(page)
    const tree = await createTree(page, 'Reselect normal tree')
    const nodeA = await createNode(page, tree.id, 'Node A')
    const nodeB = await createNode(page, tree.id, 'Node B')
    await addRelation(page, tree.id, tree.root_node_id, nodeA.id)
    await addRelation(page, tree.id, tree.root_node_id, nodeB.id)
    await openNode(page, tree.id, nodeA.id, 'Node A')

    let attempts = 0
    await page.route(nodeUrl(tree.id, nodeB.id), async route => {
      attempts += 1
      if (attempts === 1) {
        await route.abort('failed')
      } else {
        await route.continue()
      }
    })

    const target = page.locator(`.tree-item[data-node-id="${nodeB.id}"]`).first()
    await target.click()
    await expect.poll(() => attempts).toBe(1)
    await waitForConnectionToast(page)

    await target.click()
    await expect.poll(() => attempts).toBe(2)
    await expect(page.locator('#node-title')).toHaveValue('Node B', { timeout: 15000 })
  })

  test('逆ツリーモードで同じノードを再クリックすると再試行できる', async ({ page }) => {
    await login(page)
    const tree = await createTree(page, 'Reselect reverse tree')
    const parent = await createNode(page, tree.id, 'Parent')
    const child = await createNode(page, tree.id, 'Child')
    await addRelation(page, tree.id, tree.root_node_id, parent.id)
    await addRelation(page, tree.id, parent.id, child.id)
    await openNode(page, tree.id, child.id, 'Child')

    await page.locator('button[data-view="reverse"]').click()
    const target = page.locator(`.tree-item[data-node-id="${parent.id}"]`).first()
    await expect(target).toBeVisible({ timeout: 10000 })

    let attempts = 0
    await page.route(nodeUrl(tree.id, parent.id), async route => {
      attempts += 1
      if (attempts === 1) {
        await route.abort('failed')
      } else {
        await route.continue()
      }
    })

    await target.click()
    await expect.poll(() => attempts).toBe(1)
    await waitForConnectionToast(page)

    await target.click()
    await expect.poll(() => attempts).toBe(2)
    await expect(page.locator('#node-title')).toHaveValue('Parent', { timeout: 15000 })
  })

  test('初回選択の取得失敗後も同じノードを再試行できる', async ({ page }) => {
    await login(page)
    const tree = await createTree(page, 'Reselect initial tree')
    const node = await createNode(page, tree.id, 'First node')
    await addRelation(page, tree.id, tree.root_node_id, node.id)

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForSelector(`.tree-item[data-node-id="${node.id}"]`, { timeout: 15000 })

    let attempts = 0
    await page.route(nodeUrl(tree.id, node.id), async route => {
      attempts += 1
      if (attempts === 1) {
        await route.abort('failed')
      } else {
        await route.continue()
      }
    })

    const target = page.locator(`.tree-item[data-node-id="${node.id}"]`).first()
    await target.click()
    await expect.poll(() => attempts).toBe(1)
    await waitForConnectionToast(page)

    await target.click()
    await expect.poll(() => attempts).toBe(2)
    await expect(page.locator('#node-title')).toHaveValue('First node', { timeout: 15000 })
  })

  test('ノード取得後の親取得失敗も通常・逆ツリーの両方で再試行できる', async ({ page }) => {
    await login(page)
    const tree = await createTree(page, 'Reselect parents tree')
    const parent = await createNode(page, tree.id, 'Parent')
    const child = await createNode(page, tree.id, 'Child')
    await addRelation(page, tree.id, tree.root_node_id, parent.id)
    await addRelation(page, tree.id, parent.id, child.id)
    await openNode(page, tree.id, parent.id, 'Parent')

    let normalAttempts = 0
    await page.route(parentsUrl(tree.id, child.id), async route => {
      normalAttempts += 1
      if (normalAttempts === 1) {
        await route.abort('failed')
      } else {
        await route.continue()
      }
    })
    const childTarget = page.locator(`.tree-item[data-node-id="${child.id}"]`).first()
    await page.locator(`.tree-item[data-node-id="${parent.id}"] .toggle-icon`).first().click()
    await expect(childTarget).toBeVisible({ timeout: 10000 })
    await childTarget.click()
    await expect.poll(() => normalAttempts).toBe(1)
    await waitForConnectionToast(page)
    await childTarget.click()
    await expect.poll(() => normalAttempts).toBe(2)
    await expect(page.locator('#node-title')).toHaveValue('Child', { timeout: 15000 })
    await page.unroute(parentsUrl(tree.id, child.id))

    await page.locator('button[data-view="reverse"]').click()
    const reverseTarget = page.locator(`.tree-item[data-node-id="${parent.id}"]`).first()
    await expect(reverseTarget).toBeVisible({ timeout: 10000 })

    let reverseAttempts = 0
    await page.route(parentsUrl(tree.id, parent.id), async route => {
      reverseAttempts += 1
      if (reverseAttempts === 1) {
        await route.abort('failed')
      } else {
        await route.continue()
      }
    })
    await reverseTarget.click()
    await expect.poll(() => reverseAttempts).toBe(1)
    await waitForConnectionToast(page)
    await reverseTarget.click()
    await expect.poll(() => reverseAttempts).toBe(2)
    await expect(page.locator('#node-title')).toHaveValue('Parent', { timeout: 15000 })
  })

  test('古いリクエストの失敗は後続の選択状態を巻き戻さない', async ({ page }) => {
    await login(page)
    const tree = await createTree(page, 'Reselect stale tree')
    const nodeA = await createNode(page, tree.id, 'Node A')
    const nodeB = await createNode(page, tree.id, 'Node B')
    const nodeC = await createNode(page, tree.id, 'Node C')
    await addRelation(page, tree.id, tree.root_node_id, nodeA.id)
    await addRelation(page, tree.id, tree.root_node_id, nodeB.id)
    await addRelation(page, tree.id, tree.root_node_id, nodeC.id)
    await openNode(page, tree.id, nodeA.id, 'Node A')

    let releaseFirstRequest
    let firstRequestStarted = false
    const firstRequestBlocked = new Promise(resolve => { releaseFirstRequest = resolve })
    await page.route(nodeUrl(tree.id, nodeB.id), async route => {
      firstRequestStarted = true
      await firstRequestBlocked
      await route.abort('failed')
    })

    await page.locator(`.tree-item[data-node-id="${nodeB.id}"]`).first().click()
    await expect.poll(() => firstRequestStarted).toBe(true)
    await page.locator(`.tree-item[data-node-id="${nodeC.id}"]`).first().click()
    await expect(page.locator('#node-title')).toHaveValue('Node C', { timeout: 15000 })

    releaseFirstRequest()
    await page.waitForTimeout(500)
    await expect(page.locator('#node-title')).toHaveValue('Node C')
  })
})
