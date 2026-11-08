import { test, expect } from '@playwright/test'
import { waitForAppReady, openSettingsMenu, openTreeDrawer } from './helpers/app.js'
import { createPkcePair, DEFAULT_REDIRECT_URI, mcpResourceUrl, registerClient } from './helpers/mcp-oauth.js'

const LOGIN_URL = '/auth/test-login?user_id=1'

async function loginAndWaitForApp(page) {
  await page.goto(LOGIN_URL)
  await waitForAppReady(page)
}

async function getOrCreateTreeId(page) {
  const treesResponse = await page.request.get('/api/trees')
  expect(treesResponse.ok()).toBeTruthy()
  const treesJson = await treesResponse.json()
  const trees = treesJson.data || treesJson
  if (trees.length > 0) return trees[0].id

  const createResponse = await page.request.post('/api/trees', {
    data: { name: 'theme test tree' },
  })
  expect(createResponse.ok()).toBeTruthy()
  return (await createResponse.json()).data.id
}

test.describe('Theme switcher', () => {
  test('TC-THEME-001: default is system and light OS preference keeps light UI', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await loginAndWaitForApp(page)

    await expect(page.locator('html')).not.toHaveClass(/theme-dark/)
    await expect(page.locator('#theme-switcher')).toHaveValue('system')
  })

  test('TC-THEME-002: system follows a dark OS preference', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await loginAndWaitForApp(page)

    await expect(page.locator('html')).toHaveClass(/theme-dark/)
    await expect(page.locator('#theme-switcher')).toHaveValue('system')
  })

  test('TC-THEME-003: selecting dark applies immediately and persists across reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await loginAndWaitForApp(page)

    await openSettingsMenu(page)
    await page.locator('#theme-switcher').selectOption('dark')
    await expect(page.locator('html')).toHaveClass(/theme-dark/)

    const stored = await page.evaluate(() => localStorage.getItem('zeeta-theme'))
    expect(stored).toBe('dark')

    await page.reload()
    await waitForAppReady(page)
    await expect(page.locator('html')).toHaveClass(/theme-dark/)
    await expect(page.locator('#theme-switcher')).toHaveValue('dark')
  })

  test('TC-THEME-004: explicit light overrides a dark OS preference', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await loginAndWaitForApp(page)

    await openSettingsMenu(page)
    await page.locator('#theme-switcher').selectOption('light')
    await expect(page.locator('html')).not.toHaveClass(/theme-dark/)

    await page.reload()
    await waitForAppReady(page)
    await expect(page.locator('html')).not.toHaveClass(/theme-dark/)
  })

  test('TC-THEME-005: system mode reacts to an OS preference change at runtime', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await loginAndWaitForApp(page)

    await expect(page.locator('html')).not.toHaveClass(/theme-dark/)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveClass(/theme-dark/)
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).not.toHaveClass(/theme-dark/)
  })

  test('TC-THEME-006: the settings menu lists the theme switcher above the language switcher', async ({ page }) => {
    await loginAndWaitForApp(page)
    await openSettingsMenu(page)

    const themeBox = await page.locator('#theme-switcher').boundingBox()
    const langBox = await page.locator('#lang-switcher').boundingBox()
    expect(themeBox).toBeTruthy()
    expect(langBox).toBeTruthy()
    expect(themeBox.y + themeBox.height).toBeLessThanOrEqual(langBox.y + 1)
  })

  test('TC-THEME-007: dark styling is actually applied to the left bar surfaces', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await loginAndWaitForApp(page)
    await openSettingsMenu(page)
    await page.locator('#theme-switcher').selectOption('dark')

    const headerBackground = await page.locator('#tree-header').evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(headerBackground).toBe('rgb(17, 24, 39)')
    await openTreeDrawer(page)
    await expect(page.locator('#tree-drawer')).toHaveCSS('background-color', 'rgb(31, 41, 55)')
  })

  test('TC-THEME-008: saved dark theme carries over to the editor screen', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('zeeta-theme', 'dark'))
    await loginAndWaitForApp(page)
    await expect(page.locator('html')).toHaveClass(/theme-dark/)

    const treeId = await getOrCreateTreeId(page)
    await page.goto(`/?tree=${treeId}`)
    await page.locator('#tree-header').waitFor({ state: 'visible', timeout: 15000 })
    await expect(page.locator('html')).toHaveClass(/theme-dark/)

    const headerBackground = await page.locator('#tree-header').evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(headerBackground).toBe('rgb(17, 24, 39)')

    await page.evaluate(() => {
      const preview = document.createElement('div')
      preview.className = 'bytemd-preview'
      preview.innerHTML = '<div class="markdown-body">'
        + '<table><tbody><tr><td id="theme-table-cell">表セル</td></tr></tbody></table>'
        + '<pre><code id="theme-code-block">const x = 1</code></pre>'
        + '</div>'
      document.body.appendChild(preview)
    })
    const tableCell = page.locator('#theme-table-cell')
    await expect(tableCell).toHaveCSS('background-color', 'rgb(13, 17, 23)')
    const codeBlock = page.locator('#theme-code-block')
    await expect(codeBlock).toHaveCSS('color', 'rgb(230, 237, 243)')
    await page.locator('html').evaluate((element) => element.classList.remove('theme-dark'))
    await expect(tableCell).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(codeBlock).not.toHaveCSS('color', 'rgb(230, 237, 243)')
  })

  test('TC-THEME-009: saved dark theme carries over to the profile screen', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('zeeta-theme', 'dark'))
    await loginAndWaitForApp(page)

    await page.goto('/profile')
    await page.locator('h1, h2').first().waitFor({ state: 'visible', timeout: 15000 })
    await expect(page.locator('html')).toHaveClass(/theme-dark/)
    await expect(page.locator('.profile-card')).toHaveCSS('background-color', 'rgb(31, 41, 55)')
  })

  test('TC-THEME-010: dark theme is present on every remaining target screen', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('zeeta-theme', 'dark'))
    await page.context().clearCookies()
    await page.goto('/login')
    await expect(page.locator('html')).toHaveClass(/theme-dark/)
    await expect(page.locator('link[href="/static/dark.css"]')).toHaveCount(1)
    await expect(page.locator('.login-card')).toHaveCSS('background-color', 'rgb(31, 41, 55)')

    await loginAndWaitForApp(page)
    const themedScreens = [
      ['/accept-invitation?token=invalid-theme-test-token', '.container'],
      ['/help.ja', '.help-card'],
      ['/help.en', '.help-card'],
      ['/mermaid-viewer', '#viewer-toolbar'],
      ['/html-viewer', '#viewer-toolbar'],
      ['/image-viewer', '#viewer-toolbar'],
    ]
    for (const [path, surface] of themedScreens) {
      await page.goto(path)
      await expect(page.locator('html'), path).toHaveClass(/theme-dark/)
      await expect(page.locator('link[href="/static/dark.css"]'), path).toHaveCount(1)
      await expect(page.locator(surface).first(), path).toHaveCSS('background-color', 'rgb(31, 41, 55)')
    }

    await page.goto('/oauth/authorize')
    await expect(page.locator('html')).toHaveClass(/theme-dark/)
    await expect(page.locator('link[href="/static/dark.css"]')).toHaveCount(1)
    await expect(page.locator('.card')).toHaveCSS('background-color', 'rgb(31, 41, 55)')

    const treeId = await getOrCreateTreeId(page)
    const { body: client } = await registerClient(page)
    const { codeChallenge } = createPkcePair()
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: DEFAULT_REDIRECT_URI,
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      resource: mcpResourceUrl(treeId),
      scope: 'mcp:read',
    })
    const consentResponse = await page.goto(`/oauth/authorize?${query}`)
    expect(consentResponse.status()).toBe(200)
    await expect(page.locator('html')).toHaveClass(/theme-dark/)
    await expect(page.locator('link[href="/static/dark.css"]')).toHaveCount(1)
    await expect(page.locator('.card')).toHaveCSS('background-color', 'rgb(31, 41, 55)')
    expect(consentResponse.headers()['content-security-policy']).toContain("script-src 'self'")
  })
})
