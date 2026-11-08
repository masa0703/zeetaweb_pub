import { test, expect } from '@playwright/test'
import { waitForAppReady, openTreeEditor, chooseTreeMenu } from './helpers/app.js'

/**
 * Phase 11: プロフィール管理 E2E テスト
 *
 * テスト対象:
 * - プロフィール情報の取得
 * - 表示名の更新
 * - バリデーション
 * - UI動作
 */

// Test helper functions
async function testLogin(page, userId = 1) {
  await page.context().clearCookies()
  await page.goto(`/auth/test-login?user_id=${userId}`)
  await waitForAppReady(page)
}

async function clearTestData(page) {
  await page.request.delete('/api/test/clear')
}

async function getProfile(page) {
  const response = await page.request.get('/api/profile')
  const data = await response.json()
  return data.data
}

// ============================================
// 1. プロフィール取得テスト
// ============================================

test.describe('プロフィール情報取得', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-PROF-001: プロフィール情報を取得できる', async ({ page }) => {
    await testLogin(page, 1)

    const profile = await getProfile(page)

    expect(profile).toBeDefined()
    expect(profile.id).toBe(1)
    expect(profile.email).toBeDefined()
    expect(profile.display_name).toBeDefined()
    expect(profile.oauth_provider).toBe('test')
  })

  test('TC-PROF-002: 未認証ユーザーはプロフィールを取得できない', async ({ page }) => {
    await page.context().clearCookies()

    const response = await page.request.get('/api/profile')
    expect(response.status()).toBe(401)
  })
})

// ============================================
// 2. プロフィール更新テスト
// ============================================

test.describe('プロフィール更新', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-UPD-001: 表示名を更新できる', async ({ page }) => {
    await testLogin(page, 1)

    // Get current profile
    const beforeProfile = await getProfile(page)
    expect(beforeProfile.display_name).toBe('Test User 1')

    // Update display name
    const updateResponse = await page.request.put('/api/profile', {
      data: {
        display_name: 'Updated Name'
      }
    })

    expect(updateResponse.ok()).toBeTruthy()
    const updateData = await updateResponse.json()
    expect(updateData.success).toBe(true)
    expect(updateData.data.display_name).toBe('Updated Name')

    // Verify updated profile
    const afterProfile = await getProfile(page)
    expect(afterProfile.display_name).toBe('Updated Name')
  })

  test('TC-UPD-002: 日本語の表示名を更新できる', async ({ page }) => {
    await testLogin(page, 1)

    const updateResponse = await page.request.put('/api/profile', {
      data: {
        display_name: '山田 太郎'
      }
    })

    expect(updateResponse.ok()).toBeTruthy()
    const data = await updateResponse.json()
    expect(data.data.display_name).toBe('山田 太郎')
  })

  test('TC-UPD-003: 前後の空白はトリムされる', async ({ page }) => {
    await testLogin(page, 1)

    const updateResponse = await page.request.put('/api/profile', {
      data: {
        display_name: '  Trimmed Name  '
      }
    })

    expect(updateResponse.ok()).toBeTruthy()
    const data = await updateResponse.json()
    expect(data.data.display_name).toBe('Trimmed Name')
  })

  test('TC-UPD-004: 未認証ユーザーは更新できない', async ({ page }) => {
    await page.context().clearCookies()

    const response = await page.request.put('/api/profile', {
      data: {
        display_name: 'Unauthorized Update'
      }
    })

    expect(response.status()).toBe(401)
  })
})

// ============================================
// 3. バリデーションテスト
// ============================================

test.describe('バリデーション', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-VAL-001: 空の表示名は拒否される', async ({ page }) => {
    await testLogin(page, 1)

    const updateResponse = await page.request.put('/api/profile', {
      data: {
        display_name: ''
      }
    })

    expect(updateResponse.status()).toBe(400)
    const data = await updateResponse.json()
    expect(data.success).toBe(false)
    expect(data.error).toContain('cannot be empty')
  })

  test('TC-VAL-002: 空白のみの表示名は拒否される', async ({ page }) => {
    await testLogin(page, 1)

    const updateResponse = await page.request.put('/api/profile', {
      data: {
        display_name: '   '
      }
    })

    expect(updateResponse.status()).toBe(400)
    const data = await updateResponse.json()
    expect(data.success).toBe(false)
    expect(data.error).toContain('cannot be empty')
  })

  test('TC-VAL-003: 101文字以上の表示名は拒否される', async ({ page }) => {
    await testLogin(page, 1)

    const longName = 'a'.repeat(101)
    const updateResponse = await page.request.put('/api/profile', {
      data: {
        display_name: longName
      }
    })

    expect(updateResponse.status()).toBe(400)
    const data = await updateResponse.json()
    expect(data.success).toBe(false)
    expect(data.error).toContain('100 characters')
  })

  test('TC-VAL-004: 100文字ちょうどの表示名は許可される', async ({ page }) => {
    await testLogin(page, 1)

    const maxName = 'a'.repeat(100)
    const updateResponse = await page.request.put('/api/profile', {
      data: {
        display_name: maxName
      }
    })

    expect(updateResponse.ok()).toBeTruthy()
    const data = await updateResponse.json()
    expect(data.data.display_name).toBe(maxName)
  })

  test('TC-VAL-005: 無効な型の表示名は拒否される', async ({ page }) => {
    await testLogin(page, 1)

    const updateResponse = await page.request.put('/api/profile', {
      data: {
        display_name: 123
      }
    })

    expect(updateResponse.status()).toBe(400)
    const data = await updateResponse.json()
    expect(data.success).toBe(false)
    expect(data.error).toContain('must be a string')
  })
})

// ============================================
// 4. プロフィールページUIテスト
// ============================================

test.describe('プロフィールページUI', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-UI-001: プロフィールページが表示される', async ({ page }) => {
    await testLogin(page, 1)
    await page.goto('/profile.html')

    // Wait for profile to load
    await page.waitForSelector('#profile-container', { state: 'visible', timeout: 10000 })

    // Check header
    await expect(page.locator('h1')).toContainText('プロフィール設定')

    // Check form fields are populated
    const emailInput = page.locator('#email')
    await expect(emailInput).toHaveValue(/test-user-1@example\.com/)

    const displayNameInput = page.locator('#display-name')
    await expect(displayNameInput).toHaveValue('Test User 1')
  })

  test('TC-UI-002: 表示名をUIから更新できる', async ({ page }) => {
    await testLogin(page, 1)
    await page.goto('/profile.html')

    await page.waitForSelector('#profile-container', { state: 'visible', timeout: 10000 })

    // Update display name
    const displayNameInput = page.locator('#display-name')
    await displayNameInput.clear()
    await displayNameInput.fill('UI Updated Name')

    // Submit form
    await page.click('#submit-btn')

    // Wait for success message
    await page.waitForSelector('#success-message.show', { timeout: 5000 })
    await expect(page.locator('#success-message')).toBeVisible()

    // Verify profile was updated via API
    const profile = await getProfile(page)
    expect(profile.display_name).toBe('UI Updated Name')
  })

  test('TC-UI-003: メールアドレスは読み取り専用', async ({ page }) => {
    await testLogin(page, 1)
    await page.goto('/profile.html')

    await page.waitForSelector('#profile-container', { state: 'visible', timeout: 10000 })

    const emailInput = page.locator('#email')
    await expect(emailInput).toBeDisabled()
  })

  test('TC-UI-004: 空の表示名でエラーメッセージが表示される', async ({ page }) => {
    await testLogin(page, 1)
    await page.goto('/profile.html')

    await page.waitForSelector('#profile-container', { state: 'visible', timeout: 10000 })

    // Clear display name
    const displayNameInput = page.locator('#display-name')
    await displayNameInput.clear()

    // Submit form
    await page.click('#submit-btn')

    // Wait for error message
    await page.waitForSelector('#error-message.show', { timeout: 5000 })
    await expect(page.locator('#error-message')).toBeVisible()
    await expect(page.locator('#error-text')).toContainText('表示名を入力してください')
  })

  test('TC-UI-005: キャンセルボタンで編集画面に戻る', async ({ page }) => {
    await testLogin(page, 1)
    await page.goto('/profile.html')

    await page.waitForSelector('#profile-container', { state: 'visible', timeout: 10000 })

    // Click cancel button
    await page.click('a:has-text("キャンセル")')

    // マイページ廃止後は編集画面へ戻る
    await waitForAppReady(page)
    expect(new URL(page.url()).pathname).toBe('/index.html')
  })

  test('TC-UI-006: ヘッダーの「ツリーに戻る」リンクが動作する', async ({ page }) => {
    await testLogin(page, 1)
    await page.goto('/profile.html')

    await page.waitForSelector('#profile-container', { state: 'visible', timeout: 10000 })

    // Click header link
    await page.click('a:has-text("ツリーに戻る")')

    await waitForAppReady(page)
    expect(new URL(page.url()).pathname).toBe('/index.html')
  })

  test('TC-UI-007: 未認証ユーザーはログインページにリダイレクトされる', async ({ page }) => {
    await page.context().clearCookies()
    await page.goto('/profile.html')

    // Should redirect to login
    await page.waitForURL(/\/login(?:\.html)?(?:\?.*)?$/, { timeout: 10000 })
    expect(new URL(page.url()).pathname).toMatch(/^\/login(?:\.html)?$/)
  })
})

// ============================================
// 5. 統合テスト
// ============================================

test.describe('統合テスト', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-INT-001: プロフィール更新が他の画面に反映される', async ({ page }) => {
    await testLogin(page, 1)

    // Update profile
    await page.request.put('/api/profile', {
      data: {
        display_name: 'Integration Test Name'
      }
    })

    // 表示名はメンバー管理の一覧に出る。ヘッダーにはユーザー名を出さない
    const created = await page.request.post('/api/trees', { data: { name: 'Profile Reflect Tree' } })
    const tree = (await created.json()).data
    await openTreeEditor(page, tree.id)
    await chooseTreeMenu(page, 'Profile Reflect Tree', 'members')
    await expect(page.locator('#members-list')).toContainText('Integration Test Name')
  })

  test('TC-INT-002: 複数ユーザーのプロフィールは独立している', async ({ page }) => {
    // User 1 updates profile
    await testLogin(page, 1)
    await page.request.put('/api/profile', {
      data: {
        display_name: 'User 1 Name'
      }
    })

    // User 2 updates profile
    await testLogin(page, 2)
    await page.request.put('/api/profile', {
      data: {
        display_name: 'User 2 Name'
      }
    })

    // Verify User 1 profile is unchanged
    await testLogin(page, 1)
    const user1Profile = await getProfile(page)
    expect(user1Profile.display_name).toBe('User 1 Name')

    // Verify User 2 profile is correct
    await testLogin(page, 2)
    const user2Profile = await getProfile(page)
    expect(user2Profile.display_name).toBe('User 2 Name')
  })
})
