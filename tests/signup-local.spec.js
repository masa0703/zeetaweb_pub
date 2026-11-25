import { TEST_BASE_URL } from './helpers/test-environment.js'
import { test, expect } from './helpers/fixtures.js'
import { waitForAppReady } from './helpers/app.js'

test('local test login can exercise new-user signup and reuse the same account', async ({ page }) => {
  const origin = TEST_BASE_URL
  const userId = Date.now()
  const url = `${origin}/auth/test-login?signup=true&user_id=${userId}`
  await page.goto(url)
  await waitForAppReady(page)
  const trees = await (await page.request.get(`${origin}/api/trees`)).json()
  const hello = trees.data.find(tree => tree.name === 'Hello')
  expect(hello).toBeTruthy()
  try {
    const nodes = await (await page.request.get(`${origin}/api/trees/${hello.id}/nodes-lite`)).json()
    expect(JSON.stringify(nodes)).toContain('Hello: JP')
    expect(JSON.stringify(nodes)).toContain('Hello: EN')
    await page.goto(url)
    await waitForAppReady(page)
    const again = await (await page.request.get(`${origin}/api/trees`)).json()
    expect(again.data.filter(tree => tree.name === 'Hello')).toHaveLength(1)
  } finally { await page.request.delete(`${origin}/api/trees/${hello.id}`) }
})
