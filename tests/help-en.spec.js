import { test, expect } from '@playwright/test'

const url = 'http://localhost:3000/help.en?tab=editor'

test('TC-HELP-EN-001: 画面画像と操作説明の番号リンク', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(url)
  await expect(page.locator('#panel-editor')).toBeVisible()
  for (const id of ['shot-editor', 'shot-search', 'shot-detail']) {
    const figure = page.locator(`#${id}`)
    await figure.scrollIntoViewIfNeeded()
    await expect.poll(() => figure.locator('img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true)
    await expect(figure.locator('.shot-marker').first()).toBeVisible()
  }
  const links = page.locator('#panel-editor .flow-list a[href^="#shot-"]')
  for (let i = 0; i < await links.count(); i++) {
    const link = links.nth(i)
    const target = await link.getAttribute('href')
    await link.click()
    await expect(page.locator(target)).toBeInViewport()
  }
  await expect(page.getByRole('heading', { name: '3) Searching for Nodes', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '4) Sorting Nodes', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '8) Node History Navigation', exact: true })).toBeVisible()
  await page.locator('#shot-editor').scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'tests/test-results/help-en-desktop.png' })
  await page.locator('#shot-search').screenshot({ path: 'tests/test-results/help-en-search.png' })
  await page.locator('#shot-detail').screenshot({ path: 'tests/test-results/help-en-detail.png' })
})

test('TC-HELP-EN-002: スマホ幅で画像内スクロールとタブ切り替え', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(url)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const scroller = page.locator('#shot-editor .shot-scroll')
  await scroller.scrollIntoViewIfNeeded()
  expect(await scroller.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
  await scroller.focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(0)
  await page.screenshot({ path: 'tests/test-results/help-en-mobile.png' })
  for (const tab of ['trees', 'mcp', 'editor']) {
    await page.locator(`#tab-${tab}`).click()
    await expect(page.locator(`#panel-${tab}`)).toBeVisible()
  }
})

test('TC-HELP-EN-003: 旧マイページタブへのリンク（?tab=my-page）は「ツリーの管理」タブを開く', async ({ page }) => {
  await page.goto('http://localhost:3000/help.en?tab=my-page')
  await expect(page.locator('#panel-trees')).toBeVisible()
  await expect(page.locator('#tab-trees')).toHaveClass(/active/)
})
