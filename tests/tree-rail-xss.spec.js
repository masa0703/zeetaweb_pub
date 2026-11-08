import { test, expect } from '@playwright/test'
import { waitForAppReady, openTreeDrawer, drawerRow, chooseTreeMenu, testLogin, openTreeEditor } from './helpers/app.js'

test.describe('Left bar tree list XSS hardening', () => {
  test('renders a shared-tree owner display name as inert text', async ({ page }) => {
    const ownerPayload = '<img src=x onerror="window.__ownerNameXss = true">'

    await page.addInitScript(() => {
      window.__ownerNameXss = false
    })
    await page.route('**/auth/me', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { id: 2, display_name: 'Viewer', email: 'viewer@example.com' }
      })
    }))
    await page.route('**/api/trees', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [{
          id: 42,
          name: 'Shared tree',
          description: 'Shared safely',
          role: 'viewer',
          owner_display_name: ownerPayload,
          member_count: 2,
          node_count: 1
        }]
      })
    }))
    await page.route('**/api/notifications**', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] })
    }))

    await page.goto('/index.html?tree=42')
    await waitForAppReady(page)

    // オーナー名は ⋯ メニューと行のツールチップに出る。どちらも文字列として扱われること
    await openTreeDrawer(page)
    const sharedRow = drawerRow(page, 'Shared tree')
    await expect(sharedRow).toBeVisible()
    await sharedRow.locator('.tree-drawer-more').click()
    await expect(sharedRow.locator('.tree-drawer-menu')).toContainText(ownerPayload)
    await expect(sharedRow.locator('.tree-drawer-open')).toHaveAttribute('title', new RegExp(ownerPayload.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    await expect(page.locator('#tree-drawer img, #tree-rail img')).toHaveCount(0)
    await expect(page.locator('#tree-drawer [onclick], #tree-rail [onclick]')).toHaveCount(0)
    expect(await page.evaluate(() => window.__ownerNameXss)).toBe(false)
  })

  test('passes an owner tree name to card actions without an inline handler', async ({ page }) => {
    const treeName = `Owner's tree \\'); window.__treeNameXss = true; //`

    await page.addInitScript(() => {
      window.__treeNameXss = false
    })
    await page.route('**/auth/me', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { id: 1, display_name: 'Owner', email: 'owner@example.com' }
      })
    }))
    await page.route('**/api/trees', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [{
          id: 7,
          name: treeName,
          description: '',
          role: 'owner',
          member_count: 1,
          node_count: 0
        }]
      })
    }))
    await page.route('**/api/notifications**', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] })
    }))

    await page.goto('/index.html?tree=7')
    await waitForAppReady(page)

    await expect(page.locator('#tree-drawer [onclick], #tree-rail [onclick]')).toHaveCount(0)
    await chooseTreeMenu(page, treeName, 'edit')
    await expect(page.locator('#edit-tree-name')).toHaveValue(treeName)
    expect(await page.evaluate(() => window.__treeNameXss)).toBe(false)
  })

  test('renders a member display name containing quotes as inert text in the member modal attributes', async ({ page, browser }) => {
    // メンバーは自分の表示名を自由に変えられる。引用符で属性を閉じて
    // イベントハンドラを書き足されると、メンバー管理を開いたオーナーの権限で実行されてしまう
    const payload = 'x" data-injected="1" onmouseover="window.__memberNameXss = true'

    await page.request.delete('/api/test/clear')
    await testLogin(page, 1)
    const created = await page.request.post('/api/trees', { data: { name: 'Member XSS Tree' } })
    const tree = (await created.json()).data
    const invite = await page.request.post(`/api/trees/${tree.id}/invitations`, {
      data: { email: 'test-user-2@example.com', role: 'editor' }
    })
    const token = (await invite.json()).data.token

    const memberPage = await browser.newPage()
    await testLogin(memberPage, 2)
    expect((await memberPage.request.post(`/api/invitations/${token}/accept`, { data: {} })).status()).toBe(200)
    expect((await memberPage.request.put('/api/profile', { data: { display_name: payload } })).status()).toBe(200)
    await memberPage.close()

    await page.addInitScript(() => { window.__memberNameXss = false })
    await openTreeEditor(page, tree.id)
    await chooseTreeMenu(page, 'Member XSS Tree', 'members')
    await expect(page.locator('#member-modal.active')).toBeVisible()

    const memberSelect = page.locator('#members-list select')
    await expect(memberSelect).toHaveCount(1)
    await expect(memberSelect).toHaveAttribute('aria-label', /x" data-injected="1"/)
    await expect(page.locator('#members-list [data-injected]')).toHaveCount(0)
    await memberSelect.hover()
    expect(await page.evaluate(() => window.__memberNameXss)).toBe(false)
  })
})
