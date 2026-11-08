import { test, expect } from '@playwright/test'
import { waitForAppReady, openSettingsMenu } from './helpers/app.js'

const BASE_URL = 'http://localhost:3000'

async function login(page) {
  await page.context().clearCookies()
  await page.goto(`${BASE_URL}/auth/test-login?user_id=1`)
  await waitForAppReady(page)
}

test('設定メニューにビルド日時(MMDD-HHMM)が出る', async ({ page }) => {
  await login(page)

  await openSettingsMenu(page)
  const badge = page.locator('#settings-menu #version-badge')
  await expect(badge).toBeVisible()
  await expect(badge).toHaveText(/^\d{4}-\d{4}$/)
})

test('ビルド日時プレースホルダがHTMLに残っていない', async ({ request }) => {
  const response = await request.get(`${BASE_URL}/index.html`)
  expect(response.ok()).toBeTruthy()
  const html = await response.text()
  expect(html).not.toContain('{{BUILD_STAMP}}')
})

test('GET /api/version はビルド日時とno-storeを返す', async ({ request }) => {
  const response = await request.get(`${BASE_URL}/api/version`)
  expect(response.ok()).toBeTruthy()
  expect(response.headers()['cache-control']).toContain('no-store')
  const body = await response.json()
  expect(body.build).toMatch(/^\d{4}-\d{4}$/)
})
