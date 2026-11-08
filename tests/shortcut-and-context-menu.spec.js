import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

const BASE_URL = 'http://localhost:3000'

// ===========================
// ヘルパー関数
// ===========================

async function testLogin(page, userId) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`)
  await waitForAppReady(page)
}

async function createTree(page, name) {
  const response = await page.request.post(`${BASE_URL}/api/trees`, {
    data: { name, description: 'Test tree' }
  })
  const data = await response.json()
  return data.data
}

async function createNodeAPI(page, treeId, nodeData) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes`, {
    data: nodeData
  })
  const data = await response.json()
  return data.data
}

async function addRelationAPI(page, treeId, parentId, childId) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/relations`, {
    data: { parent_node_id: parentId, child_node_id: childId }
  })
  const data = await response.json()
  return data
}

async function uploadNodeImageAPI(page, treeId, nodeId, fileName, mimeType, buffer) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes/${nodeId}/images`, {
    multipart: {
      file: {
        name: fileName,
        mimeType,
        buffer
      }
    }
  })
  const data = await response.json()
  return { response, data }
}

async function clearTestData(page) {
  try {
    await page.request.delete(`${BASE_URL}/api/test/clear`)
  } catch (e) {
    // Ignore errors
  }
}

/** トップレベルノードをUIで追加（初回は "(new)" をリネーム、以降は兄弟追加） */
async function addRootNodeViaUI(page, title) {
  const items = page.locator('.tree-item')
  const count = await items.count()

  if (count >= 1) {
    const firstText = await items.first().locator('.truncate').textContent()
    if (firstText?.trim() === '(new)') {
      // 自動生成された "(new)" ノードをリネーム
      await items.first().click({ force: true })
      await page.waitForTimeout(300)
      await page.fill('#node-title', title)
      await page.click('#save-node-btn')
      await page.waitForTimeout(1000)
      return
    }
  }

  // 兄弟追加 (Alt+Shift+N) でトップレベルノードを作成
  await items.first().click({ force: true })
  await page.waitForTimeout(300)
  await page.keyboard.press('Alt+Shift+N')
  await page.waitForSelector('#custom-prompt-modal .prompt-input', { state: 'visible' })
  await page.fill('#custom-prompt-modal .prompt-input', title)
  await page.click('#custom-prompt-modal .prompt-ok')
  await page.waitForSelector('.tree-item', { timeout: 5000 })
  await page.waitForTimeout(500)
}

async function fillPromptAndConfirm(page, title) {
  await page.waitForSelector('#custom-prompt-modal .prompt-input', { state: 'visible' })
  await page.fill('#custom-prompt-modal .prompt-input', title)
  await page.click('#custom-prompt-modal .prompt-ok')
  await page.waitForTimeout(1000)
}

async function openNodeContextMenu(page, nodeTitle) {
  const node = page.locator(`.tree-item:has-text("${nodeTitle}")`).first()
  await node.locator('.add-child-btn').click()
  const menu = page.locator('#node-context-menu')
  await expect(menu).toBeVisible()
  return menu
}

async function openContextSortMenu(page, nodeTitle) {
  const menu = await openNodeContextMenu(page, nodeTitle)
  await menu.locator('.context-submenu-trigger').filter({ hasText: 'ソート' }).hover()
  return menu
}

async function applySortFromContextMenu(page, nodeTitle, modeLabel, directionLabel) {
  let menu = await openContextSortMenu(page, nodeTitle)
  await menu.locator('.context-submenu .context-menu-item').filter({ hasText: modeLabel }).click()
  await page.waitForTimeout(500)
  if (directionLabel) {
    menu = await openContextSortMenu(page, nodeTitle)
    await menu.locator('.context-submenu .context-menu-item').filter({ hasText: directionLabel }).click()
    await page.waitForTimeout(500)
  }
}

async function ensureNodeExpanded(page, nodeTitle) {
  const node = page.locator(`.tree-item:has-text("${nodeTitle}")`).first()
  const expandButton = node.locator('button[aria-label="子ノードを展開する"]')
  if (await expandButton.isVisible()) {
    await expandButton.click()
    await page.waitForTimeout(300)
  }
}

async function openNormalMenu(page) {
  await page.click('#normal-view-tab')
  const menu = page.locator('#normal-view-menu')
  await expect(menu).toBeVisible()
  return menu
}

/** ツリー上のノード表示順（テキスト配列）を取得 */
async function getTreeNodeOrder(page, containerSelector = '#tree-container') {
  return page.$$eval(
    `${containerSelector} > [data-node-group] > .tree-item`,
    items => items.map(el => el.querySelector('.truncate')?.textContent?.trim())
  )
}

// ===========================
// テストケース
// ===========================

test.describe('ショートカット・コンテキストメニュー', () => {
  let treeId
  let rootNodeId

  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
    await testLogin(page, 1)
    const tree = await createTree(page, 'Shortcut Test Tree')
    treeId = tree.id
    rootNodeId = tree.root_node_id
    await page.goto(`${BASE_URL}/index.html?tree=${treeId}`)
    await page.waitForLoadState('networkidle')
  })

  // --- 子ノード作成後の選択状態 ---
  test('TC-SHORT-001: 子ノード作成後、作成したノードがツリー上で選択状態になる', async ({ page }) => {
    await addRootNodeViaUI(page, '親ノード')
    await page.click('.tree-item:has-text("親ノード")')
    await page.waitForTimeout(500)

    // UIから子ノード追加
    const addChildBtn = page.locator('.tree-item:has-text("親ノード")').locator('.add-child-btn').first()
    await addChildBtn.click()
    await page.click('#node-context-menu [data-action="add-child"]')
    await fillPromptAndConfirm(page, '子ノードA')

    // 子ノードがアクティブ（選択状態）であること
    const activeItem = page.locator('.tree-item.active')
    await expect(activeItem).toBeVisible()
    const activeTitle = await activeItem.locator('.truncate').textContent()
    expect(activeTitle.trim()).toBe('子ノードA')

    // 右ペインのタイトルも確認
    await expect(page.locator('#node-title')).toHaveValue('子ノードA')
    console.log('✅ TC-SHORT-001: 子ノード作成後に選択状態になる')
  })

  // --- Alt+N: 子ノード作成ショートカット ---
  test('TC-SHORT-002: Alt+N で子ノードが作成される', async ({ page }) => {
    await addRootNodeViaUI(page, 'ルートA')
    await page.click('.tree-item:has-text("ルートA")')
    await page.waitForTimeout(500)

    // Alt+N を押す
    await page.keyboard.press('Alt+n')

    // プロンプトモーダルが表示される
    await page.waitForSelector('#custom-prompt-modal .prompt-input', { state: 'visible', timeout: 3000 })
    await fillPromptAndConfirm(page, 'ショートカット子')

    // ツリーに子ノードが表示されること
    await expect(page.locator('.tree-item:has-text("ショートカット子")')).toBeVisible()
    console.log('✅ TC-SHORT-002: Alt+N で子ノードが作成される')
  })

  test('TC-SHORT-003: ノード未選択時に Alt+N は何も起きない', async ({ page }) => {
    // ノードが無い状態で Alt+N
    await page.keyboard.press('Alt+n')
    await page.waitForTimeout(500)

    // プロンプトモーダルが表示されないこと
    const modal = page.locator('#custom-prompt-modal')
    const isVisible = await modal.isVisible().catch(() => false)
    expect(isVisible).toBeFalsy()
    console.log('✅ TC-SHORT-003: ノード未選択時にAlt+Nは何も起きない')
  })

  // --- Alt+Shift+N: 兄弟ノード作成ショートカット ---
  test('TC-SHORT-004: Alt+Shift+N で兄弟ノードが作成される（ルートレベル）', async ({ page }) => {
    await addRootNodeViaUI(page, 'ルート1')
    await page.click('.tree-item:has-text("ルート1")')
    await page.waitForTimeout(500)

    // Alt+Shift+N を押す
    await page.keyboard.press('Alt+Shift+N')

    await page.waitForSelector('#custom-prompt-modal .prompt-input', { state: 'visible', timeout: 3000 })
    await fillPromptAndConfirm(page, 'ルート兄弟')

    // ルートレベルに新ノードが追加される
    await expect(page.locator('.tree-item:has-text("ルート兄弟")')).toBeVisible()
    console.log('✅ TC-SHORT-004: Alt+Shift+N でルートレベルの兄弟ノードが作成される')
  })

  test('TC-SHORT-005: 子ノード選択時に Alt+Shift+N で同じ親の兄弟が作成される', async ({ page }) => {
    // APIでルート + 子を作成
    const root = await createNodeAPI(page, treeId, {
      title: '親', content: '', author_user_id: 1
    })
    await addRelationAPI(page, treeId, rootNodeId, root.id)
    const child = await createNodeAPI(page, treeId, {
      title: '子A', content: '', author_user_id: 1
    })
    await addRelationAPI(page, treeId, root.id, child.id)

    await page.reload()
    await page.waitForSelector('.tree-item')

    // 親を展開して子を選択
    const toggle = page.locator(`.tree-item[data-node-id="${root.id}"] .toggle-icon`)
    if (await toggle.isVisible()) {
      await toggle.click()
      await page.waitForTimeout(300)
    }
    await page.click(`.tree-item[data-node-id="${child.id}"]`)
    await page.waitForTimeout(500)

    // Alt+Shift+N
    await page.keyboard.press('Alt+Shift+N')
    await page.waitForSelector('#custom-prompt-modal .prompt-input', { state: 'visible', timeout: 3000 })
    await fillPromptAndConfirm(page, '子B')

    // 同じ親の下に兄弟ノードが追加されること
    await expect(page.locator('.tree-item:has-text("子B")')).toBeVisible()
    console.log('✅ TC-SHORT-005: 子ノード選択時にAlt+Shift+Nで兄弟が作成される')
  })

  // --- Alt+↑ / Alt+↓: ノード順移動ショートカット ---
  test('TC-SHORT-006: Alt+↓ でノードが1つ下に移動する', async ({ page }) => {
    await addRootNodeViaUI(page, 'A')
    await addRootNodeViaUI(page, 'B')
    await addRootNodeViaUI(page, 'C')

    // Aを選択
    await page.click('.tree-item:has-text("A")')
    await page.waitForTimeout(500)

    // Alt+↓
    await page.keyboard.press('Alt+ArrowDown')
    await page.waitForTimeout(1000)

    // 順序が B, A, C になること
    const order = await getTreeNodeOrder(page)
    expect(order).toEqual(['B', 'A', 'C'])
    console.log('✅ TC-SHORT-006: Alt+↓ でノードが1つ下に移動する')
  })

  test('TC-SHORT-007: Alt+↑ でノードが1つ上に移動する', async ({ page }) => {
    await addRootNodeViaUI(page, 'A')
    await addRootNodeViaUI(page, 'B')
    await addRootNodeViaUI(page, 'C')

    // Cを選択
    await page.click('.tree-item:has-text("C")')
    await page.waitForTimeout(500)

    // Alt+↑
    await page.keyboard.press('Alt+ArrowUp')
    await page.waitForTimeout(1000)

    // 順序が A, C, B になること
    const order = await getTreeNodeOrder(page)
    expect(order).toEqual(['A', 'C', 'B'])
    console.log('✅ TC-SHORT-007: Alt+↑ でノードが1つ上に移動する')
  })

  test('TC-SHORT-008: 先頭ノードで Alt+↑ は何も変わらない', async ({ page }) => {
    await addRootNodeViaUI(page, 'A')
    await addRootNodeViaUI(page, 'B')

    await page.click('.tree-item:has-text("A")')
    await page.waitForTimeout(500)

    await page.keyboard.press('Alt+ArrowUp')
    await page.waitForTimeout(1000)

    const order = await getTreeNodeOrder(page)
    expect(order).toEqual(['A', 'B'])
    console.log('✅ TC-SHORT-008: 先頭ノードでAlt+↑は何も変わらない')
  })

  test('TC-SHORT-009: 末尾ノードで Alt+↓ は何も変わらない', async ({ page }) => {
    await addRootNodeViaUI(page, 'A')
    await addRootNodeViaUI(page, 'B')

    await page.click('.tree-item:has-text("B")')
    await page.waitForTimeout(500)

    await page.keyboard.press('Alt+ArrowDown')
    await page.waitForTimeout(1000)

    const order = await getTreeNodeOrder(page)
    expect(order).toEqual(['A', 'B'])
    console.log('✅ TC-SHORT-009: 末尾ノードでAlt+↓は何も変わらない')
  })

  // --- コンテキストメニュー ---
  test('TC-SHORT-010: ノードメニューに新しい項目が表示される', async ({ page }) => {
    await addRootNodeViaUI(page, 'メニューテスト')

    // ノード右端の縦三点ボタンからメニューを開く
    const menu = await openNodeContextMenu(page, 'メニューテスト')

    // 新しい4項目が表示されること
    await expect(menu.locator('.context-menu-item').filter({ hasText: '子ノード作成' })).toBeVisible()
    await expect(menu.locator('.context-menu-item').filter({ hasText: '兄弟ノード作成' })).toBeVisible()
    await expect(menu.locator('.context-menu-item').filter({ hasText: '上に移動' })).toBeVisible()
    await expect(menu.locator('.context-menu-item').filter({ hasText: '下に移動' })).toBeVisible()
    console.log('✅ TC-SHORT-010: ノードメニューに新しい項目が表示される')
  })

  test('TC-SHORT-011: コンテキストメニューから子ノード作成', async ({ page }) => {
    await addRootNodeViaUI(page, 'メニュー親')

    // ノード右端の縦三点ボタン → 子ノード作成
    const menu = await openNodeContextMenu(page, 'メニュー親')
    await menu.locator('.context-menu-item').filter({ hasText: '子ノード作成' }).click()

    // プロンプトモーダルでタイトル入力
    await fillPromptAndConfirm(page, 'メニュー子')

    // 子ノードが作成されること
    await expect(page.locator('.tree-item:has-text("メニュー子")')).toBeVisible()
    console.log('✅ TC-SHORT-011: コンテキストメニューから子ノード作成')
  })

  test('TC-SHORT-012: コンテキストメニューから上に移動', async ({ page }) => {
    await addRootNodeViaUI(page, 'A')
    await addRootNodeViaUI(page, 'B')

    // Bの縦三点ボタン → 上に移動
    const menu = await openNodeContextMenu(page, 'B')
    await menu.locator('.context-menu-item').filter({ hasText: '上に移動' }).click()
    await page.waitForTimeout(1000)

    // 順序が B, A になること
    const order = await getTreeNodeOrder(page)
    expect(order).toEqual(['B', 'A'])
    console.log('✅ TC-SHORT-012: コンテキストメニューから上に移動')
  })

  test('TC-SHORT-013: コンテキストメニューにソート項目が表示される', async ({ page }) => {
    await addRootNodeViaUI(page, 'ソートメニュー')

    const menu = await openContextSortMenu(page, 'ソートメニュー')

    await expect(menu.locator('.context-submenu .context-menu-item').filter({ hasText: '手動（default）' })).toBeVisible()
    await expect(menu.locator('.context-submenu .context-menu-item').filter({ hasText: '作成日' })).toBeVisible()
    await expect(menu.locator('.context-submenu .context-menu-item').filter({ hasText: '更新日' })).toBeVisible()
    await expect(menu.locator('.context-submenu .context-menu-item').filter({ hasText: 'タイトル' })).toBeVisible()
    await expect(menu.locator('.context-submenu .context-menu-item').filter({ hasText: '昇順' })).toBeVisible()
    await expect(menu.locator('.context-submenu .context-menu-item').filter({ hasText: '降順' })).toBeVisible()
    console.log('✅ TC-SHORT-013: コンテキストメニューにソート項目が表示される')
  })

  test('TC-SHORT-014: タイトルソートの昇順/降順が反映される', async ({ page }) => {
    await addRootNodeViaUI(page, '親')
    await page.click('.tree-item:has-text("親")')
    await page.waitForTimeout(400)
    await page.keyboard.press('Alt+N')
    await fillPromptAndConfirm(page, 'B')
    await page.click('.tree-item:has-text("親")')
    await page.waitForTimeout(300)
    await page.keyboard.press('Alt+N')
    await fillPromptAndConfirm(page, 'C')
    await page.click('.tree-item:has-text("親")')
    await page.waitForTimeout(300)
    await page.keyboard.press('Alt+N')
    await fillPromptAndConfirm(page, 'A')

    await ensureNodeExpanded(page, '親')

    await applySortFromContextMenu(page, '親', 'タイトル', '昇順')
    let order = await getTreeNodeOrder(page, '.tree-children[data-parent]')
    expect(order).toEqual(['A', 'B', 'C'])

    await applySortFromContextMenu(page, '親', 'タイトル', '降順')
    order = await getTreeNodeOrder(page, '.tree-children[data-parent]')
    expect(order).toEqual(['C', 'B', 'A'])
    console.log('✅ TC-SHORT-014: タイトルソートの昇順/降順が反映される')
  })

  test('TC-SHORT-015: 手動以外のソートでは Alt+↑/↓ が無効', async ({ page }) => {
    await addRootNodeViaUI(page, '親')
    await page.click('.tree-item:has-text("親")')
    await page.waitForTimeout(400)
    await page.keyboard.press('Alt+N')
    await fillPromptAndConfirm(page, 'A')
    await page.click('.tree-item:has-text("親")')
    await page.waitForTimeout(300)
    await page.keyboard.press('Alt+N')
    await fillPromptAndConfirm(page, 'B')
    await page.click('.tree-item:has-text("親")')
    await page.waitForTimeout(300)
    await page.keyboard.press('Alt+N')
    await fillPromptAndConfirm(page, 'C')

    await ensureNodeExpanded(page, '親')

    await page.locator('.tree-children[data-parent] .tree-item:has-text("B"):visible').first().click()
    await page.waitForTimeout(400)
    await applySortFromContextMenu(page, '親', 'タイトル', '昇順')

    await page.keyboard.press('Alt+ArrowUp')
    await page.waitForTimeout(600)
    const orderAfterUp = await getTreeNodeOrder(page, '.tree-children[data-parent]')
    expect(orderAfterUp).toEqual(['A', 'B', 'C'])

    await page.keyboard.press('Alt+ArrowDown')
    await page.waitForTimeout(600)
    const orderAfterDown = await getTreeNodeOrder(page, '.tree-children[data-parent]')
    expect(orderAfterDown).toEqual(['A', 'B', 'C'])
    console.log('✅ TC-SHORT-015: 手動以外のソートでは Alt+↑/↓ が無効')
  })

  test('TC-SHORT-016: Alt+M でノードを複製できる', async ({ page }) => {
    await addRootNodeViaUI(page, '複製元')
    await page.locator('.tree-item:has-text("複製元")').first().click({ force: true })
    await page.waitForTimeout(400)

    const nodesRes = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes`)
    const nodesData = await nodesRes.json()
    const sourceNode = (nodesData.data || []).find(n => n.title === '複製元')
    expect(sourceNode).toBeTruthy()

    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5gS8kAAAAASUVORK5CYII=',
      'base64'
    )
    const uploadResult = await uploadNodeImageAPI(page, treeId, sourceNode.id, 'dup-test.png', 'image/png', tinyPng)
    expect(uploadResult.response.ok()).toBeTruthy()
    expect(uploadResult.data.success).toBeTruthy()
    const sourceImage = uploadResult.data.data

    const sourceNodeRes = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes/${sourceNode.id}`)
    const sourceNodeData = await sourceNodeRes.json()
    expect(sourceNodeRes.ok()).toBeTruthy()
    expect(sourceNodeData.success).toBeTruthy()

    const sourceImageUrl = sourceImage.url
    const updateSourceRes = await page.request.put(`${BASE_URL}/api/trees/${treeId}/nodes/${sourceNode.id}`, {
      data: {
        title: sourceNodeData.data.title,
        content: `画像テスト\n![dup](${sourceImageUrl})`,
        author_user_id: sourceNodeData.data.author_user_id,
        version: sourceNodeData.data.version
      }
    })
    expect(updateSourceRes.ok()).toBeTruthy()

    await page.keyboard.press('Alt+M')
    await page.waitForTimeout(1000)

    await expect(page.locator('.tree-item:has-text("複製元のコピー")').first()).toBeVisible()

    const duplicatedNodesRes = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes`)
    const duplicatedNodesData = await duplicatedNodesRes.json()
    const duplicatedNode = (duplicatedNodesData.data || []).find(n => n.title === '複製元のコピー')
    expect(duplicatedNode).toBeTruthy()

    const duplicatedImagesRes = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes/${duplicatedNode.id}/images`)
    const duplicatedImagesData = await duplicatedImagesRes.json()
    expect(duplicatedImagesRes.ok()).toBeTruthy()
    expect(duplicatedImagesData.success).toBeTruthy()
    expect(Array.isArray(duplicatedImagesData.data)).toBeTruthy()
    expect(duplicatedImagesData.data.length).toBe(1)
    expect(String(duplicatedImagesData.data[0].url)).toContain(`/nodes/${duplicatedNode.id}/images/`)

    const duplicatedNodeRes = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes/${duplicatedNode.id}`)
    const duplicatedNodeData = await duplicatedNodeRes.json()
    expect(duplicatedNodeRes.ok()).toBeTruthy()
    expect(duplicatedNodeData.success).toBeTruthy()
    const duplicatedContent = String(duplicatedNodeData.data.content || '')
    const duplicatedImageUrl = duplicatedContent.match(/!\[[^\]]*\]\(([^)]+)\)/)?.[1]
    // 現行duplicate APIは本文Markdownの置換先だけ内部整数node IDを生成する。
    // 画像実体は公開IDで返る画像一覧APIから検証し、本文は現行の置換結果を確認する。
    expect(duplicatedImageUrl).toMatch(
      new RegExp(`/api/trees/${treeId}/nodes/\\d+/images/${duplicatedImagesData.data[0].id}/file$`)
    )
    expect(duplicatedContent).not.toContain(`/nodes/${sourceNode.id}/images/`)

    const deleteSourceImageRes = await page.request.delete(
      `${BASE_URL}/api/trees/${treeId}/nodes/${sourceNode.id}/images/${sourceImage.id}`
    )
    expect(deleteSourceImageRes.ok()).toBeTruthy()

    const duplicatedImageFileRes = await page.request.get(duplicatedImagesData.data[0].url)
    expect(duplicatedImageFileRes.ok()).toBeTruthy()

    await page.locator('.tree-item:has-text("複製元のコピー")').first().click({ force: true })
    await page.waitForTimeout(600)
    await expect(page.locator('#node-image-list .node-image-icon-item')).toHaveCount(1)
    console.log('✅ TC-SHORT-016: Alt+M でノードを複製できる')
  })

  test('TC-SHORT-017: 通常▼メニューからrootソート（タイトル昇順）が反映される', async ({ page }) => {
    await addRootNodeViaUI(page, 'B')
    await addRootNodeViaUI(page, 'C')
    await addRootNodeViaUI(page, 'A')

    const menu = await openNormalMenu(page)
    await menu.locator('.normal-menu-item').filter({ hasText: 'タイトル' }).click()
    await page.waitForTimeout(300)
    await expect(menu).toBeVisible()

    await menu.locator('.normal-menu-item').filter({ hasText: '昇順' }).click()
    await expect.poll(() => getTreeNodeOrder(page)).toEqual(['A', 'B', 'C'])
    console.log('✅ TC-SHORT-017: 通常▼メニューからrootソート（タイトル昇順）が反映される')
  })
})
