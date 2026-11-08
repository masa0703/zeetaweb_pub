import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

const BASE_URL = 'http://localhost:3000'

async function login(page, userId) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
}

async function issueTestSession(page, userId, sessionTtlSeconds) {
  const params = new URLSearchParams({
    user_id: String(userId),
    session_ttl_seconds: String(sessionTtlSeconds)
  })
  const response = await page.request.get(`${BASE_URL}/auth/test-login?${params}`, { maxRedirects: 0 })
  expect(response.status()).toBe(302)
}

async function createTree(page, name) {
  const response = await page.request.post(`${BASE_URL}/api/trees`, { data: { name } })
  expect(response.ok()).toBe(true)
  return (await response.json()).data
}

async function createNode(page, treeId, rootId, title) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes`, {
    data: { title, content: '', author_user_id: 1 }
  })
  expect(response.ok()).toBe(true)
  const node = (await response.json()).data
  const relation = await page.request.post(`${BASE_URL}/api/trees/${treeId}/relations`, {
    data: { parent_node_id: rootId, child_node_id: node.id }
  })
  expect(relation.ok()).toBe(true)
  return node
}

function connectionLostToasts(page) {
  return page.locator('.toast-message', { hasText: '通信に失敗しました' })
}

test.describe('通信断（レスポンスなしの失敗）の検知 - axios', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.delete(`${BASE_URL}/api/test/clear`)
  })

  test('ノード取得がネットワークエラーで失敗すると、無反応にならずトーストが出る', async ({ page }) => {
    await login(page, 1)
    const tree = await createTree(page, 'Connection lost tree')
    const nodeA = await createNode(page, tree.id, tree.root_node_id, 'Node A')
    const nodeB = await createNode(page, tree.id, tree.root_node_id, 'Node B')

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${nodeA.id}`)
    await page.waitForSelector('#node-title', { timeout: 15000 })
    await expect(page.locator('#node-title')).toHaveValue('Node A', { timeout: 15000 })

    // Cloudflare Access のセッション切れ（別オリジンへの302）を、ブラウザが読めない
    // ネットワークエラーとして再現する。Access はローカルには無いため abort で代用する
    await page.route(`${BASE_URL}/api/trees/${tree.id}/nodes/${nodeB.id}`, (route) => route.abort('failed'))

    await page.locator(`.tree-item[data-node-id="${nodeB.id}"]`).click()

    await expect(connectionLostToasts(page).last()).toBeVisible({ timeout: 10000 })

    // 自動でログイン画面等へ遷移しない（原因を断定できないため）
    await page.waitForTimeout(2000)
    expect(page.url()).toContain(`node=${nodeA.id}`)
    // 表示中のノードも切り替わっていない（無反応ではなく、失敗を保ったまま元の状態を維持）
    await expect(page.locator('#node-title')).toHaveValue('Node A')
  })

  test('通信が回復した後に再度失敗すると、再びトーストが出る', async ({ page }) => {
    await login(page, 1)
    const tree = await createTree(page, 'Connection lost recovery tree')
    const nodeA = await createNode(page, tree.id, tree.root_node_id, 'Node A')
    const nodeB = await createNode(page, tree.id, tree.root_node_id, 'Node B')
    const nodeC = await createNode(page, tree.id, tree.root_node_id, 'Node C')

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${nodeA.id}`)
    await page.waitForSelector('#node-title', { timeout: 15000 })

    // 1回目の失敗
    await page.route(`${BASE_URL}/api/trees/${tree.id}/nodes/${nodeB.id}`, (route) => route.abort('failed'))
    await page.locator(`.tree-item[data-node-id="${nodeB.id}"]`).click()
    await expect(connectionLostToasts(page).last()).toBeVisible({ timeout: 10000 })
    await page.unroute(`${BASE_URL}/api/trees/${tree.id}/nodes/${nodeB.id}`)

    // 通信の回復（成功した認証API）で connectionLostNotified フラグが解除される。
    // 失敗後は選択状態が元のNode Aへ復元されるため、Node Aの再クリックは
    // 重複クリックガードでリクエストを発生させない。
    await page.evaluate(() => window.axios.get('/auth/me'))

    // 2回目の失敗（別ノード）。フラグが一度きりの抑制なら出ないはずのトーストが、再び出る
    await page.route(`${BASE_URL}/api/trees/${tree.id}/nodes/${nodeC.id}`, (route) => route.abort('failed'))
    const firstToast = connectionLostToasts(page).last()
    if (await firstToast.count()) {
      await firstToast.locator('..').locator('.toast-close').click()
    }
    await expect(connectionLostToasts(page)).toHaveCount(0)
    await page.locator(`.tree-item[data-node-id="${nodeC.id}"]`).click()
    await expect(connectionLostToasts(page).last()).toBeVisible({ timeout: 10000 })
  })

  test('リクエストが自前でキャンセルされた場合は通信断として通知しない（axios）', async ({ page }) => {
    await login(page, 1)
    const tree = await createTree(page, 'Connection lost cancel tree')
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${tree.root_node_id}`)
    await page.waitForSelector('#node-title', { timeout: 15000 })

    await page.evaluate(async () => {
      const controller = new AbortController()
      const request = window.axios.get('/api/trees', { signal: controller.signal }).catch(() => null)
      controller.abort()
      await request
    })

    await page.waitForTimeout(500)
    await expect(connectionLostToasts(page)).toHaveCount(0)
  })
})

test.describe('通信断（レスポンスなしの失敗）の検知 - fetch', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.delete(`${BASE_URL}/api/test/clear`)
  })

  test('fetch() の reject 経路でも通知される（showToast が使えないときはDOM通知にフォールバック）', async ({ page }) => {
    await login(page, 1)
    await page.goto(`${BASE_URL}/index.html`)
    await waitForAppReady(page)

    // auth-session.js を読むのは編集画面だけになったため、showToast を外してフォールバック経路を確認する
    await page.evaluate(() => { window.showToast = undefined })

    await page.route(`${BASE_URL}/api/definitely-not-a-real-endpoint`, (route) => route.abort('failed'))
    await page.evaluate(() => fetch('/api/definitely-not-a-real-endpoint').catch(() => null))

    await expect(page.getByText('通信に失敗しました。ページを再読み込みしてください。')).toBeVisible({ timeout: 10000 })
  })

  test('リクエストが自前でキャンセルされた場合は通信断として通知しない（fetch）', async ({ page }) => {
    await login(page, 1)
    await page.goto(`${BASE_URL}/index.html`)
    await waitForAppReady(page)

    await page.evaluate(async () => {
      const controller = new AbortController()
      const request = fetch('/api/trees', { signal: controller.signal }).catch(() => null)
      controller.abort()
      await request
    })

    await page.waitForTimeout(500)
    await expect(page.getByText('通信に失敗しました。ページを再読み込みしてください。')).toHaveCount(0)
  })
})

test.describe('既存の401確定パス・対象範囲の回帰確認', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.delete(`${BASE_URL}/api/test/clear`)
  })

  test('同一オリジンの本物の401は、これまでどおりログイン画面へ自動遷移する', async ({ page }) => {
    await login(page, 1)
    await issueTestSession(page, 1, 1)
    await page.waitForTimeout(1500)

    await page.evaluate(() => { fetch('/api/trees').catch(() => {}) })

    await page.waitForURL(/\/login(?:\.html)?\?redirect=/, { timeout: 5000 })
  })

  test('外部オリジンへの通信失敗では通知しない', async ({ page }) => {
    await login(page, 1)
    await page.route('https://example.test/network-probe', (route) => route.abort('failed'))

    await page.evaluate(() => fetch('https://example.test/network-probe').catch(() => null))

    await page.waitForTimeout(1000)
    await expect(connectionLostToasts(page)).toHaveCount(0)
  })
})
