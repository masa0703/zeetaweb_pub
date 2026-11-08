import { test, expect } from '@playwright/test'
import { waitForAppReady, openTreeDrawer, openSettingsMenu } from './helpers/app.js'

const LOGIN_URL = '/auth/test-login?user_id=1'

// ログイン後、左バーを開いて「新しいツリー」ボタンが指定言語で出るのを確かめる
async function loginAndOpenTreeList(page, newTreeLabel) {
  await page.goto(LOGIN_URL)
  await waitForAppReady(page)
  await openTreeDrawer(page)
  await expect(page.locator('#tree-drawer-create-btn')).toHaveText(newTreeLabel)
}

async function getOrCreateTreeId(page) {
  const treesResponse = await page.request.get('/api/trees')
  expect(treesResponse.ok()).toBeTruthy()
  const treesJson = await treesResponse.json()
  const trees = treesJson.data || treesJson
  if (trees.length > 0) return trees[0].id

  const createResponse = await page.request.post('/api/trees', {
    data: { name: 'i18n test tree' },
  })
  expect(createResponse.ok()).toBeTruthy()
  return (await createResponse.json()).data.id
}

function collectMissingTranslationWarnings(page) {
  const warnings = []
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().includes('[ZeetaI18n] Missing translation')) {
      warnings.push(message.text())
    }
  })
  return warnings
}

test.describe('English locale', () => {
  test.use({ locale: 'en-US' })

  test('TC-I18N-001: browser locale selects English', async ({ page }) => {
    await loginAndOpenTreeList(page, 'New tree')

    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.locator('#tree-rail-create-btn')).toHaveAttribute('aria-label', 'Create a new tree')
    await expect(page.locator('#app-menu-btn')).toHaveAttribute('aria-label', 'Menu')
  })

  test('TC-I18N-005: language cookie takes precedence over browser locale', async ({ context, page }) => {
    await context.addCookies([{
      name: 'lang',
      value: 'ja',
      domain: 'localhost',
      path: '/',
    }])

    await loginAndOpenTreeList(page, '新しいツリー')
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja')
  })

  test('TC-I18N-006: formatDate uses the English locale format', async ({ page }) => {
    await loginAndOpenTreeList(page, 'New tree')
    const treeId = await getOrCreateTreeId(page)
    await page.goto(`/?tree=${treeId}`)
    await page.waitForSelector('.tree-item[data-node-id]', { timeout: 15000 })

    const formatted = await page.evaluate(() => formatDate('2026-09-09T00:00:00Z'))
    expect(formatted).toMatch(/^09\/09\/2026,/)
  })

  test('TC-I18N-007: translated screens expose neither missing warnings nor raw keys', async ({ page }) => {
    const warnings = collectMissingTranslationWarnings(page)
    const rawKeyPattern = /\b(?:editor|mypage|common)\.[A-Za-z][A-Za-z0-9.]*/

    await loginAndOpenTreeList(page, 'New tree')
    expect(await page.locator('body').innerText()).not.toMatch(rawKeyPattern)

    const treeId = await getOrCreateTreeId(page)
    await page.goto(`/?tree=${treeId}`)
    await page.waitForSelector('.tree-item[data-node-id]', { timeout: 15000 })
    expect(await page.locator('body').innerText()).not.toMatch(rawKeyPattern)
    expect(warnings, warnings.join('\n')).toEqual([])
  })
})

test.describe('Japanese locale', () => {
  test.use({ locale: 'ja-JP' })

  test('TC-I18N-002: Japanese browser locale keeps Japanese', async ({ page }) => {
    await loginAndOpenTreeList(page, '新しいツリー')

    await expect(page.locator('html')).toHaveAttribute('lang', 'ja')
  })

  test('TC-I18N-004: language selector persists the cookie across screens', async ({ page }) => {
    await loginAndOpenTreeList(page, '新しいツリー')
    await page.keyboard.press('Escape')
    await openSettingsMenu(page)
    await page.locator('#lang-switcher').selectOption('en')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: 15000 })
    await waitForAppReady(page)

    await page.reload()
    await waitForAppReady(page)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await openTreeDrawer(page)
    await expect(page.locator('#tree-drawer-create-btn')).toHaveText('New tree')

    await page.goto('/profile')
    await expect(page.getByRole('heading', { name: 'Profile Settings' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })

  test('TC-I18N-008: help language links preserve the selected tab in both directions', async ({ page }) => {
    await page.goto('/help?tab=mcp')
    await expect(page.getByRole('heading', { name: 'MCP / API 連携ヘルプ' })).toBeVisible()

    await page.locator('#language-switch').click()
    await expect(page).toHaveURL(/\/help\.en\?tab=mcp$/)
    await expect(page.getByRole('heading', { name: 'MCP / API Integration Help' })).toBeVisible()

    await page.locator('#language-switch').click()
    await expect(page).toHaveURL(/\/help\.ja\?tab=mcp$/)
    await expect(page.getByRole('heading', { name: 'MCP / API 連携ヘルプ' })).toBeVisible()
  })
})

test.describe('Unsupported locale', () => {
  test.use({ locale: 'fr-FR' })

  test('TC-I18N-003: non-Japanese browser locale falls back to English', async ({ page }) => {
    await loginAndOpenTreeList(page, 'New tree')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })
})
