import { TEST_BASE_URL } from './helpers/test-environment.js'
import { test, expect } from './helpers/fixtures.js'
import { waitForAppReady } from './helpers/app.js'

const BASE_URL = TEST_BASE_URL

/** 画面に並んだ日付が降順になっていること */
async function expectDatesDescending(page) {
  const dates = await page.locator('#panel-changelog .changelog-date').allInnerTexts()
  expect(dates.length).toBeGreaterThan(0)
  expect(dates).toEqual([...dates].sort().reverse())
}

test.describe('変更履歴', () => {
  test('TC-CHANGELOG-001: ヘルプ（日本語）の変更履歴タブが日付の降順で表示される', async ({ page }) => {
    await page.goto(`${BASE_URL}/help.ja?tab=changelog`)
    await expect(page.locator('#tab-changelog')).toHaveClass(/active/)
    await expect(page.locator('#tab-changelog')).toHaveText('変更履歴')
    await expect(page.locator('#panel-changelog')).toBeVisible()
    await expect(page.locator('#panel-changelog')).toContainText('ダークモード')
    await expectDatesDescending(page)
  })

  test('TC-CHANGELOG-002: ヘルプ（英語）の変更履歴タブが英語で表示される', async ({ page }) => {
    await page.goto(`${BASE_URL}/help.en?tab=changelog`)
    await expect(page.locator('#tab-changelog')).toHaveText('Changelog')
    await expect(page.locator('#panel-changelog')).toBeVisible()
    await expect(page.locator('#panel-changelog')).toContainText('dark mode')
    await expect(page.locator('#panel-changelog')).not.toContainText('ダークモード')
    await expectDatesDescending(page)
  })

  test('TC-CHANGELOG-003: タブを押すと変更履歴に切り替わり、URL に tab=changelog が入る', async ({ page }) => {
    await page.goto(`${BASE_URL}/help.ja?tab=editor`)
    await page.locator('#tab-changelog').click()
    await expect(page.locator('#panel-changelog')).toBeVisible()
    await expect(page.locator('#panel-editor')).toBeHidden()
    expect(new URL(page.url()).searchParams.get('tab')).toBe('changelog')
  })

  test('TC-CHANGELOG-004: 設定メニューに変更履歴へのリンクがあり、新しいタブで開く', async ({ page }) => {
    await page.goto(`${BASE_URL}/auth/test-login?user_id=1`)
    await waitForAppReady(page)
    await page.locator('#settings-btn').click()
    const link = page.locator('#settings-menu #changelog-link')
    await expect(link).toBeVisible()
    await expect(link).toHaveText('変更履歴')
    await expect(link).toHaveAttribute('href', '/help?tab=changelog')
    await expect(link).toHaveAttribute('target', '_blank')
  })
})
