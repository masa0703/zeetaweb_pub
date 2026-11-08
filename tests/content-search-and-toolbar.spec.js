import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'
import { issueMcpAuth, callMcpWithBearer } from './helpers/mcp-oauth.js'

const BASE_URL = process.env.ZEETA_TEST_BASE_URL || 'http://localhost:3000'

async function testLogin(page, userId = 1) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
}

async function clearTestData(page) {
  await page.request.delete(`${BASE_URL}/api/test/clear`)
}

async function createTree(page, name) {
  const response = await page.request.post(`${BASE_URL}/api/trees`, {
    data: { name, description: 'Content search / toolbar test tree' }
  })
  const data = await response.json()
  return data.data
}

async function createNode(page, treeId, title, content = '') {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes`, {
    data: { title, content, author_user_id: 1 }
  })
  const data = await response.json()
  return data.data
}

async function addRelation(page, treeId, parentId, childId) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/relations`, {
    data: { parent_node_id: parentId, child_node_id: childId }
  })
  expect(response.ok()).toBe(true)
}

test.describe('Toolbar and content search (TC-FUNC-006 / TC-FUNC-050 / TC-FUNC-051)', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
    await testLogin(page, 1)
  })

  test('TC-FUNC-006: tree search button moved next to reload button, header button removed', async ({ page }) => {
    const tree = await createTree(page, 'Toolbar Tree')
    await createNode(page, tree.id, 'Search Target Node', '検索対象コンテンツ')
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForSelector('.tree-item', { timeout: 15000 })

    await expect(page.locator('#header-search-btn')).toHaveCount(0)
    await expect(page.locator('#tree-search-btn')).toBeVisible()

    // 虫眼鏡ボタンが再読み込みボタンの直前（DOM順で前）にあることを確認
    const order = await page.evaluate(() => {
      const search = document.getElementById('tree-search-btn')
      const reload = document.getElementById('reload-tree-btn')
      return search.compareDocumentPosition(reload) === Node.DOCUMENT_POSITION_FOLLOWING
    })
    expect(order).toBe(true)

    await page.click('#tree-search-btn')
    await expect(page.locator('#search-popup-modal.active')).toBeVisible()
  })

  test('TC-FUNC-057: only title checkbox restricts search to node titles', async ({ page }) => {
    const tree = await createTree(page, 'Only Title Tree')
    const keyword = 'AlphaTitleNode'
    await createNode(page, tree.id, keyword, '本文にキーワードは含まれない')
    await createNode(page, tree.id, 'PlainNode', `本文に${keyword}という語を含む`)
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForSelector('.tree-item', { timeout: 15000 })

    await page.click('#tree-search-btn')
    await expect(page.locator('#search-popup-modal.active')).toBeVisible()
    const toggle = page.locator('.search-popup-title-only-toggle')
    // 「選択ノード配下」の右（同一スコープグループ内の直後）に表示される
    await expect(toggle).toBeVisible()
    const toggleLabel = toggle.locator('..')
    await expect(toggleLabel.locator('span')).toHaveText('only title')
    const placement = await page.evaluate(() => {
      const selectedOption = document.querySelector('input[name="search-popup-scope"][value="selected"]')
      const titleOnlyToggle = document.querySelector('.search-popup-title-only-toggle')
      const sameGroup = selectedOption?.closest('.search-popup-scope-group') === titleOnlyToggle?.closest('.search-popup-scope-group')
      const isAfter = selectedOption?.compareDocumentPosition(titleOnlyToggle) === Node.DOCUMENT_POSITION_FOLLOWING
      return sameGroup && isAfter
    })
    expect(placement).toBe(true)

    // チェックなし: タイトルと本文の両方にヒット
    await page.fill('.search-popup-input', keyword)
    await page.click('.search-popup-submit')
    const resultTitles = page.locator('.search-popup-item-title')
    await expect(resultTitles.filter({ hasText: keyword })).toHaveCount(1)
    await expect(resultTitles.filter({ hasText: 'PlainNode' })).toHaveCount(1)

    // チェックあり: タイトルのみ検索し、本文のみのヒットは消える
    await toggle.check()
    await expect(resultTitles.filter({ hasText: keyword })).toHaveCount(1)
    await expect(resultTitles.filter({ hasText: 'PlainNode' })).toHaveCount(0)

    // チェック解除で本文ヒットに戻る
    await toggle.uncheck()
    await expect(resultTitles.filter({ hasText: 'PlainNode' })).toHaveCount(1)

    // ポップアップを閉じて開き直してもチェック状態が維持される
    await toggle.check()
    await page.click('.search-popup-close')
    await page.click('#tree-search-btn')
    await expect(page.locator('.search-popup-title-only-toggle')).toBeChecked()
  })

  test('TC-FUNC-080: 「id:xxxxx」検索はそのIDのノード1件だけを返し、本文ヒットを混ぜない', async ({ page }) => {
    const tree = await createTree(page, 'Id Keyword Search Tree')
    const target = await createNode(page, tree.id, 'IdTargetNode', '本文')
    await createNode(page, tree.id, 'IdReferrerNode', `参照: id:${target.id}`)
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForSelector('.tree-item', { timeout: 15000 })

    await page.click('#tree-search-btn')
    await expect(page.locator('#search-popup-modal.active')).toBeVisible()
    const resultTitles = page.locator('.search-popup-item-title')

    // id 指定：対象ノード1件だけ。本文に同じ文字列を持つノードは出ない
    await page.fill('.search-popup-input', `id:${target.id}`)
    await page.click('.search-popup-submit')
    await expect(resultTitles.filter({ hasText: 'IdTargetNode' })).toHaveCount(1)
    await expect(resultTitles.filter({ hasText: 'IdReferrerNode' })).toHaveCount(0)
    await expect(resultTitles).toHaveCount(1)

    // 他の語と一緒でも id 指定が優先される
    await page.fill('.search-popup-input', `id:${target.id} 参照`)
    await page.click('.search-popup-submit')
    await expect(resultTitles).toHaveCount(1)
    await expect(resultTitles.filter({ hasText: 'IdTargetNode' })).toHaveCount(1)

    // ツリーに無い ID は0件
    await page.fill('.search-popup-input', 'id:zzzzzz')
    await page.click('.search-popup-submit')
    await expect(page.locator('.search-popup-empty')).toBeVisible()
    await expect(resultTitles).toHaveCount(0)

    // ID だけ（id: なし）なら参照元が本文検索でヒットする
    await page.fill('.search-popup-input', target.id)
    await page.click('.search-popup-submit')
    await expect(resultTitles.filter({ hasText: 'IdReferrerNode' })).toHaveCount(1)
  })

  test('TC-FUNC-050: trash tab is icon-only with accessible title/aria-label', async ({ page }) => {
    const tree = await createTree(page, 'Trash Tab Tree')
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForSelector('.tree-item', { timeout: 15000 })

    const trashTab = page.locator('.tree-view-tab-danger')
    await expect(trashTab).toHaveAttribute('title', 'ゴミ箱')
    await expect(trashTab).toHaveAttribute('aria-label', 'ゴミ箱')
    const text = (await trashTab.innerText()).trim()
    expect(text).toBe('')

    await trashTab.click()
    await expect(trashTab).toHaveClass(/active/)
  })

  test('TC-FUNC-051: content search highlights all hits with n/m nav and clears on empty input', async ({ page }) => {
    const tree = await createTree(page, 'Content Search Tree')
    const node = await createNode(page, tree.id, 'Content Search Node', '')
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForSelector('.tree-item', { timeout: 15000 })
    await page.click('.tree-item')
    await page.waitForSelector('#content-search-input', { timeout: 10000 })

    // 入力欄の幅が260px（従来130pxの2倍）であることを確認
    const inputWidth = await page.locator('#content-search-input').evaluate(el => el.getBoundingClientRect().width)
    expect(inputWidth).toBe(260)

    const longContent = Array.from({ length: 5 }, (_, i) => `段落${i} keyword-alpha が含まれます。`).join('\n\n')
    await page.evaluate((content) => { window.currentEditor.value(content) }, longContent)
    await page.waitForTimeout(400)

    await page.fill('#content-search-input', 'keyword-alpha')
    await page.click('#content-search-btn')
    await page.waitForTimeout(200)

    await expect(page.locator('#content-search-hit-count')).toHaveText('1/5')
    await expect(page.locator('.content-search-hit-highlight')).toHaveCount(5)

    await page.click('#content-search-next-btn')
    await expect(page.locator('#content-search-hit-count')).toHaveText('2/5')

    await page.click('#content-search-prev-btn')
    await expect(page.locator('#content-search-hit-count')).toHaveText('1/5')

    await page.fill('#content-search-input', '')
    await page.waitForTimeout(100)
    await expect(page.locator('.content-search-hit-highlight')).toHaveCount(0)
  })

  test('TC-FUNC-051: content search finds a longer term after a shorter overlapping term', async ({ page }) => {
    const tree = await createTree(page, 'Content Search Term Switch Tree')
    const node = await createNode(page, tree.id, 'Content Search Term Switch Node', '| 参照 |\n| --- |\n| 資料G |')
    await addRelation(page, tree.id, tree.root_node_id, node.id)
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.locator(`.tree-item[data-node-id="${node.id}"]`).click()
    await expect(page.locator('#node-content-editor .bytemd-preview td')).toHaveText('資料G')

    await page.fill('#content-search-input', '資料')
    await page.click('#content-search-btn')
    await expect(page.locator('#content-search-hit-count')).toHaveText('1/1')

    await page.fill('#content-search-input', '資料G')
    await page.click('#content-search-btn')
    await expect(page.locator('#content-search-hit-count')).toHaveText('1/1')
    await expect(page.locator('#node-content-editor .content-search-hit-highlight')).toHaveText('資料G')

    await page.fill('#content-search-input', '資料')
    await page.click('#content-search-btn')
    await expect(page.locator('#content-search-hit-count')).toHaveText('1/1')
    await page.fill('#content-search-input', '')
    await expect(page.locator('.content-search-hit-highlight')).toHaveCount(0)
    await page.fill('#content-search-input', '資料G')
    await page.click('#content-search-btn')
    await expect(page.locator('#content-search-hit-count')).toHaveText('1/1')
  })

  test('TC-FUNC-078: CONTENTヘッダー右ボタンが狭幅ビューポートで画面内に収まる', async ({ page }) => {
    const tree = await createTree(page, 'Narrow Header Tree')
    const node = await createNode(page, tree.id, 'Narrow Header Node', '本文')
    await addRelation(page, tree.id, tree.root_node_id, node.id)

    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForSelector('.tree-item', { timeout: 15000 })
    await page.locator(`.tree-item[data-node-id="${node.id}"]`).click()
    await page.waitForSelector('#content-editor-header', { timeout: 10000 })

    // 印字ボタン（右端のボタン）がビューポート内に完全に収まっていること
    const printBtn = page.locator('#download-pdf-btn')
    await expect(printBtn).toBeVisible()
    const printInViewport = await printBtn.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return r.left >= 0 && r.right <= window.innerWidth
    })
    expect(printInViewport).toBe(true)

    // 狭幅では検索inputが260pxより縮むこと（CONTENTラベルが縮んで隠れる）
    const narrowWidth = await page.locator('#content-search-input').evaluate((el) => el.getBoundingClientRect().width)
    expect(narrowWidth).toBeLessThan(260)

    // 広幅に戻すとinputは260pxを維持すること
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.waitForTimeout(200)
    const wideWidth = await page.locator('#content-search-input').evaluate((el) => el.getBoundingClientRect().width)
    expect(wideWidth).toBe(260)
  })

  test('TC-FUNC-054: node detailで履歴をpreviewして版指定復元できる', async ({ page }) => {
    const tree = await createTree(page, 'Content History Tree')
    const node = await createNode(page, tree.id, 'History Node', 'V0')
    await addRelation(page, tree.id, tree.root_node_id, node.id)
    const initial = await (await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}`)).json()
    const firstSave = await page.request.put(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}`, {
      data: { content: 'V1', version: initial.data.version }
    })
    expect(firstSave.ok()).toBe(true)
    const firstSaved = await firstSave.json()
    const secondSave = await page.request.put(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}`, {
      data: { content: 'V2', version: firstSaved.data.version }
    })
    expect(secondSave.ok()).toBe(true)

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await page.waitForSelector('#node-detail-btn', { timeout: 10000 })
    await expect(page.locator('#undo-node-btn')).toHaveCount(0)
    await expect(page.locator('#editor-node-meta')).toHaveCount(0)
    const detailPlacement = await page.evaluate(() => {
      const id = document.querySelector('#node-detail-btn')?.previousElementSibling
      const detail = document.getElementById('node-detail-btn')
      const trash = document.getElementById('delete-node-btn')
      return id?.textContent.includes('id:') && detail?.nextElementSibling === trash
    })
    expect(detailPlacement).toBe(true)

    const historyRequests = []
    page.on('request', request => {
      if (request.url().includes(`/nodes/${node.id}/history`)) historyRequests.push(request.url())
    })
    await page.locator('#node-detail-btn').click()
    await expect(page.locator('#node-detail-dialog')).toBeVisible()
    // 現在行 + snapshot 2件
    await expect(page.locator('#node-detail-history-list .node-detail-history-row')).toHaveCount(3)
    expect(historyRequests.some(url => url.endsWith('/history?limit=100'))).toBe(true)
    const rows = page.locator('#node-detail-history-list .node-detail-history-row')
    // 初期選択は現在行（現在の content = V2）。「戻す」は現在行では無効
    await expect(rows.first()).toHaveAttribute('aria-selected', 'true')
    await expect(rows.first()).toHaveAttribute('data-is-current', 'true')
    await expect(page.locator('#node-detail-preview')).toHaveText('V2')
    await expect(page.locator('#node-detail-restore-btn')).toBeDisabled()
    await page.screenshot({ path: 'tests/test-results/node-detail-initial.png', fullPage: true })

    // 最古の snapshot（V0）を選んで戻す
    await rows.nth(2).click()
    await expect(page.locator('#node-detail-preview')).toHaveText('V0')
    await expect(page.locator('#node-detail-restore-btn')).toBeEnabled()
    await page.screenshot({ path: 'tests/test-results/node-detail-selected-version.png', fullPage: true })
    const selectedVersion = Number(await rows.nth(2).getAttribute('data-node-version'))
    page.once('dialog', dialog => dialog.accept())
    await page.locator('#node-detail-restore-btn').click()
    await expect(page.locator('#node-detail-dialog')).toBeHidden()
    await expect.poll(async () => page.evaluate(() => window.currentEditor?.value())).toBe('V0')
    await page.screenshot({ path: 'tests/test-results/node-detail-restored.png', fullPage: true })

    const stale = await page.request.post(
      `${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/history/${selectedVersion}/restore`,
      { data: { if_version: 1 } }
    )
    expect(stale.status()).toBe(409)
    const staleData = await stale.json()
    expect(staleData).toMatchObject({ success: false, error: 'Version conflict' })
    expect(typeof staleData.current_version).toBe('number')
    expect(staleData.server_data).toMatchObject({ id: node.id, content: 'V0', version: staleData.current_version })
  })
  test('TC-FUNC-055: 履歴一覧の更新者client_nameが属性を注入できない', async ({ page }) => {
    // client_name は OAuth の
    // 動的クライアント登録でクライアントが自己申告する文字列なので、
    // ダブルクォートを含む名前で title 属性を抜け出せないことを確認する。
    // escapeHtml（textContent→innerHTML）は & < > しかエスケープせず " は残るため、
    // HTML 文字列に補間する実装だと注入できてしまう。
    const evilName = 'Evil" onmouseover="window.__xssFired = true'
    const tree = await createTree(page, 'Undo XSS Tree')
    const node = await createNode(page, tree.id, 'XSS Node', 'before')
    await addRelation(page, tree.id, tree.root_node_id, node.id)

    const issued = await issueMcpAuth(page, tree.id, 'full_access', { client_name: evilName })
    const before = await (await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}`)).json()
    const rpc = await callMcpWithBearer(page, tree.id, issued.key, {
      jsonrpc: '2.0', id: 'xss-update', method: 'tools/call',
      params: { name: 'update_node', arguments: { node_id: node.id, content: 'after', if_version: before.data.version } },
    })
    expect(rpc.ok()).toBeTruthy()

    const history = await (await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/history?limit=100`)).json()
    // content を書き換えた MCP クライアントは現在行の更新者になる（authored_at の設計上、
    // v1 snapshot の「書いた人」はノード作成者＝REST 経由で client_name を持たない）
    expect(history.current.actor.client_name).toBe(evilName)

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await page.waitForSelector('#node-detail-btn', { timeout: 10000 })
    await page.locator('#node-detail-btn').click()
    // 先頭は現在行。client_name を持つのはこの行（MCPで content を書き換えたため）
    const actorCell = page.locator('#node-detail-history-list .node-detail-history-row').nth(0).locator('span').nth(1)
    await expect(actorCell).toContainText(evilName)

    // 属性が注入されていないこと
    expect(await actorCell.getAttribute('onmouseover')).toBeNull()
    // title には生の名前がそのまま入っていること（エスケープで壊れていない）
    expect(await actorCell.getAttribute('title')).toContain(evilName)
    // hover しても注入コードが動かないこと
    await actorCell.hover()
    expect(await page.evaluate(() => window.__xssFired)).toBeUndefined()
  })
})
