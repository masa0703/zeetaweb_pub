import { test as base, expect } from '@playwright/test'
import { TEST_BASE_URL, TEST_DB_PATH } from './test-environment.js'

export { expect }
export const test = base.extend({
  baseURL: TEST_BASE_URL,
  // Auto fixtures wrap beforeEach/afterEach too. Each case starts from a clean
  // private DB, even when the previous test failed before creating its tree.
  _isolatedData: [async ({ request }, use) => {
    if (!TEST_DB_PATH) throw new Error('Run with playwright.config.js: isolated test server is required')
    const clear = async () => {
      const response = await request.delete('/api/test/clear')
      expect(response.ok(), await response.text()).toBeTruthy()
    }
    await clear()
    try { await use() } finally { await clear() }
  }, { auto: true }],
})
