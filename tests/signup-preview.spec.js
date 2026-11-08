import { test, expect } from '@playwright/test'
import { testLogin, openTreeEditor } from './helpers/app.js'

test('Markdown preview defaults on and respects an explicit choice', async ({ page }) => {
  await testLogin(page, 779901)
  const response = await page.request.post('/api/trees', { data: { name: 'Preview preference test' } })
  expect(response.status()).toBe(201)
  const tree = (await response.json()).data
  try {
    await page.evaluate(() => localStorage.removeItem('zeeta_md_preview_enabled'))
    await openTreeEditor(page, tree.id)
    const toggle = page.locator('#md-preview-toggle')
    await expect(toggle).toBeChecked()
    await toggle.uncheck()
    await page.reload()
    await expect(page.locator('#md-preview-toggle')).not.toBeChecked()
    await page.locator('#md-preview-toggle').check()
    await page.reload()
    await expect(page.locator('#md-preview-toggle')).toBeChecked()
  } finally {
    await page.request.delete(`/api/trees/${tree.id}`)
  }
})
