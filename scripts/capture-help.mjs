// Capture only local demo data; never clear the existing development database.
// Usage: node scripts/capture-help.mjs            (Japanese UI, default)
//        HELP_LANG=en node scripts/capture-help.mjs (English UI)
import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

const lang = process.env.HELP_LANG === 'en' ? 'en' : 'ja'
const base = 'http://localhost:3000'
const out = 'public/static/help'
const demoTreeName = 'ヘルプ用サンプル'
const demoNodeTitle = '週次ミーティング'
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: lang === 'en' ? 'en-US' : 'ja-JP', deviceScaleFactor: 1 })
await page.context().addCookies([{ name: 'lang', value: lang, url: base }])
try {
  await page.goto(`${base}/auth/test-login?user_id=1`)
  await page.waitForSelector('#trees-container')
  async function request(method, path, data) {
    const response = await page.request[method](`${base}${path}`, { data })
    if (!response.ok()) throw new Error(`${path}: ${response.status()} ${await response.text()}`)
    return (await response.json()).data
  }
  // Reuse the shared demo tree so Japanese and English captures show the same sample.
  let tree = process.env.HELP_DEMO_TREE_ID
    ? await request('get', `/api/trees/${process.env.HELP_DEMO_TREE_ID}`)
    : (await request('get', '/api/trees')).find(t => t.name === demoTreeName)
  if (!tree) tree = await request('post', '/api/trees', { name: demoTreeName, description: '操作説明のための架空のプロジェクト' })
  const before = '# 週次ミーティング\n\n## 決定事項\n\n- 日本語のヘルプを更新する\n- 画面の説明を分かりやすくする\n'
  let node = process.env.HELP_DEMO_NODE_ID
    ? await request('get', `/api/trees/${tree.id}/nodes/${process.env.HELP_DEMO_NODE_ID}`)
    : null
  if (!node) {
    const nodes = await request('get', `/api/trees/${tree.id}/nodes`)
    const list = Array.isArray(nodes) ? nodes : nodes.nodes ?? []
    node = list.find(n => n.title === demoNodeTitle)
  }
  if (!node) {
    node = await request('post', `/api/trees/${tree.id}/nodes`, { title: demoNodeTitle, content: before, author_user_id: 1 })
    await request('post', `/api/trees/${tree.id}/relations`, { parent_node_id: tree.root_node_id, child_node_id: node.id })
    await request('put', `/api/trees/${tree.id}/nodes/${node.id}`, { content: before + '\n## 次のアクション\n\n| 担当 | 作業 | 状態 |\n| --- | --- | --- |\n| チームA | 画面イメージを確認 | 作業中 |\n| チームB | 説明文を確認 | 未着手 |\n\n## 作業の流れ\n\n```mermaid\nflowchart LR\n  A[記録] --> B[共有]\n  B --> C[振り返り]\n```\n', version: node.version || 1 })
  }
  await page.goto(`${base}/index.html?tree=${tree.id}&node=${node.id}`)
  await page.waitForSelector('#node-detail-btn')
  await page.waitForSelector('.bytemd-toolbar')
  await page.waitForSelector('.bytemd-preview .bytemd-mermaid[data-mermaid-viewer-ready="true"] svg', { timeout: 30000 })
  await page.evaluate(() => document.fonts.ready)
  console.log('EDITOR CONTROLS', await page.locator('button, .bytemd-toolbar-icon').evaluateAll(els => els.map(el => ({id:el.id, title:el.title, label:el.getAttribute('aria-label'), text:el.textContent.trim().slice(0,35)})).filter(x=>x.id||x.title)))
  await page.screenshot({ path: `${out}/editor-${lang}.png` })
  const viewport = { x: 0, y: 0, width: 1440, height: 960 }
  console.log('EDITOR MARKERS', JSON.stringify(await markers(['#history-back-btn','#tree-search-btn','.parents-chip-toggle','#node-detail-btn','#save-node-btn','#content-search-input','.bytemd-toolbar','#open-html-btn'], viewport)))
  await page.locator('#tree-search-btn').click()
  await page.waitForSelector('#search-popup-modal.active')
  await page.locator('.search-popup-input').fill('ミーティング')
  await page.locator('.search-popup-input').press('Enter')
  await page.waitForSelector('.search-popup-item')
  const dialogBox = await page.locator('.search-popup-dialog').boundingBox()
  await page.locator('.search-popup-dialog').screenshot({ path: `${out}/search-${lang}.png` })
  console.log('SEARCH MARKERS', JSON.stringify(await markers(['.search-popup-input','.search-popup-scope-group','.search-popup-title-only-toggle'], dialogBox)))
  await page.keyboard.press('Escape')
  await page.locator('#node-detail-btn').click()
  await page.waitForSelector('.node-detail-history-row')
  await page.waitForFunction(() => document.querySelector('#node-detail-preview')?.textContent.includes('決定事項'))
  const panelBox = await page.locator('#node-detail-dialog-panel').boundingBox()
  await page.locator('#node-detail-dialog-panel').screenshot({ path: `${out}/detail-${lang}.png` })
  console.log('DETAIL MARKERS', JSON.stringify(await markers(['#node-detail-author','#node-detail-history-list','#node-detail-preview','#node-detail-restore-btn'], panelBox)))
  console.log('DEMO_URL', `${base}/index.html?tree=${tree.id}&node=${node.id}`)
  async function markers(selectors, area) {
    const result = { area: { width: Math.round(area.width), height: Math.round(area.height) }, markers: {} }
    for (let i = 0; i < selectors.length; i++) {
      const box = await page.locator(selectors[i]).first().boundingBox()
      const left = +(((box.x + box.width / 2 - area.x) / area.width) * 100).toFixed(1)
      const top = +(((box.y + box.height / 2 - area.y) / area.height) * 100).toFixed(1)
      result.markers[String(i + 1)] = [left, top]
    }
    return result
  }
} finally { await browser.close() }
