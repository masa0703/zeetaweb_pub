import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

const BASE_URL = 'http://localhost:3000'

test.describe('利用規約とプライバシーポリシー', () => {
  test('terms tab shows both policies and privacy anchor', async ({ page }) => {
    await page.goto(`${BASE_URL}/help.ja?tab=terms`)
    await expect(page.locator('#tab-terms')).toHaveClass(/active/)
    await expect(page.locator('#terms')).toContainText('利用規約')
    await expect(page.locator('#privacy')).toContainText('プライバシーポリシー')

    await page.goto(`${BASE_URL}/help.ja?tab=terms#privacy`)
    await expect(page.locator('#tab-terms')).toHaveClass(/active/)
    await expect(page.locator('#privacy')).toBeVisible()
  })

  test('short policy URLs redirect to terms tab', async ({ request }) => {
    for (const path of ['/terms', '/privacy']) {
      const response = await request.get(`${BASE_URL}${path}`, { maxRedirects: 0 })
      expect(response.status()).toBe(302)
      expect(response.headers().location).toContain('/help?tab=terms')
    }
  })

  test('login page exposes policy links', async ({ page }) => {
    await page.goto(`${BASE_URL}/login.html`)
    await expect(page.locator('a[href="/terms"]')).toBeVisible()
    await expect(page.locator('a[href="/privacy"]')).toBeVisible()
  })

  test('settings menu exposes policy link', async ({ page }) => {
    await page.goto(`${BASE_URL}/auth/test-login?user_id=1`)
    await page.locator('#settings-btn').click()
    await expect(page.locator('#settings-menu a[href="/help?tab=terms"]')).toBeVisible()
  })
  test('login policy sentence is fully localized in English', async ({ page, context }) => {
    await context.addCookies([{ name: 'lang', value: 'en', url: BASE_URL }])
    await page.goto(`${BASE_URL}/login.html`)
    await expect(page.locator('a[href="/terms"]').locator('..')).toHaveText('By logging in, you agree to the Terms of Use and Privacy Policy.')
  })
  test('sample tree notice uses real line breaks and only the new terms', async () => {
    const raw = readFileSync(new URL('../src/data/hello-template.json', import.meta.url), 'utf8')
    const text = JSON.stringify(JSON.parse(raw))
    expect(text).not.toContain('\\\\n')
    expect(text).toContain('https://zeetaweb.jp/terms')
    expect(text).not.toContain('運営者は責任を負いません')
    expect(text).not.toContain('The operator accepts no liability')
  })
  test('privacy policy does not expose a contact email or a deletion section', async ({ page }) => {
    for (const path of ['/help.ja?tab=terms', '/help.en?tab=terms']) {
      await page.goto(`${BASE_URL}${path}`)
      const text = await page.locator('#privacy').innerText()
      expect(text).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i)
      expect(text).not.toContain('保存期間と削除')
      expect(text).not.toContain('Retention and deletion')
      expect(text).not.toContain('お問い合わせ')
      expect(text).not.toContain('inquiries')
    }
  })
})
