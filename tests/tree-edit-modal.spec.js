import { test, expect } from '@playwright/test'
import { waitForAppReady, chooseTreeMenu } from './helpers/app.js'

/**
 * ツリー編集モーダルで説明を更新・クリアできること。
 * - 見出しは i18n キー mypage.editTreeName（「ツリーを編集」）
 * - 空欄で保存すると description: null が送られ、説明がクリアされる
 * サーバーは PUT /api/trees/:id で description / null に対応済みのため、
 * ここでは route モックで画面と送信ボディのみを検証する。
 */
test.describe('Tree edit modal description (left bar)', () => {
  const ownerTree = {
    id: 7,
    name: 'Owned tree',
    description: '既存の説明',
    role: 'owner',
    member_count: 1,
    node_count: 0
  }

  async function setupPage(page) {
    await page.route('**/auth/me', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { id: 1, display_name: 'Owner', email: 'owner@example.com' }
      })
    }))
    await page.route('**/api/trees', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [ownerTree] })
    }))
    await page.route('**/api/notifications**', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] })
    }))

    const putBodies = []
    await page.route('**/api/trees/7', route => {
      if (route.request().method() === 'PUT') {
        putBodies.push(route.request().postDataJSON())
      }
      // 編集画面の起動時の GET /api/trees/7 にも同じツリーを返す
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { ...ownerTree } })
      })
    })

    await page.goto('/index.html?tree=7')
    await waitForAppReady(page)
    return putBodies
  }

  function openEditModal(page) {
    return chooseTreeMenu(page, 'Owned tree', 'edit')
  }

  test('shows the tree edit heading and prefills the description', async ({ page }) => {
    await setupPage(page)

    await openEditModal(page)

    await expect(page.locator('#edit-tree-modal h3')).toHaveText('ツリーを編集')
    await expect(page.locator('#edit-tree-name')).toHaveValue('Owned tree')
    await expect(page.locator('#edit-tree-description')).toHaveValue('既存の説明')
    await expect(page.locator('#edit-tree-description')).toHaveAttribute('maxlength', '500')
  })

  test('saves an updated description together with the tree name', async ({ page }) => {
    const putBodies = await setupPage(page)

    await openEditModal(page)
    await page.locator('#edit-tree-description').fill('更新後の説明')
    await page.locator('#edit-tree-form button[type="submit"]').click()

    await expect(page.locator('#edit-tree-modal')).not.toHaveClass(/active/)
    expect(putBodies).toHaveLength(1)
    expect(putBodies[0]).toEqual({ name: 'Owned tree', description: '更新後の説明', icon: null, color: null })
  })

  test('sends null to clear the description when the field is empty', async ({ page }) => {
    const putBodies = await setupPage(page)

    await openEditModal(page)
    await page.locator('#edit-tree-description').fill('')
    await page.locator('#edit-tree-form button[type="submit"]').click()

    await expect(page.locator('#edit-tree-modal')).not.toHaveClass(/active/)
    expect(putBodies).toHaveLength(1)
    expect(putBodies[0]).toEqual({ name: 'Owned tree', description: null, icon: null, color: null })
  })
})
