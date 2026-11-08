import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

test.describe('プロフィール更新', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.delete('/api/test/clear')
    await page.goto('/auth/test-login?user_id=1')
    await waitForAppReady(page)
  })

  test('TC-PROFILE-001: display_name 未指定の PUT /api/profile は500にならず現在値を維持する', async ({ page }) => {
    const beforeRes = await page.request.get('/api/profile')
    const beforeData = await beforeRes.json()
    expect(beforeRes.ok()).toBeTruthy()
    expect(beforeData.success).toBeTruthy()

    // 修正前: display_name === undefined のまま .trim() され TypeError → 500
    const res = await page.request.put('/api/profile', { data: {} })
    const data = await res.json()
    expect(res.status(), JSON.stringify(data)).toBe(200)
    expect(data.success).toBeTruthy()
    // 未指定の項目は現在値が維持される
    expect(data.data.display_name).toBe(beforeData.data.display_name)
  })
})
