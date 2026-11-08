import { test, expect } from '@playwright/test'
import { testLogin, createTreeViaUi, chooseTreeMenu } from './helpers/app.js'

/**
 * ツリーアイコン（絵文字）
 * - 編集モーダルの「変更」で emoji-picker-element を開き、選んだ絵文字を保存すると左バーに出る
 * - 「なしに戻す」で先頭文字の表示に戻る
 * - PUT /api/trees/:id は絵文字1つ以外を 400 で拒否する
 */
test.describe('Tree icon', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/api/test/clear')
  })

  const railChip = (page, treeId) => page.locator(`#tree-rail-list .tree-rail-chip[data-tree-id="${treeId}"]`)

  test('search deletion keys do not trigger node deletion', async ({ page }) => {
    const dialogs = []
    page.on('dialog', async dialog => {
      dialogs.push(dialog.message())
      await dialog.dismiss()
    })
    await testLogin(page)
    await createTreeViaUi(page, 'search icon tree')
    await page.locator('.tree-item').first().click()
    await chooseTreeMenu(page, 'search icon tree', 'edit')
    await page.locator('#edit-tree-icon-change').click()
    const search = page.locator('#edit-tree-icon-picker emoji-picker input[type="search"]')
    await search.fill('abc')
    await search.press('Backspace')
    await expect(search).toHaveValue('ab')
    await search.press('Home')
    await search.press('Delete')
    await expect(search).toHaveValue('b')
    await expect(page.locator('#edit-tree-modal')).toHaveClass(/active/)
    expect(dialogs).toEqual([])
  })

  test('picks an emoji in the edit modal and shows it on the left bar, then removes it', async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') pageErrors.push(message.text())
    })

    await testLogin(page)
    const treeId = await createTreeViaUi(page, 'icon tree')
    await expect(railChip(page, treeId)).toHaveText('I')

    await chooseTreeMenu(page, 'icon tree', 'edit')
    await expect(page.locator('#edit-tree-icon-preview')).toHaveText('I')
    await expect(page.locator('#edit-tree-icon-clear')).toBeHidden()

    await page.locator('#edit-tree-icon-change').click()
    // 絵文字データは自前配信（CSP connect-src 'self'）。読み込めないと一覧が空になる
    const firstEmoji = page.locator('#edit-tree-icon-picker emoji-picker button.emoji[role="menuitem"]').first()
    await expect(firstEmoji).toBeVisible()
    await firstEmoji.click()

    await expect(page.locator('#edit-tree-icon-picker')).toBeHidden()
    const icon = await page.locator('#edit-tree-icon').inputValue()
    expect(icon).not.toBe('')
    await expect(page.locator('#edit-tree-icon-preview')).toHaveText(icon)
    await expect(page.locator('#edit-tree-icon-preview')).toHaveClass(/has-icon/)

    await page.locator('#edit-tree-form button[type="submit"]').click()
    await expect(page.locator('#edit-tree-modal')).not.toHaveClass(/active/)
    await expect(railChip(page, treeId)).toHaveText(icon)
    await expect(railChip(page, treeId)).toHaveClass(/has-icon/)

    // 再読み込みしても残る（サーバーに保存されている）
    await page.reload()
    await expect(railChip(page, treeId)).toHaveText(icon)

    await chooseTreeMenu(page, 'icon tree', 'edit')
    await expect(page.locator('#edit-tree-icon-preview')).toHaveText(icon)
    await page.locator('#edit-tree-icon-clear').click()
    await expect(page.locator('#edit-tree-icon-preview')).toHaveText('I')
    await page.locator('#edit-tree-form button[type="submit"]').click()
    await expect(page.locator('#edit-tree-modal')).not.toHaveClass(/active/)
    await expect(railChip(page, treeId)).toHaveText('I')
    await expect(railChip(page, treeId)).not.toHaveClass(/has-icon/)

    expect(pageErrors.filter(message => /Content Security Policy|emoji/i.test(message))).toEqual([])
  })

  test('API accepts a single emoji and rejects anything else', async ({ page }) => {
    await testLogin(page)
    const treeId = await createTreeViaUi(page, 'api icon tree')
    const put = (icon) => page.request.put(`/api/trees/${treeId}`, { data: { icon } })

    for (const icon of ['📚', '👨‍👩‍👧', '🇯🇵']) {
      const response = await put(icon)
      expect(response.status(), icon).toBe(200)
      expect((await response.json()).data.icon).toBe(icon)
    }

    for (const icon of ['t', '📚📚', '<b>x</b>', 123]) {
      const response = await put(icon)
      expect(response.status(), String(icon)).toBe(400)
    }

    const cleared = await put(null)
    expect(cleared.status()).toBe(200)
    expect((await cleared.json()).data.icon).toBeNull()

    // 名前・説明だけの更新ではアイコンを変えない
    await put('📚')
    const renamed = await page.request.put(`/api/trees/${treeId}`, { data: { name: 'renamed' } })
    expect((await renamed.json()).data.icon).toBe('📚')
  })

  test('picks a background color in the edit modal, then returns to auto', async ({ page }) => {
    await testLogin(page)
    const treeId = await createTreeViaUi(page, 'color tree')
    const autoColor = await railChip(page, treeId).evaluate(el => getComputedStyle(el).backgroundColor)
    // 自動の色とは違う色を選ぶ（自動色が pink なら red）
    const [pickKey, pickRgb] = autoColor === 'rgb(236, 72, 153)' ? ['red', 'rgb(239, 68, 68)'] : ['pink', 'rgb(236, 72, 153)']

    await chooseTreeMenu(page, 'color tree', 'edit')
    await expect(page.locator('#edit-tree-color-options input[value=""]')).toBeChecked()
    await page.locator(`#edit-tree-color-options input[value="${pickKey}"]`).check({ force: true })
    await expect(page.locator('#edit-tree-icon-preview')).toHaveCSS('background-color', pickRgb)

    await page.locator('#edit-tree-form button[type="submit"]').click()
    await expect(page.locator('#edit-tree-modal')).not.toHaveClass(/active/)
    await expect(railChip(page, treeId)).toHaveCSS('background-color', pickRgb)

    await page.reload()
    await expect(railChip(page, treeId)).toHaveCSS('background-color', pickRgb)

    await chooseTreeMenu(page, 'color tree', 'edit')
    await expect(page.locator(`#edit-tree-color-options input[value="${pickKey}"]`)).toBeChecked()
    await page.locator('#edit-tree-color-options input[value=""]').check({ force: true })
    await page.locator('#edit-tree-form button[type="submit"]').click()
    await expect(page.locator('#edit-tree-modal')).not.toHaveClass(/active/)
    await expect(railChip(page, treeId)).toHaveCSS('background-color', autoColor)
  })

  test('API accepts only palette color keys', async ({ page }) => {
    await testLogin(page)
    const treeId = await createTreeViaUi(page, 'api color tree')
    const put = (color) => page.request.put(`/api/trees/${treeId}`, { data: { color } })

    const ok = await put('white')
    expect(ok.status()).toBe(200)
    expect((await ok.json()).data.color).toBe('white')
    await page.reload()
    await expect(railChip(page, treeId)).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(railChip(page, treeId)).toHaveCSS('color', 'rgb(55, 65, 81)')
    await chooseTreeMenu(page, 'api color tree', 'edit')
    await expect(page.locator('#edit-tree-icon-preview')).toHaveCSS('color', 'rgb(55, 65, 81)')

    for (const color of ['teal', 'blue', '#ff0000', 'red;x', 1]) {
      expect((await put(color)).status(), String(color)).toBe(400)
    }

    const cleared = await put(null)
    expect((await cleared.json()).data.color).toBeNull()
  })
})
