import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

const BASE_URL = 'http://localhost:3000'

async function login(page) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=1`, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
}

async function createChild(page, treeId, title, parentNodeId) {
  const res = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes/with-parent`, {
    data: { title, content: '', author_user_id: 1, parent_node_id: parentNodeId }
  })
  expect(res.status()).toBe(201)
  return (await res.json()).data.node
}

// ルート直下に X（子 A）と Y を作り、A を選んだ状態で開く
async function openTreeWithSelection(page) {
  const treeRes = await page.request.post(`${BASE_URL}/api/trees`, { data: { name: 'Profile modal', description: '' } })
  const tree = (await treeRes.json()).data
  const rootId = String((await (await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes`)).json()).root_node_id)
  const x = await createChild(page, tree.id, 'X', rootId)
  const a = await createChild(page, tree.id, 'A', x.id)
  await createChild(page, tree.id, 'Y', rootId)
  await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${a.id}`)
  await expect(page.locator('#node-title')).toHaveValue('A', { timeout: 15000 })
  // ページが再読み込みされたら消える目印
  await page.evaluate(() => { window.__profileModalMarker = 'kept' })
  return { tree, x, a }
}

async function openProfileModal(page) {
  await page.locator('#settings-btn').click()
  await page.locator('#profile-link').click()
  await expect(page.locator('#profile-modal')).toHaveClass(/(^|\s)active(\s|$)/)
  await expect(page.locator('#profile-modal-display-name')).not.toHaveValue('')
}

async function expectTreeStateKept(page, { x, a }, url) {
  await expect(page.locator('#profile-modal')).not.toHaveClass(/(^|\s)active(\s|$)/)
  expect(page.url()).toBe(url)
  expect(await page.evaluate(() => window.__profileModalMarker)).toBe('kept')
  await expect(page.locator('#node-title')).toHaveValue('A')
  await expect(page.locator(`.tree-item[data-node-path="${x.id}-${a.id}"]`)).toHaveClass(/(^|\s)active(\s|$)/)
}

test.describe('プロフィール設定のモーダル', () => {
  let created = null

  test.beforeEach(async ({ page }) => {
    await login(page)
    created = await openTreeWithSelection(page)
  })

  test.afterEach(async ({ page }) => {
    if (created) await page.request.delete(`${BASE_URL}/api/trees/${created.tree.id}`)
    created = null
  })

  test('TC-PROFILE-002: 開いて閉じてもページ遷移・再読み込みをせず、ツリーの状態が変わらない', async ({ page }) => {
    const url = page.url()
    const profile = (await (await page.request.get(`${BASE_URL}/api/profile`)).json()).data

    await openProfileModal(page)
    expect(page.url()).toBe(url)
    await expect(page.locator('#profile-modal-email')).toHaveValue(profile.email)
    await expect(page.locator('#profile-modal-display-name')).toHaveValue(profile.display_name)
    await page.locator('#profile-modal-cancel').click()
    await expectTreeStateKept(page, created, url)

    await openProfileModal(page)
    await page.keyboard.press('Escape')
    await expectTreeStateKept(page, created, url)

    await openProfileModal(page)
    await page.locator('#profile-modal').click({ position: { x: 5, y: 5 } })
    await expectTreeStateKept(page, created, url)
  })

  test('TC-PROFILE-003: 表示名を保存すると反映され、ページは再読み込みされない', async ({ page }) => {
    const url = page.url()
    const before = (await (await page.request.get(`${BASE_URL}/api/profile`)).json()).data.display_name
    try {
      await openProfileModal(page)
      await page.locator('#profile-modal-display-name').fill('Modal Updated Name')
      await page.locator('#profile-modal-save').click()
      await expectTreeStateKept(page, created, url)
      const after = (await (await page.request.get(`${BASE_URL}/api/profile`)).json()).data.display_name
      expect(after).toBe('Modal Updated Name')
    } finally {
      await page.request.put(`${BASE_URL}/api/profile`, { data: { display_name: before } })
    }
  })
})
