import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

test.describe('検索APIの結果上限', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.delete('/api/test/clear')
    await page.goto('/auth/test-login?user_id=1')
    await waitForAppReady(page)
  })

  test('TC-SEARCH-LIMIT-001: /api/search は結果を100件に打ち切る', async ({ page }) => {
    const treeRes = await page.request.post('/api/trees', { data: { name: 'Search Limit Tree' } })
    const treeData = await treeRes.json()
    expect(treeData.success).toBeTruthy()
    const treeId = treeData.data.id

    const rootRes = await page.request.get(`/api/trees/${treeId}/nodes`)
    const rootNodeId = String((await rootRes.json()).root_node_id)

    // 広い検索語で105件がHitする状態を作る
    const marker = 'searchlimitmarker77'
    for (let i = 0; i < 105; i += 1) {
      const res = await page.request.post(`/api/trees/${treeId}/nodes/with-parent`, {
        data: { title: `${marker}-${i + 1}`, content: `body ${marker}`, author_user_id: 1, parent_node_id: rootNodeId },
      })
      expect(res.status()).toBe(201)
    }

    // 修正前: LIMIT句が無く105件がそのまま返る（ノード本文を全件含む巨大レスポンスになる）
    const res = await page.request.get(`/api/search?q=${marker}`)
    const data = await res.json()
    expect(res.status()).toBe(200)
    expect(data.success).toBeTruthy()
    expect(data.data.length).toBeLessThanOrEqual(100)
    expect(data.data.length).toBeGreaterThan(0)
  })

  test('TC-SEARCH-NORMALIZE-001: /api/search は全角英数をMCPと同じく半角に正規化して検索する', async ({ page }) => {
    const treeRes = await page.request.post('/api/trees', { data: { name: 'Search Normalize Tree' } })
    const treeId = (await treeRes.json()).data.id
    const rootRes = await page.request.get(`/api/trees/${treeId}/nodes`)
    const rootNodeId = String((await rootRes.json()).root_node_id)

    const created = await page.request.post(`/api/trees/${treeId}/nodes/with-parent`, {
      data: { title: 'normmarker42', content: 'body', author_user_id: 1, parent_node_id: rootNodeId },
    })
    expect(created.status()).toBe(201)

    // 修正前: REST は全角スペースのみ置換し、全角英数「ｎｏｒｍｍａｒｋｅｒ４２」ではヒットしなかった
    const res = await page.request.get(`/api/search?q=${encodeURIComponent('ｎｏｒｍｍａｒｋｅｒ４２')}&title_only=true`)
    const data = await res.json()
    expect(res.status()).toBe(200)
    expect(data.data.map((n) => n.title)).toContain('normmarker42')
  })
})
