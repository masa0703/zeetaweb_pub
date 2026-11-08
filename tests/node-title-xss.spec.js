import { test, expect } from '@playwright/test'
import { waitForAppReady, testLogin } from './helpers/app.js'

const BASE_URL = 'http://localhost:3000'
const PAYLOAD = 'x" autofocus onfocus="window.__xss=document.domain" y="'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex')

test.describe('Node title and image filename XSS hardening', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.delete(`${BASE_URL}/api/test/clear`)
    await testLogin(page, 1)
  })

  test('renders a quoted node title as a safe input value', async ({ page }) => {
    const treeResponse = await page.request.post(`${BASE_URL}/api/trees`, { data: { name: 'Title XSS tree' } })
    const tree = (await treeResponse.json()).data
    const nodeResponse = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes`, {
      data: { title: PAYLOAD, content: '', author_user_id: 1 }
    })
    const node = (await nodeResponse.json()).data
    await page.request.post(`${BASE_URL}/api/trees/${tree.id}/relations`, {
      data: { parent_node_id: tree.root_node_id, child_node_id: node.id }
    })

    await page.addInitScript(() => { window.__xss = undefined })
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await waitForAppReady(page)
    await expect(page.locator('#node-title')).toHaveValue(PAYLOAD)
    expect(await page.evaluate(() => window.__xss)).toBeUndefined()
    await expect(page.locator('#node-title')).toHaveCount(1)
  })

  test('renders a quoted image filename as a safe alt attribute', async ({ page }) => {
    const treeResponse = await page.request.post(`${BASE_URL}/api/trees`, { data: { name: 'Image XSS tree' } })
    const tree = (await treeResponse.json()).data
    const nodeResponse = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes`, {
      data: { title: 'Image node', content: '', author_user_id: 1 }
    })
    const node = (await nodeResponse.json()).data
    await page.request.post(`${BASE_URL}/api/trees/${tree.id}/relations`, {
      data: { parent_node_id: tree.root_node_id, child_node_id: node.id }
    })
    const imageResponse = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/images`, {
      multipart: { file: { name: PAYLOAD + '.png', mimeType: 'image/png', buffer: PNG } }
    })
    expect(imageResponse.ok()).toBe(true)

    await page.addInitScript(() => { window.__xss = undefined })
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await waitForAppReady(page)
    await page.locator(`.node-image-icon-item`).first().click()
    const preview = page.locator('.node-image-menu.active .node-image-menu-preview')
    await expect(preview).toHaveAttribute('alt', 'x.png')
    expect(await page.evaluate(() => window.__xss)).toBeUndefined()
    await expect(page.locator('.node-image-menu.active [onerror], .node-image-menu.active [onload]')).toHaveCount(0)
  })
})
