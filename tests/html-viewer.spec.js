import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

const BASE_URL = 'http://localhost:3000'

async function login(page) {
  await page.context().clearCookies()
  await page.goto(`${BASE_URL}/auth/test-login?user_id=1`)
  await waitForAppReady(page)
}

/**
 * プレビューに4つのコードブロックを出す。並び順はこの配列のとおり。
 *   0: ```html                       → 対象
 *   1: 言語指定なしフェンス + 先頭doctype → 対象
 *   2: ```js                         → 対象外
 *   3: 言語指定なしフェンス + 途中doctype → 対象外
 */
const BLOCKS = [
  '```html\n<div id="frag">FRAGMENT_BODY</div>\n```',
  '```\n<!DOCTYPE html>\n<html><body>PLAIN_FENCE_DOC</body></html>\n```',
  "```js\nconsole.log('not html')\n```",
  "```\nconsole.log('leading line')\n<!doctype html>\n```",
]

async function openNodeWithBlocks(page, blocks = BLOCKS) {
  const treeResponse = await page.request.post(`${BASE_URL}/api/trees`, {
    data: { name: 'HTML Viewer Test', description: 'HTML block viewer E2E' },
  })
  expect(treeResponse.ok()).toBeTruthy()
  const tree = (await treeResponse.json()).data

  const nodeResponse = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes`, {
    data: { title: 'HTML Viewer Node', content: blocks.join('\n\n'), author_user_id: 1 },
  })
  expect(nodeResponse.ok()).toBeTruthy()
  const node = (await nodeResponse.json()).data

  const relationResponse = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/relations`, {
    data: { parent_node_id: tree.root_node_id, child_node_id: node.id },
  })
  expect(relationResponse.ok()).toBeTruthy()

  await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
  await page.locator(`.tree-item[data-node-id="${node.id}"]`).click()
  const allBlocks = page.locator('.bytemd-preview pre')
  await expect(allBlocks).toHaveCount(blocks.length, { timeout: 30000 })
  return allBlocks
}

test.describe('HTML code block viewer', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.delete(`${BASE_URL}/api/test/clear`)
    await login(page)
  })

  test('TC-FUNC-048: HTMLコードブロックだけがPreviewでクリッカブルになる', async ({ page }) => {
    const blocks = await openNodeWithBlocks(page)

    // ```html と「先頭が doctype の無指定フェンス」だけが対象
    await expect(page.locator('.bytemd-preview pre[data-html-viewer-ready="true"]')).toHaveCount(2)
    await expect(blocks.nth(0)).toHaveAttribute('data-html-viewer-ready', 'true')
    await expect(blocks.nth(1)).toHaveAttribute('data-html-viewer-ready', 'true')
    await expect(blocks.nth(2)).not.toHaveAttribute('data-html-viewer-ready', 'true')
    // 本文の途中に doctype があるだけのブロックは対象外（HTMLの解説記事での誤爆防止）
    await expect(blocks.nth(3)).not.toHaveAttribute('data-html-viewer-ready', 'true')

    await expect(blocks.nth(0)).toHaveCSS('cursor', 'pointer')
    await expect(blocks.nth(0)).toHaveAttribute('title', 'クリックして別タブでHTMLを表示')
    await expect(blocks.nth(0)).toHaveAttribute('tabindex', '0')

    // 廃止した CONTENT ヘッダーのHTML別タブ表示ボタンが残っていないこと
    await expect(page.locator('#open-html-btn')).toHaveCount(0)
  })

  test('TC-FUNC-048: クリックしたブロックのHTMLだけがサンドボックスで描画される', async ({ page }) => {
    const blocks = await openNodeWithBlocks(page)

    let popupCount = 0
    page.on('popup', () => { popupCount += 1 })
    await blocks.nth(2).click()
    await page.waitForTimeout(250)
    expect(popupCount).toBe(0)

    const popupPromise = page.waitForEvent('popup')
    await blocks.nth(1).click()
    const viewer = await popupPromise
    await expect(viewer).toHaveURL(/\/html-viewer\?channel=/)

    const frame = viewer.locator('#html-frame')
    await expect(frame).toBeVisible({ timeout: 10000 })
    await expect(viewer.locator('#viewer-status')).toBeHidden()
    const body = viewer.frameLocator('#html-frame').locator('body')
    await expect(body).toContainText('PLAIN_FENCE_DOC')
    await expect(body).not.toContainText('FRAGMENT_BODY')
  })

  // sandbox から allow-same-origin が落ちると、ユーザーが書いたHTMLが Zeeta の
  // オリジンで動く（ログイン中のまま /api/* を叩ける）。隔離の回帰を検知する。
  test('TC-FUNC-048: ビューアのiframeは allow-same-origin なしのsandboxで隔離される', async ({ page }) => {
    const blocks = await openNodeWithBlocks(page)
    const popupPromise = page.waitForEvent('popup')
    await blocks.nth(1).click()
    const viewer = await popupPromise

    const sandbox = await viewer.locator('#html-frame').getAttribute('sandbox')
    expect(sandbox).toBeTruthy()
    expect(sandbox.split(/\s+/)).not.toContain('allow-same-origin')

    const origin = await viewer.frameLocator('#html-frame').locator('body').evaluate(() => window.origin)
    expect(origin).toBe('null')
  })

  // ```html の断片は charset 未指定の裸のフラグメントになるため、最小のHTML文書に包む
  test('TC-FUNC-048: doctypeの無い```html断片も文書として表示される', async ({ page }) => {
    const blocks = await openNodeWithBlocks(page)
    const popupPromise = page.waitForEvent('popup')
    await blocks.nth(0).click()
    const viewer = await popupPromise

    const fragment = viewer.frameLocator('#html-frame').locator('#frag')
    await expect(fragment).toBeVisible({ timeout: 10000 })
    await expect(fragment).toHaveText('FRAGMENT_BODY')
    const charset = await viewer.frameLocator('#html-frame').locator('meta[charset]').getAttribute('charset')
    expect(charset.toLowerCase()).toBe('utf-8')
  })
})
