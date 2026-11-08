import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'
import { issueMcpAuth, callMcpWithBearer } from './helpers/mcp-oauth.js'

const BASE_URL = 'http://localhost:3000'

async function login(page, userId) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
}

async function createTree(page, name) {
  const response = await page.request.post(`${BASE_URL}/api/trees`, { data: { name } })
  expect(response.ok()).toBe(true)
  return (await response.json()).data
}

async function createNode(page, treeId, rootId, title, content) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes`, {
    data: { title, content, author_user_id: 1 }
  })
  expect(response.ok()).toBe(true)
  const node = (await response.json()).data
  const relation = await page.request.post(`${BASE_URL}/api/trees/${treeId}/relations`, {
    data: { parent_node_id: rootId, child_node_id: node.id }
  })
  expect(relation.ok()).toBe(true)
  return node
}

async function saveContent(page, treeId, nodeId, content) {
  const current = await (await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes/${nodeId}`)).json()
  const response = await page.request.put(`${BASE_URL}/api/trees/${treeId}/nodes/${nodeId}`, {
    data: { content, version: current.data.version }
  })
  expect(response.ok()).toBe(true)
  return (await response.json()).data
}

test.describe('Node detail content history', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.delete(`${BASE_URL}/api/test/clear`)
    await login(page, 1)
  })

  test('409では復元を再試行せず、本文と履歴を最新化する', async ({ page }) => {
    const tree = await createTree(page, 'History conflict tree')
    const node = await createNode(page, tree.id, tree.root_node_id, 'Conflict node', 'before')
    await saveContent(page, tree.id, node.id, 'saved')

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await page.waitForSelector('#node-detail-btn', { timeout: 15000 })
    await page.locator('#node-detail-btn').click()
    // 初期選択は現在行。preview には現在の content（saved）が出る
    await expect(page.locator('#node-detail-preview')).toHaveText('saved')
    // 「戻す」対象に snapshot 行（v1 = before）を選び直す
    await page.locator('.node-detail-history-row[data-node-version="1"]').click()
    await expect(page.locator('#node-detail-preview')).toHaveText('before')

    let restoreRequests = 0
    await page.route(`**/api/trees/${tree.id}/nodes/${node.id}/history/*/restore`, async route => {
      restoreRequests += 1
      if (restoreRequests === 1) await saveContent(page, tree.id, node.id, 'concurrent update')
      await route.continue()
    })
    page.once('dialog', dialog => dialog.accept())
    await page.locator('#node-detail-restore-btn').click()

    await expect(page.locator('.toast-message').last()).toContainText('他の場所で更新されました。最新の状態を読み込みます')
    await expect.poll(async () => page.evaluate(() => window.currentEditor?.value())).toBe('concurrent update')
    await expect(page.locator('#node-detail-dialog')).toBeVisible()
    await expect(page.locator('#node-detail-history-list .node-detail-history-row').first()).toHaveAttribute('aria-selected', 'true')
    // 再読込後の初期選択も現在行。preview は裏更新後の現在内容
    await expect(page.locator('#node-detail-preview')).toHaveText('concurrent update')
    expect(restoreRequests).toBe(1)
    await page.screenshot({ path: 'tests/test-results/node-detail-409.png', fullPage: true })

    const current = await (await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}`)).json()
    expect(current.data.content).toBe('concurrent update')
  })

  test('viewerはdetailを開閉できるが「戻す」は表示されずRESTも403', async ({ page }) => {
    const tree = await createTree(page, 'History viewer tree')
    const node = await createNode(page, tree.id, tree.root_node_id, 'Viewer node', 'before')
    await saveContent(page, tree.id, node.id, 'after')
    const ownerHistory = await (await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/history?limit=100`)).json()

    await login(page, 2)
    await login(page, 1)
    const member = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/members`, {
      data: { user_id: 2, role: 'viewer' }
    })
    expect(member.ok()).toBe(true)
    await login(page, 2)

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await page.waitForSelector('#node-detail-btn', { timeout: 15000 })
    await page.locator('#node-detail-btn').click()
    await expect(page.locator('#node-detail-dialog')).toBeVisible()
    // 初期選択は現在行。preview には現在の content（after）が出る
    await expect(page.locator('#node-detail-preview')).toHaveText('after')
    await expect(page.locator('#node-detail-restore-btn')).toBeHidden()
    // viewer でも copy button は使える（「戻す」と違い権限で隠さない）
    await expect(page.locator('#node-detail-copy-btn')).toBeVisible()
    await expect(page.locator('#node-detail-copy-btn')).toBeEnabled()
    await page.screenshot({ path: 'tests/test-results/node-detail-viewer.png', fullPage: true })

    const forbidden = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/restore`, {
      data: { node_version: ownerHistory.items[0].node_version, if_version: ownerHistory.current_version }
    })
    expect(forbidden.status()).toBe(403)

    await page.keyboard.press('Escape')
    await expect(page.locator('#node-detail-dialog')).toBeHidden()
  })

  test('履歴が多いとき一覧だけがスクロールし、見出しと「戻す」は動かない', async ({ page }) => {
    const tree = await createTree(page, 'History scroll tree')
    const node = await createNode(page, tree.id, tree.root_node_id, 'Scroll node', 'V0')
    for (let i = 1; i <= 15; i++) {
      await saveContent(page, tree.id, node.id, `V${i}`)
    }

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await page.waitForSelector('#node-detail-btn', { timeout: 15000 })
    await page.locator('#node-detail-btn').click()
    await page.waitForSelector('.node-detail-history-row[data-node-version]')

    const before = await page.evaluate(() => {
      const list = document.getElementById('node-detail-history-list')
      const panel = document.getElementById('node-detail-dialog-panel')
      return {
        rows: document.querySelectorAll('.node-detail-history-row[data-node-version]').length,
        // 一覧の中身がはみ出していて、一覧自身がスクロールできる
        listScrollable: list.scrollHeight > list.clientHeight + 1,
        // ダイアログ本体はスクロールしない（見出しや「戻す」が流れない）
        panelScrollable: panel.scrollHeight > panel.clientHeight + 1,
        headTop: document.querySelector('.node-detail-history-item[aria-hidden="true"]').getBoundingClientRect().top,
        restoreTop: document.getElementById('node-detail-restore-btn').getBoundingClientRect().top
      }
    })
    // snapshot 15件 + 現在行1行
    expect(before.rows).toBe(16)
    expect(before.listScrollable).toBe(true)
    expect(before.panelScrollable).toBe(false)

    const after = await page.evaluate(async () => {
      const list = document.getElementById('node-detail-history-list')
      list.scrollTop = list.scrollHeight
      await new Promise(resolve => setTimeout(resolve, 200))
      return {
        scrollTop: Math.round(list.scrollTop),
        headTop: document.querySelector('.node-detail-history-item[aria-hidden="true"]').getBoundingClientRect().top,
        restoreTop: document.getElementById('node-detail-restore-btn').getBoundingClientRect().top
      }
    })
    expect(after.scrollTop).toBeGreaterThan(0)
    // 列見出しと「戻す」はスクロールしても動かない
    expect(Math.abs(after.headTop - before.headTop)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.restoreTop - before.restoreTop)).toBeLessThanOrEqual(1)
  })

  test('背景クリックでは閉じず、×とEscapeでは閉じる', async ({ page }) => {
    const tree = await createTree(page, 'Dialog close tree')
    const node = await createNode(page, tree.id, tree.root_node_id, 'Close node', 'V0')
    await saveContent(page, tree.id, node.id, 'V1')

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await page.waitForSelector('#node-detail-btn', { timeout: 15000 })
    const dialog = page.locator('#node-detail-dialog')

    await page.locator('#node-detail-btn').click()
    await page.waitForSelector('.node-detail-history-row[data-node-version]')

    // 背景（オーバーレイ）をクリックしても閉じない。選択と preview をやり直させないため
    const panel = await page.locator('#node-detail-dialog-panel').boundingBox()
    await page.mouse.click(Math.max(4, panel.x / 2), panel.y / 2)
    await expect(dialog).toBeVisible()

    // ダイアログの外（ツリーペイン側）をクリックしても閉じない
    await page.mouse.click(60, 600)
    await expect(dialog).toBeVisible()

    // Escape では閉じる
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // × でも閉じる
    await page.locator('#node-detail-btn').click()
    await page.waitForSelector('.node-detail-history-row[data-node-version]')
    await page.locator('#node-detail-dialog-close').click()
    await expect(dialog).toBeHidden()
  })

  test('content復元はゴミ箱復元と別URLで、ゴミ箱復元は従来どおり動く', async ({ page }) => {
    const tree = await createTree(page, 'Trash restore compatibility tree')
    const node = await createNode(page, tree.id, tree.root_node_id, 'Trash node', 'content')
    const removed = await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}`)
    expect(removed.ok()).toBe(true)

    const restored = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/restore`)
    expect(restored.ok()).toBe(true)
    expect(await restored.json()).toMatchObject({ success: true, message: 'Node restored', node_id: node.id })

    // content 復元は別パス。if_version を欠いた呼び出しがゴミ箱復元に化けないこと
    const missingIfVersion = await page.request.post(
      `${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/history/1/restore`,
      { data: {} }
    )
    expect(missingIfVersion.status()).toBe(400)
  })

  test('新規作成直後でも現在の状態が履歴に表示され「content履歴はありません」が出ない', async ({ page }) => {
    const tree = await createTree(page, 'History fresh tree')
    const node = await createNode(page, tree.id, tree.root_node_id, 'Fresh node', 'first content')

    // REST: snapshot 0件でも現在状態（current）を返す
    const history = await (await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/history?limit=100`)).json()
    expect(history.items).toHaveLength(0)
    expect(history.current.version).toBe(node.version)
    expect(history.current.updated_at).toBeTruthy()
    expect(history.current.actor.display_name).toBeTruthy()

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await page.waitForSelector('#node-detail-btn', { timeout: 15000 })
    await page.locator('#node-detail-btn').click()

    const currentRow = page.locator('.node-detail-history-row[data-is-current="true"]')
    await expect(currentRow).toHaveCount(1)
    await expect(currentRow).toHaveAttribute('aria-selected', 'true')
    await expect(currentRow.locator('.font-bold')).toHaveCount(2)
    await expect(currentRow.locator('.node-detail-current-badge')).toHaveCount(0)
    await expect(page.locator('#node-detail-history-list')).not.toContainText('content履歴はありません')
    // 最初に登録した content がそのまま表示される
    await expect(page.locator('#node-detail-preview')).toHaveText('first content')
    // 現在行選択中は「戻す」は無効
    await expect(page.locator('#node-detail-restore-btn')).toBeDisabled()
  })

  test('履歴ありノードでは現在行が先頭で、snapshot行は従来どおり選択できる', async ({ page }) => {
    const tree = await createTree(page, 'History current row tree')
    const node = await createNode(page, tree.id, tree.root_node_id, 'Current row node', 'v1 content')
    await saveContent(page, tree.id, node.id, 'v2 content')

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await page.waitForSelector('#node-detail-btn', { timeout: 15000 })
    await page.locator('#node-detail-btn').click()

    const rows = page.locator('#node-detail-history-list .node-detail-history-row[data-node-version]')
    await expect(rows).toHaveCount(2)
    const currentRow = page.locator('.node-detail-history-row[data-is-current="true"]')
    await expect(currentRow).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('#node-detail-preview')).toHaveText('v2 content')
    await expect(page.locator('#node-detail-restore-btn')).toBeDisabled()

    // snapshot 行（v1）に切り替えると有効化
    await page.locator('.node-detail-history-row[data-node-version="1"]').click()
    await expect(page.locator('#node-detail-preview')).toHaveText('v1 content')
    await expect(page.locator('#node-detail-restore-btn')).toBeEnabled()
  })

  test('preview の copy button が表示中の content をクリップボードへコピーする', async ({ page }) => {
    const tree = await createTree(page, 'History copy tree')
    const node = await createNode(page, tree.id, tree.root_node_id, 'Copy node', 'before')
    await saveContent(page, tree.id, node.id, 'after')

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL })

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await page.waitForSelector('#node-detail-btn', { timeout: 15000 })
    await page.locator('#node-detail-btn').click()

    const copyBtn = page.locator('#node-detail-copy-btn')
    await expect(copyBtn).toBeVisible()
    // editor の copy button と同じ SVG icon を持つ
    await expect(copyBtn.locator('svg')).toBeVisible()

    // 初期選択（現在行）の内容がコピーされる
    await expect(page.locator('#node-detail-preview')).toHaveText('after')
    await copyBtn.click()
    await expect(page.locator('.toast-message').last()).toContainText('コピーしました')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('after')

    // snapshot 行を選び直すとその版がコピーされる
    await page.locator('.node-detail-history-row[data-node-version="1"]').click()
    await expect(page.locator('#node-detail-preview')).toHaveText('before')
    await copyBtn.click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('before')
  })

  test('履歴比較: ラジオ選択後にオーバーレイに +/- 差分が出る', async ({ page }) => {
    const tree = await createTree(page, 'History compare tree')
    const node = await createNode(page, tree.id, tree.root_node_id, 'Compare node', 'line1\nline2\nline3')
    await saveContent(page, tree.id, node.id, 'line1\nlineX\nline3')

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await page.waitForSelector('#node-detail-btn', { timeout: 15000 })
    await page.locator('#node-detail-btn').click()
    await page.waitForSelector('.node-detail-history-row[data-node-version]')

    // 各行の左端にラジオがある。選択行（初期は現在行）だけ disabled
    const radios = page.locator('#node-detail-history-list input[name="node-detail-compare"]')
    await expect(radios).toHaveCount(2)
    await expect(radios.nth(0)).toBeDisabled()
    // 初期状態ではラジオは未選択で「比較」は無効。ツールチップで使い方を示す
    await expect(radios.nth(1)).not.toBeChecked()
    await expect(page.locator('#node-detail-compare-btn')).toBeDisabled()
    await expect(radios.nth(1)).toHaveAttribute('title', '比較対象を選択してください')
    // ラジオを選ぶと比較相手が確定し「比較」が有効になる
    await radios.nth(1).click()
    await expect(radios.nth(1)).toBeChecked()
    await expect(radios.nth(1)).toBeEnabled()
    await expect(page.locator('#node-detail-compare-btn')).toBeEnabled()

    const overlay = page.locator('#node-compare-overlay')
    await page.locator('#node-detail-compare-btn').click()
    await expect(overlay).toBeVisible()
    // 向きは常に古い→新しい。旧/新ラベルに版日時と更新者が出る
    await expect(page.locator('#node-compare-old-label')).not.toBeEmpty()
    await expect(page.locator('#node-compare-new-label')).not.toBeEmpty()
    // v1→current の行単位ユニファイド差分
    await expect(overlay.locator('.node-compare-diff-line')).toHaveText(['line1', 'line2', 'lineX', 'line3'])
    await expect(overlay.locator('.node-compare-diff-line.removed')).toHaveText(['line2'])
    await expect(overlay.locator('.node-compare-diff-line.added')).toHaveText(['lineX'])
    await page.screenshot({ path: 'tests/test-results/node-detail-compare.png', fullPage: true })

    // × でオーバーレイだけが閉じる。ラジオ選択は保持され再表示できる
    await page.locator('#node-compare-close').click()
    await expect(overlay).toBeHidden()
    await expect(page.locator('#node-detail-dialog')).toBeVisible()
    await expect(radios.nth(1)).toBeChecked()
    await expect(page.locator('#node-detail-compare-btn')).toBeEnabled()
    await page.locator('#node-detail-compare-btn').click()
    await expect(overlay).toBeVisible()

    // Escape ではオーバーレイだけが閉じ、次の Escape で node detail が閉じる
    await page.keyboard.press('Escape')
    await expect(overlay).toBeHidden()
    await expect(page.locator('#node-detail-dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#node-detail-dialog')).toBeHidden()
  })

  test('履歴比較: 右端の帯が差分位置を示し、目盛クリックで該当ブロックへ移動する', async ({ page }) => {
    const tree = await createTree(page, 'History compare strip tree')
    // 長い共通行で差分ブロックを2箇所（先頭の変更と末尾の追加）に離す
    const filler = Array.from({ length: 60 }, (_, i) => `common line ${i + 1}`).join('\n')
    const node = await createNode(page, tree.id, tree.root_node_id, 'Compare strip node', `top-a\ntop-b\n${filler}`)
    await saveContent(page, tree.id, node.id, `top-x\ntop-b\n${filler}\nbottom-new`)

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await page.waitForSelector('#node-detail-btn', { timeout: 15000 })
    await page.locator('#node-detail-btn').click()
    await page.waitForSelector('.node-detail-history-row[data-node-version]')
    await page.locator('#node-detail-history-list input[name="node-detail-compare"]').nth(1).click()
    await page.locator('#node-detail-compare-btn').click()

    const overlay = page.locator('#node-compare-overlay')
    await expect(overlay).toBeVisible()
    // 先頭の変更（削除+追加で1ブロック）と末尾の追加で、目盛は2個
    const ticks = overlay.locator('.node-compare-tick')
    await expect(ticks).toHaveCount(2)
    // 目盛は帯の中に収まる
    const stripBox = await overlay.locator('#node-compare-diff-strip').boundingBox()
    for (let i = 0; i < 2; i++) {
      const box = await ticks.nth(i).boundingBox()
      expect(box.y).toBeGreaterThanOrEqual(stripBox.y)
      expect(box.y + box.height).toBeLessThanOrEqual(stripBox.y + stripBox.height + 0.5)
    }
    // 下側の目盛クリックで末尾の追加ブロックへスクロールし、一瞬ハイライトが出る
    await ticks.nth(1).click()
    await expect.poll(() => overlay.locator('#node-compare-diff').evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    await expect(overlay.locator('.node-compare-diff-hunk.is-flash')).toHaveCount(1)
    // 目盛にホバーすると、対応する本文側ブロックが強調される
    await ticks.nth(0).hover()
    await expect(overlay.locator('.node-compare-diff-hunk.is-hover')).toHaveCount(1)
  })

  test('履歴比較: 行選択とラジオは独立し、行が1件なら比較できない', async ({ page }) => {
    const tree = await createTree(page, 'History compare radio tree')
    const node = await createNode(page, tree.id, tree.root_node_id, 'Radio node', 'v1')
    await saveContent(page, tree.id, node.id, 'v2')

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await page.waitForSelector('#node-detail-btn', { timeout: 15000 })
    await page.locator('#node-detail-btn').click()
    await page.waitForSelector('.node-detail-history-row[data-node-version]')

    const radios = page.locator('#node-detail-history-list input[name="node-detail-compare"]')
    const compareBtn = page.locator('#node-detail-compare-btn')
    await expect(radios.nth(0)).toBeDisabled()
    // 初期状態はラジオ未選択・比較無効
    await expect(radios.nth(1)).not.toBeChecked()
    await expect(compareBtn).toBeDisabled()

    // ラジオで比較相手を選ぶ
    await radios.nth(1).click()
    await expect(radios.nth(1)).toBeChecked()
    await expect(compareBtn).toBeEnabled()

    // 比較相手だった v1 を行クリックで選択すると、比較対象がなくなり「比較」は無効
    await page.locator('.node-detail-history-row[data-node-version="1"]').click()
    await expect(page.locator('#node-detail-preview')).toHaveText('v1')
    await expect(radios.nth(1)).toBeDisabled()
    await expect(radios.nth(1)).not.toBeChecked()
    await expect(radios.nth(0)).toBeEnabled()
    await expect(compareBtn).toBeDisabled()

    // 比較相手を現在行にすると復活。選択 v1 → 相手 current の差分
    await radios.nth(0).click()
    await expect(radios.nth(0)).toBeChecked()
    await expect(compareBtn).toBeEnabled()
    await compareBtn.click()
    const overlay = page.locator('#node-compare-overlay')
    await expect(overlay).toBeVisible()
    await expect(overlay.locator('.node-compare-diff-line.removed')).toHaveText(['v1'])
    await expect(overlay.locator('.node-compare-diff-line.added')).toHaveText(['v2'])
    await page.keyboard.press('Escape')
    await expect(overlay).toBeHidden()

    // snapshot が無い（行が1行だけの）ノードでは比較不可
    const fresh = await createNode(page, tree.id, tree.root_node_id, 'Fresh radio node', 'only')
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${fresh.id}`)
    await page.waitForSelector('#node-detail-btn', { timeout: 15000 })
    await page.locator('#node-detail-btn').click()
    await page.waitForSelector('.node-detail-history-row[data-node-version]')
    await expect(page.locator('#node-detail-history-list input[name="node-detail-compare"]')).toBeDisabled()
    await expect(compareBtn).toBeDisabled()
  })

  test('viewer でも履歴比較は使える（「戻す」は引き続き非表示）', async ({ page }) => {
    const tree = await createTree(page, 'History compare viewer tree')
    const node = await createNode(page, tree.id, tree.root_node_id, 'Compare viewer node', 'before')
    await saveContent(page, tree.id, node.id, 'after')

    await login(page, 2)
    await login(page, 1)
    const member = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/members`, {
      data: { user_id: 2, role: 'viewer' }
    })
    expect(member.ok()).toBe(true)
    await login(page, 2)

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await page.waitForSelector('#node-detail-btn', { timeout: 15000 })
    await page.locator('#node-detail-btn').click()
    await page.waitForSelector('.node-detail-history-row[data-node-version]')

    await expect(page.locator('#node-detail-restore-btn')).toBeHidden()
    const compareBtn = page.locator('#node-detail-compare-btn')
    await expect(compareBtn).toBeVisible()
    // viewer でもラジオで比較相手を選べる
    await page.locator('#node-detail-history-list input[name="node-detail-compare"]').nth(1).click()
    await expect(compareBtn).toBeEnabled()
    await compareBtn.click()
    const overlay = page.locator('#node-compare-overlay')
    await expect(overlay).toBeVisible()
    await expect(overlay.locator('.node-compare-diff-line.removed')).toHaveText(['before'])
    await expect(overlay.locator('.node-compare-diff-line.added')).toHaveText(['after'])
  })

  test('TC-FUNC-073: 履歴行の日時は「その内容が書かれた日時」を表し、先頭2行が同一時刻にならない', async ({ page }) => {
    const tree = await createTree(page, 'History authored-at tree')
    const node = await createNode(page, tree.id, tree.root_node_id, 'Authored-at node', 'v0')
    await saveContent(page, tree.id, node.id, 'v1')
    // SQLite の CURRENT_TIMESTAMP は秒精度のため、2つの更新が別の値になるよう間隔を空ける
    await new Promise(resolve => setTimeout(resolve, 1100))
    await saveContent(page, tree.id, node.id, 'v2')

    const history = await (await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/history?limit=100`)).json()
    // 修正前は current.updated_at（直近の更新日時）と items[0].replaced_at（同じ更新でv1が
    // 置き換えられた日時）が常に同一イベントを指し、先頭2行が同じ時刻になっていた。
    // 修正後、items[0].authored_at は「v1 が書かれた日時」＝1つ前の更新の日時になる
    expect(history.items[0].authored_at).not.toBe(history.current.updated_at)
    const toMs = (sqliteTimestamp) => new Date(`${sqliteTimestamp.replace(' ', 'T')}Z`).getTime()
    expect(toMs(history.items[0].authored_at)).toBeLessThan(toMs(history.current.updated_at))

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await page.waitForSelector('#node-detail-btn', { timeout: 15000 })
    await page.locator('#node-detail-btn').click()
    await page.waitForSelector('.node-detail-history-row[data-node-version]')
    const dateCells = page.locator('#node-detail-history-list .node-detail-history-row span').first()
    await expect(dateCells).not.toHaveText('')
  })

  test('TC-FUNC-074: 内容が変わらない更新でも、node detail と履歴の現在行にMCPクライアント名が表示される', async ({ page }) => {
    const tree = await createTree(page, 'History current client tree')
    const node = await createNode(page, tree.id, tree.root_node_id, 'Current client node', 'unchanged content')

    const auth = await issueMcpAuth(page, tree.id, 'full_access', { client_name: 'Zeeta MCP CLI Proxy' })
    const before = await (await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}`)).json()
    const historyBefore = await (await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/history?limit=100`)).json()

    // content を渡さずタイトルだけ変える = 内容が変わらない更新（snapshotは積まれない）
    const rpc = await callMcpWithBearer(page, tree.id, auth.key, {
      jsonrpc: '2.0', id: 'title-only-update', method: 'tools/call',
      params: { name: 'update_node', arguments: { node_id: node.id, title: 'Renamed via MCP', if_version: before.data.version } },
    })
    expect(rpc.ok()).toBeTruthy()

    const historyAfter = await (await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/history?limit=100`)).json()
    // snapshot は増えない（content不変）が、現在行にはMCPクライアント名が付く
    expect(historyAfter.total).toBe(historyBefore.total)
    expect(historyAfter.current.actor.client_name).toBe('Zeeta MCP CLI Proxy')

    const nodeAfter = await (await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}`)).json()
    expect(nodeAfter.data.updated_by_client_name).toBe('Zeeta MCP CLI Proxy')

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await page.waitForSelector('#node-detail-btn', { timeout: 15000 })
    await page.locator('#node-detail-btn').click()
    await page.waitForSelector('.node-detail-history-row[data-node-version]')

    await expect(page.locator('#node-detail-updated-by')).toContainText('Zeeta MCP CLI Proxy')
    const currentRow = page.locator('.node-detail-history-row[data-is-current="true"]')
    await expect(currentRow).toContainText('Zeeta MCP CLI Proxy')
  })
})
