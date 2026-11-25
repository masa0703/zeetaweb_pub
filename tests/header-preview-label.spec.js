import { TEST_BASE_URL } from './helpers/test-environment.js'
import { test, expect } from './helpers/fixtures.js'
import { waitForAppReady } from './helpers/app.js'

const BASE_URL = TEST_BASE_URL

test('TC-HEADER-PREVIEW-001: ヘッダのプレビュー切り替えのラベルは「preview」', async ({ page }) => {
  await page.request.delete(`${BASE_URL}/api/test/clear`)
  await page.goto(`${BASE_URL}/auth/test-login?user_id=1`, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
  const treeRes = await page.request.post(`${BASE_URL}/api/trees`, { data: { name: 'Header label', description: '' } })
  const tree = (await treeRes.json()).data
  await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
  await waitForAppReady(page)

  const label = page.locator('label:has(#md-preview-toggle)')
  await expect(label).toHaveText('preview')
})
