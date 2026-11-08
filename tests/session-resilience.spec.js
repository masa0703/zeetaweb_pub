import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

const BASE_URL = 'http://localhost:3000'

function decodeJwtPayload(token) {
  const encoded = token.split('.')[1]
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'))
}

async function clearTestData(page) {
  await page.request.delete(`${BASE_URL}/api/test/clear`)
}

async function testLogin(page, userId = 1, sessionTtlSeconds) {
  const params = new URLSearchParams({ user_id: String(userId) })
  if (sessionTtlSeconds) params.set('session_ttl_seconds', String(sessionTtlSeconds))
  await page.goto(`${BASE_URL}/auth/test-login?${params}`)
  await waitForAppReady(page)
}

async function issueTestSession(page, userId, sessionTtlSeconds, options = {}) {
  const params = new URLSearchParams({
    user_id: String(userId),
    session_ttl_seconds: String(sessionTtlSeconds)
  })
  if (options.legacy) params.set('legacy_session', 'true')
  const response = await page.request.get(`${BASE_URL}/auth/test-login?${params}`, { maxRedirects: 0 })
  expect(response.status()).toBe(302)
}

function acceptAllDialogs(page) {
  page.on('dialog', dialog => dialog.accept())
}

async function sessionCookie(page) {
  const cookies = await page.context().cookies(BASE_URL)
  return cookies.find(cookie => cookie.name === 'session')
}

async function createEditableNode(page) {
  const treeResponse = await page.request.post(`${BASE_URL}/api/trees`, {
    data: { name: 'Session resilience tree', description: '' }
  })
  const tree = (await treeResponse.json()).data
  const nodeResponse = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes/with-parent`, {
    data: {
      title: 'Original title',
      content: 'Original content',
      author_user_id: 1,
      parent_node_id: tree.root_node_id
    }
  })
  const node = (await nodeResponse.json()).data.node
  return { tree, node }
}

test.describe('Session resilience', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-AUTH-005: refreshes a near-expiry active session', async ({ page }) => {
    await issueTestSession(page, 1, 60 * 60)
    const before = await sessionCookie(page)
    const beforePayload = decodeJwtPayload(before.value)
    expect(beforePayload.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60 * 60)

    const response = await page.request.get(`${BASE_URL}/auth/me`)
    expect(response.status()).toBe(200)

    const after = await sessionCookie(page)
    const afterPayload = decodeJwtPayload(after.value)
    expect(after.value).not.toBe(before.value)
    expect(afterPayload.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(6 * 24 * 60 * 60)
  })

  test('TC-AUTH-010: keeps parallel requests authorized while a near-expiry session rotates', async ({ page }) => {
    await issueTestSession(page, 1, 60 * 60)

    const statuses = await Promise.all([
      page.request.get(`${BASE_URL}/auth/me`).then(response => response.status()),
      page.request.get(`${BASE_URL}/api/trees`).then(response => response.status()),
      page.request.get(`${BASE_URL}/api/notifications`).then(response => response.status()),
      page.request.get(`${BASE_URL}/api/relation-types`).then(response => response.status())
    ])

    expect(statuses).toEqual([200, 200, 200, 200])
    expect((await page.request.get(`${BASE_URL}/auth/me`)).status()).toBe(200)
  })

  test('TC-AUTH-006: does not rotate a session with sufficient remaining lifetime', async ({ page }) => {
    await testLogin(page)
    const before = await sessionCookie(page)

    const response = await page.request.get(`${BASE_URL}/auth/me`)
    expect(response.status()).toBe(200)

    const after = await sessionCookie(page)
    expect(after.value).toBe(before.value)
  })

  test('TC-AUTH-007: rejects a fully expired session', async ({ page }) => {
    await issueTestSession(page, 1, 1)
    await page.waitForTimeout(1500)

    const response = await page.request.get(`${BASE_URL}/auth/me`)
    expect(response.status()).toBe(401)
  })

  test('TC-FUNC-063: restores an unsaved node draft after reauthentication', async ({ page }) => {
    await testLogin(page)
    const { tree, node } = await createEditableNode(page)
    const editorUrl = `${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`
    await page.goto(editorUrl)
    await expect(page.locator('#node-title')).toHaveValue('Original title')

    await page.fill('#node-title', 'Unsaved title')
    await page.evaluate(() => window.currentEditor.value('Unsaved content'))
    await page.evaluate(() => window.ZeetaAuth.handleUnauthorized())
    await page.waitForURL(/\/login(?:\.html)?\?redirect=/)

    await testLogin(page)
    // 再ログインで旧セッションが失効するため、直前ページの残リクエストが401になり
    // 「読み込みに失敗」アラートが下書き確認より先に出ることがある。once だと
    // 本命の confirm が自動 dismiss される
    acceptAllDialogs(page)
    await page.goto(editorUrl)

    await expect(page.locator('#node-title')).toHaveValue('Unsaved title')
    await expect.poll(() => page.evaluate(() => window.currentEditor.value())).toBe('Unsaved content')
  })

  test('TC-FUNC-064: clears the local draft after a successful save', async ({ page }) => {
    await testLogin(page)
    const { tree, node } = await createEditableNode(page)
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await expect(page.locator('#node-title')).toHaveValue('Original title')

    await page.fill('#node-title', 'Saved title')
    await page.waitForTimeout(350)
    const draftKey = `zeeta.node-draft.v1:1:${tree.id}:${node.id}`
    expect(await page.evaluate(key => localStorage.getItem(key), draftKey)).toBeTruthy()

    await page.click('#save-node-btn')
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), draftKey)).toBeNull()
  })

  test('TC-FUNC-065: routes a restored stale draft through version conflict handling', async ({ page }) => {
    await testLogin(page)
    const { tree, node } = await createEditableNode(page)
    const editorUrl = `${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`
    await page.goto(editorUrl)
    await expect(page.locator('#node-title')).toHaveValue('Original title')
    await page.fill('#node-title', 'Draft title')
    await page.evaluate(() => window.ZeetaAuth.handleUnauthorized())
    await page.waitForURL(/\/login(?:\.html)?\?redirect=/)

    await testLogin(page)
    const currentResponse = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}`)
    const current = (await currentResponse.json()).data
    const updateResponse = await page.request.put(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}`, {
      data: {
        title: 'Server title',
        content: current.content,
        author_user_id: current.author_user_id,
        version: current.version
      }
    })
    expect(updateResponse.status()).toBe(200)

    acceptAllDialogs(page)
    await page.goto(editorUrl)
    await expect(page.locator('#node-title')).toHaveValue('Draft title')
    await page.click('#save-node-btn')
    await expect(page.locator('#conflict-dialog')).toBeVisible()
  })

  test('TC-AUTH-008: ignores 401 responses from a different origin', async ({ page }) => {
    await testLogin(page)
    await page.route('https://example.test/session-probe', route => route.fulfill({
      status: 401,
      headers: { 'access-control-allow-origin': '*' },
      body: 'unauthorized'
    }))

    await page.evaluate(() => fetch('https://example.test/session-probe').catch(() => null))
    await page.waitForTimeout(1800)
    expect(new URL(page.url()).pathname).toBe('/index.html')
  })

  test('TC-AUTH-009: upgrades a near-expiry legacy session', async ({ page }) => {
    await issueTestSession(page, 1, 60 * 60, { legacy: true })
    const before = await sessionCookie(page)
    expect(decodeJwtPayload(before.value).session_id).toBeUndefined()

    const response = await page.request.get(`${BASE_URL}/auth/me`)
    expect(response.status()).toBe(200)

    const after = await sessionCookie(page)
    expect(decodeJwtPayload(after.value).session_id).toBeTruthy()
  })
})
