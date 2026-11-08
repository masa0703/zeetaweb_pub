import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

const BASE_URL = 'http://localhost:3000'

test.describe('Login page redirect hardening', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.delete(`${BASE_URL}/api/test/clear`)
    await page.goto(`${BASE_URL}/auth/test-login?user_id=1`)
    await waitForAppReady(page)
  })

  test('TC-SEC-PUBLIC-003b: keeps an authenticated user inside the app for unsafe redirect values', async ({ page }) => {
    for (const unsafe of [
      'https://evil.example/phish',
      '//evil.example/phish',
      '/\\evil.example/phish',
      'javascript:window.__zeetaRedirectXss = 1',
      // dot segment の正規化後に protocol-relative になるもの
      '/.//evil.example/phish',
      '/..//evil.example/phish',
      '/%2e//evil.example',
      '/a/../..//evil.example'
    ]) {
      await page.goto(`${BASE_URL}/login.html?redirect=${encodeURIComponent(unsafe)}`)
      // 不正な戻り先は捨て、既定の編集画面へ戻す
      await page.waitForURL(/\/index\.html(?:\?tree=\d+)?$/)
      expect(new URL(page.url()).origin).toBe(BASE_URL)
      expect(await page.evaluate(() => window.__zeetaRedirectXss)).toBeUndefined()
    }
  })

  test('TC-SEC-PUBLIC-003b: still honours a same-app relative redirect', async ({ page }) => {
    await page.goto(`${BASE_URL}/login.html?redirect=${encodeURIComponent('/profile.html?tab=general')}`)
    await page.waitForURL(/\/profile(?:\.html)?\?tab=general$/)
    expect(new URL(page.url()).pathname).toMatch(/^\/profile(?:\.html)?$/)
  })

  // 招待ページは絶対URLを redirect に渡していたため、戻り先検証の導入で招待フローが
  // 黙って壊れていた。相対パスで渡していることを固定する
  test('TC-SEC-PUBLIC-003c: invitation page hands the login page a relative return path', async ({ page }) => {
    await page.context().clearCookies()
    await page.goto(`${BASE_URL}/accept-invitation.html?token=dummy-token`)
    await page.waitForURL(/\/login(?:\.html)?\?redirect=/)

    // dev では `/accept-invitation.html` が `/accept-invitation` へ308されるため、
    // pathname から .html が落ちる。相対パスであることが確認できればよい
    const redirect = new URL(page.url()).searchParams.get('redirect')
    expect(redirect).toMatch(/^\/accept-invitation(?:\.html)?\?token=dummy-token$/)
  })

  // 戻り先検証の共有モジュール化で、ログインボタンを inline onclick から
  // addEventListener へ移した。結び付けが外れていないことを固定する
  test('TC-SEC-PUBLIC-003d: Google login button starts the OAuth flow with the validated redirect', async ({ page }) => {
    await page.context().clearCookies()
    await page.route('**/auth/login/google*', route => route.fulfill({ status: 200, body: 'stub' }))

    await page.goto(`${BASE_URL}/login.html?redirect=${encodeURIComponent('/profile.html?tab=general')}`)
    await page.click('#google-login-btn')
    await page.waitForURL(/\/auth\/login\/google\?redirect=/)

    const redirect = new URL(page.url()).searchParams.get('redirect')
    expect(redirect).toBe('/profile.html?tab=general')
  })
})
