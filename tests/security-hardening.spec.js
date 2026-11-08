import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

async function createTree(page, name) {
  const res = await page.request.post('/api/trees', { data: { name } })
  const data = await res.json()
  expect(data.success).toBeTruthy()
  return data.data
}

test.describe('セキュリティ強化（コードレビュー高対応）', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.delete('/api/test/clear')
    await page.goto('/auth/test-login?user_id=1')
    await waitForAppReady(page)
  })

  test('TC-SEC-HARD-001: SVG画像のアップロードは拒否される', async ({ page }) => {
    const tree = await createTree(page, 'SVG Reject Tree')
    const rootRes = await page.request.get(`/api/trees/${tree.id}/nodes`)
    const rootNodeId = String((await rootRes.json()).root_node_id)
    const nodeRes = await page.request.post(`/api/trees/${tree.id}/nodes/with-parent`, {
      data: { title: 'svg target', content: '', author_user_id: 1, parent_node_id: rootNodeId },
    })
    expect(nodeRes.status()).toBe(201)
    const nodeId = (await nodeRes.json()).data.node.id

    // SVGは配信経由の同一オリジンXSSになるためアップロードを許可しない
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>'
    const res = await page.request.post(`/api/trees/${tree.id}/nodes/${nodeId}/images`, {
      multipart: {
        file: {
          name: 'evil.svg',
          mimeType: 'image/svg+xml',
          buffer: Buffer.from(svg, 'utf8'),
        },
      },
    })
    const data = await res.json()
    expect(res.status(), JSON.stringify(data)).toBe(400)
  })

  test('TC-SEC-HARD-002: PDF用Markdownレンダリングはスクリプトを混入させない', async ({ page }) => {
    const tree = await createTree(page, 'PDF Sanitize Tree')
    const rootRes = await page.request.get(`/api/trees/${tree.id}/nodes`)
    const rootNodeId = String((await rootRes.json()).root_node_id)
    const nodeRes = await page.request.post(`/api/trees/${tree.id}/nodes/with-parent`, {
      data: { title: 'pdf node', content: 'test', author_user_id: 1, parent_node_id: rootNodeId },
    })
    const nodeId = (await nodeRes.json()).data.node.id

    await page.goto(`/index.html?tree=${tree.id}`)
    await page.waitForSelector('.tree-item[data-node-id]')
    await page.click(`.tree-item[data-node-id="${nodeId}"]`)
    await page.waitForSelector('#node-content-editor .bytemd', { timeout: 15000 })

    // renderMarkdownHtmlForPdf は app.js のグローバル関数。
    // marked はサニタイズしないため、DOMPurify を通さないと onload / javascript: がそのまま残る
    const html = await page.evaluate(() =>
      renderMarkdownHtmlForPdf('<img src=x onerror="window.__pdfXss=1"> [link](javascript:alert(1))')
    )
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('javascript:')
  })

  test('TC-SEC-HARD-003: エディタのCDNリソースはバージョン固定+SRI付き', async ({ page }) => {
    const tree = await createTree(page, 'CDN SRI Tree')
    const rootRes = await page.request.get(`/api/trees/${tree.id}/nodes`)
    const rootNodeId = String((await rootRes.json()).root_node_id)
    const nodeRes = await page.request.post(`/api/trees/${tree.id}/nodes/with-parent`, {
      data: { title: 'cdn node', content: 'test', author_user_id: 1, parent_node_id: rootNodeId },
    })
    const nodeId = (await nodeRes.json()).data.node.id

    // integrity の値が誤っているとブラウザはリソースをブロックし、コンソールに出す
    // （属性の有無だけでは検出できない。実例: FontAwesome のハッシュ誤記でアイコンが全滅）
    const sriErrors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error' && msg.text().includes('integrity')) sriErrors.push(msg.text())
    })

    await page.goto(`/index.html?tree=${tree.id}`)
    await page.waitForSelector('.tree-item[data-node-id]')
    await page.click(`.tree-item[data-node-id="${nodeId}"]`)
    await page.waitForSelector('#node-content-editor .bytemd', { timeout: 15000 })
    expect(sriErrors, sriErrors.join('\n')).toEqual([])

    const resources = await page.evaluate(() => {
      const els = [...document.querySelectorAll('script[src], link[rel="stylesheet"][href]')]
        .filter(el => (el.src || el.href).includes('cdn.jsdelivr.net') || (el.src || el.href).includes('cdnjs.cloudflare.com'))
      return els.map(el => ({
        url: el.src || el.href,
        integrity: el.getAttribute('integrity'),
        crossorigin: el.getAttribute('crossorigin'),
      }))
    })
    expect(resources.length).toBeGreaterThanOrEqual(8)
    for (const r of resources) {
      expect(r.integrity, `${r.url} に integrity が無い`).toBeTruthy()
      expect(r.crossorigin, `${r.url} に crossorigin が無い`).toBeTruthy()
    }
    // bytemd 本体・plugin-gfm・css はバージョン固定されている
    const bytemd = resources.filter(r => r.url.includes('bytemd'))
    expect(bytemd.length).toBeGreaterThanOrEqual(3)
    for (const r of bytemd) {
      expect(r.url).toMatch(/@1\.22\.0/)
    }
  })
})
