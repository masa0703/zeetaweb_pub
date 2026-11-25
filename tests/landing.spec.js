import { TEST_BASE_URL } from './helpers/test-environment.js'
import { test, expect } from './helpers/fixtures.js'
import { waitForAppReady } from './helpers/app.js'

// 未ログインで / を開いたときの紹介ページ（TC-LANDING-*）。
// ログイン済みの / とクエリ付きの / は従来どおり編集画面であることも固定する。

const GITHUB_URL = 'https://github.com/masa0703/zeetaweb_pub'

test.describe('Landing page (signed out)', () => {
  test.use({ locale: 'en-US' })

  test.beforeEach(async ({ context }) => {
    await context.clearCookies()
  })

  test('TC-LANDING-001: signed-out / shows the English landing page with sign-in and source links', async ({ page }) => {
    const response = await page.goto('/')
    expect(response.status()).toBe(200)

    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.locator('h1')).toHaveText('An outliner where a note can live under more than one parent.')
    await expect(page.locator('#landing-try-btn')).toHaveText('Try it')
    // 有料化の予定は無いので「trial」（あとで有料になる、と読まれる）を使わない
    await expect(page.locator('.hero-note')).toHaveText('Free · Sign in with Google')
    await expect(page.locator('body')).not.toContainText(/trial/i)
    await expect(page.locator('#landing-try-btn')).toHaveAttribute('href', '/auth/login/google')
    await expect(page.locator('#landing-github-btn')).toHaveAttribute('href', GITHUB_URL)

    const footer = page.locator('footer')
    await expect(footer.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/login/google')
    await expect(footer.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', GITHUB_URL)
    await expect(footer.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
    await expect(footer.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')

    // 編集画面のスクリプトは読まない（ログイン画面へ飛ばされない）
    await expect(page.locator('#landing-try-btn')).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/')
  })

  test('TC-LANDING-002: Try it starts the Google OAuth flow', async ({ page }) => {
    await page.route('**/auth/login/google*', route => route.fulfill({ status: 200, body: 'stub' }))
    await page.goto('/')
    await page.click('#landing-try-btn')
    await page.waitForURL(/\/auth\/login\/google$/)
  })

  test('TC-LANDING-003: the language switch shows the Japanese page and back', async ({ page }) => {
    await page.goto('/')
    await page.locator('header [data-lang-switch]').click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja')
    await expect(page.locator('h1')).toHaveText('1つのメモを、複数の親の下に置けるアウトライナー。')
    await expect(page.locator('#landing-try-btn')).toHaveText('試す')
    await expect(page.locator('.hero-note')).toHaveText('無料・Google アカウントでログイン')
    await expect(page.locator('body')).not.toContainText(/試用|お試し/)

    await page.locator('header [data-lang-switch]').click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.locator('h1')).toHaveText('An outliner where a note can live under more than one parent.')
  })

  test('TC-LANDING-004: an invalid session cookie still gets the landing page', async ({ page, context }) => {
    await context.addCookies([{ name: 'session', value: 'not-a-valid-jwt', url: TEST_BASE_URL }])
    await page.goto('/')
    await expect(page.locator('#landing-try-btn')).toBeVisible()
  })

  test('TC-LANDING-005: signed-out / with a query keeps the old redirect to the login page', async ({ page }) => {
    await page.goto('/?tree=1')
    await page.waitForURL(/\/login(?:\.html)?$/)
  })

  test('TC-LANDING-006: no horizontal overflow at phone width', async ({ page }) => {
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `width ${width}`).toBeLessThanOrEqual(0)
      // body の overflow-x: hidden で隠れたはみ出しも拾う
      const offenders = await page.evaluate(() => Array.from(document.querySelectorAll('main *, header *, footer *'))
        .filter(el => el.getBoundingClientRect().right > window.innerWidth + 0.5)
        .map(el => el.className || el.tagName))
      expect(offenders, `width ${width}`).toEqual([])
      await expect(page.locator('#landing-try-btn')).toBeInViewport()
    }
  })
})

test.describe('Landing page hero screenshot', () => {
  test('TC-LANDING-012: the hero screenshot is not tilted at PC or phone width', async ({ page, context }) => {
    await context.clearCookies()
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const transforms = await page.evaluate(() => ['.hero-shot', '.shot-frame', '.shot-frame img']
        .map(selector => getComputedStyle(document.querySelector(selector)).transform))
      expect(transforms, `width ${width}`).toEqual(['none', 'none', 'none'])
    }
  })
})

test.describe('Landing page indexing', () => {
  test('TC-LANDING-009: only the signed-out landing page is indexable, with canonical and OGP', async ({ page, context }) => {
    await context.clearCookies()
    const response = await page.goto('/')
    expect(response.headers()['x-robots-tag']).toBe('index, follow')
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index, follow')
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /^https?:\/\/[^/]+\/$/)
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /^https?:\/\/[^/]+\/static\/landing\/screenshot\.jpg$/)
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /more than one parent/)
  })

  test('TC-LANDING-010: other pages stay noindex', async ({ page, context, request }) => {
    await context.clearCookies()
    for (const path of ['/login.html', '/help', '/index.html', '/?tree=1']) {
      const response = await request.get(path)
      expect(response.headers()['x-robots-tag'], path).toBe('noindex, nofollow, noarchive')
    }
    // ログイン済みの / は編集画面なので noindex のまま
    await page.goto('/auth/test-login?user_id=1')
    await waitForAppReady(page)
    const signedIn = await page.request.get('/')
    expect(signedIn.headers()['x-robots-tag']).toBe('noindex, nofollow, noarchive')
  })

  test('TC-LANDING-011: robots.txt lets crawlers reach only / and its static assets', async ({ request }) => {
    const body = await (await request.get('/robots.txt')).text()
    expect(body).toBe('User-agent: *\nAllow: /$\nAllow: /static/\nDisallow: /\n')
  })
})

test.describe('Landing page locale from the browser', () => {
  test.use({ locale: 'ja-JP' })

  test('TC-LANDING-007: a Japanese browser gets the Japanese landing page', async ({ page, context }) => {
    await context.clearCookies()
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja')
    await expect(page.locator('h2#problem-heading')).toHaveText('たいていのツールは、置き場所を1つに決めさせる。')
    await expect(page.locator('footer [data-lang-switch]')).toHaveText('English')
  })
})

test.describe('Root for signed-in users', () => {
  test('TC-LANDING-008: signed-in / still opens the editor', async ({ page }) => {
    await page.request.delete('/api/test/clear')
    await page.goto('/auth/test-login?user_id=1')
    await waitForAppReady(page)

    await page.goto('/')
    await waitForAppReady(page)
    await expect(page.locator('#landing-try-btn')).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe('/')
  })
})
