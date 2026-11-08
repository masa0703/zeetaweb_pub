// @ts-check
import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

/**
 * テストスイート: 2026-02-06 TODO項目
 *
 * テスト対象:
 * 1. 招待フロー改善（リダイレクト）
 * 2. 作成者フィールド（ドロップダウン、編集権限者のみ）
 * 3. 新規ノード作成時のデフォルト作成者
 * 4. 保存ショートカット
 * 5. タイトル入力欄のフォントサイズ
 */

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

async function createNode(page, treeId, nodeData) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes`, {
    data: nodeData
  })
  const data = await response.json()
  return data.data
}

async function addRelationAPI(page, treeId, parentId, childId) {
  await page.request.post(`${BASE_URL}/api/trees/${treeId}/relations`, {
    data: { parent_node_id: parentId, child_node_id: childId }
  })
}

async function sendInvitation(page, treeId, email, role) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/invitations`, {
    data: { email, role }
  })
  const data = await response.json()
  return data.data
}

async function clearTestData(page) {
  try {
    await page.request.delete(`${BASE_URL}/api/test/clear`)
  } catch (e) {
    // Ignore errors
  }
}

// ===========================
// 招待フロー改善テスト
// ===========================

test.describe('招待フローリダイレクト', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-INV-REDIRECT-001: ログインページにリダイレクトパラメータが含まれる', async ({ page }) => {
    // User1 でログインしてツリー作成と招待
    await testLogin(page, 1)
    const tree = await createTree(page, 'Redirect Test Tree')
    const invitation = await sendInvitation(page, tree.id, 'newuser@example.com', 'editor')

    // ログアウト
    await page.request.post(`${BASE_URL}/auth/logout`)

    // 招待リンクにアクセス（未ログイン）
    const invitationUrl = `${BASE_URL}/accept-invitation.html?token=${invitation.token}`
    await page.goto(invitationUrl)

    // ログインページにリダイレクトされることを確認
    await page.waitForURL(/\/login(?:\.html)?(?:[?#]|$)/)
    expect(new URL(page.url()).pathname).toMatch(/^\/login(?:\.html)?$/)

    // URLにredirectパラメータが含まれることを確認
    const url = new URL(page.url())
    const redirectParam = url.searchParams.get('redirect')
    expect(redirectParam).toBeTruthy()
    expect(redirectParam).toMatch(/\/accept-invitation(?:\.html)?\?token=/)
    expect(redirectParam).toContain(invitation.token)

    console.log('✅ TC-INV-REDIRECT-001: Login page contains redirect parameter')
  })
})

// ===========================
// 作成者フィールドテスト
// ===========================

test.describe('作成者フィールド', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-AUTHOR-001: 作成者情報が現在のノード編集UIに表示される', async ({ page }) => {
    // User1 でログイン
    await testLogin(page, 1)
    const tree = await createTree(page, 'Author Test Tree')
    const node = await createNode(page, tree.id, {
      title: 'Test Node',
      content: 'Test content',
      author_user_id: 1
    })
    await addRelationAPI(page, tree.id, tree.root_node_id, node.id)

    // エディタページにアクセス
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForSelector('.tree-item')

    // ノードをクリック
    await page.click(`.tree-item[data-node-id="${node.id}"]`)
    await page.locator('#node-author').waitFor({ state: 'attached' })

    // 作成者IDは保存用のhidden inputとして保持される
    const authorField = page.locator('#node-author')
    await expect(authorField).toHaveAttribute('type', 'hidden')
    await expect(authorField).toHaveValue('1')

    // 画面上では、作成者・作成日・更新日は node detail ダイアログに表示される
    const membersRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/members`)
    const membersData = await membersRes.json()
    const currentAuthor = membersData.data.find(m => m.user_id === node.author_user_id)
    expect(currentAuthor).toBeTruthy()
    const currentAuthorName = currentAuthor.display_name || currentAuthor.email
    await page.locator('#node-detail-btn').click()
    await expect(page.locator('#node-detail-dialog')).toBeVisible()
    await expect(page.locator('#node-detail-author')).toHaveText(currentAuthorName)

    console.log('✅ TC-AUTHOR-001: Current author metadata is displayed')
  })

  test('TC-AUTHOR-002: 作成者情報に閲覧者が表示されない', async ({ page, browser }) => {
    // User1 (オーナー) でツリー作成
    await testLogin(page, 1)
    const tree = await createTree(page, 'Members Test Tree')

    // User2 を編集者として追加
    const ctx2 = await browser.newContext()
    const page2 = await ctx2.newPage()
    await testLogin(page2, 2)
    await page.request.post(`${BASE_URL}/api/trees/${tree.id}/members`, {
      data: { user_id: 2, role: 'editor' }
    })

    // User3 を閲覧者として追加
    const ctx3 = await browser.newContext()
    const page3 = await ctx3.newPage()
    await testLogin(page3, 3)
    await page.request.post(`${BASE_URL}/api/trees/${tree.id}/members`, {
      data: { user_id: 3, role: 'viewer' }
    })

    // ノード作成
    const node = await createNode(page, tree.id, {
      title: 'Test Node',
      content: '',
      author_user_id: 1
    })
    await addRelationAPI(page, tree.id, tree.root_node_id, node.id)

    // エディタページにアクセス
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForSelector('.tree-item')

    // ノードをクリック
    await page.click(`.tree-item[data-node-id="${node.id}"]`)
    await page.locator('#node-author').waitFor({ state: 'attached' })

    // メンバー一覧を取得して確認
    const membersRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/members`)
    const membersData = await membersRes.json()
    const viewers = membersData.data.filter(m => m.role === 'viewer')
    const currentAuthor = membersData.data.find(m => m.user_id === node.author_user_id)
    const currentAuthorName = currentAuthor.display_name || currentAuthor.email

    // 現行UIでは作成者を選択するのではなく、現在の作成者を表示する
    const authorField = page.locator('#node-author')
    await expect(authorField).toHaveAttribute('type', 'hidden')
    await expect(authorField).toHaveValue(String(node.author_user_id))
    await page.locator('#node-detail-btn').click()
    await expect(page.locator('#node-detail-dialog')).toBeVisible()
    const authorMeta = page.locator('#node-detail-dialog')
    await expect(page.locator('#node-detail-author')).toHaveText(currentAuthorName)

    // 閲覧者は作成者表示に現れない
    const authorMetaText = await authorMeta.textContent()
    for (const viewer of viewers) {
      const viewerName = viewer.display_name || viewer.email
      expect(authorMetaText).not.toContain(viewerName)
    }

    await ctx2.close()
    await ctx3.close()

    console.log('✅ TC-AUTHOR-002: Current author metadata excludes viewers')
  })
})

// ===========================
// デフォルト作成者テスト
// ===========================

test.describe('デフォルト作成者', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-AUTHOR-DEFAULT-001: ルートノード作成時にログインユーザーがデフォルト作成者', async ({ page }) => {
    await testLogin(page, 1)
    const tree = await createTree(page, 'Default Author Test')

    // エディタページにアクセス
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForLoadState('networkidle')

    // ログインユーザー情報を取得
    const meRes = await page.request.get(`${BASE_URL}/auth/me`)
    const meData = await meRes.json()

    // "(new)" ノードを選択して兄弟追加でルートレベルにノード作成
    await page.waitForSelector('.tree-item')
    await page.locator('.tree-item').first().click({ force: true })
    await page.waitForTimeout(300)
    await page.keyboard.press('Alt+Shift+N')

    // カスタムプロンプトモーダルが表示されるのを待つ
    await page.waitForSelector('#custom-prompt-modal .prompt-input', { state: 'visible' })

    // プロンプトメッセージを確認（タイトル入力のみ、作成者入力なし）
    const promptMessage = await page.textContent('#custom-prompt-modal .prompt-message')
    expect(promptMessage).toContain('タイトル')
    expect(promptMessage).not.toContain('作成者')

    // タイトルを入力してOKをクリック
    await page.fill('#custom-prompt-modal .prompt-input', 'New Root Node')
    await page.click('#custom-prompt-modal .prompt-ok')

    // 作成されたノードを確認
    await page.waitForSelector('.tree-item')
    const nodesRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes`)
    const nodesData = await nodesRes.json()
    const newNode = nodesData.data.find(n => n.title === 'New Root Node')

    expect(newNode).toBeTruthy()
    expect(newNode.author_user_id).toBe(meData.data.id)

    console.log('✅ TC-AUTHOR-DEFAULT-001: Root node uses logged-in user as default author')
  })

  test('TC-AUTHOR-DEFAULT-002: 子ノード作成時にログインユーザーがデフォルト作成者', async ({ page }) => {
    await testLogin(page, 1)
    const tree = await createTree(page, 'Child Node Author Test')
    const parentNode = await createNode(page, tree.id, {
      title: 'Parent Node',
      content: '',
      author_user_id: 1
    })
    await addRelationAPI(page, tree.id, tree.root_node_id, parentNode.id)

    // エディタページにアクセス
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForSelector('.tree-item')

    // ログインユーザー情報を取得
    const meRes = await page.request.get(`${BASE_URL}/auth/me`)
    const meData = await meRes.json()

    // 子ノード追加ボタンをクリック
    await page.click(`.add-child-btn[data-node-id="${parentNode.id}"]`)
    await page.click('#node-context-menu [data-action="add-child"]')

    // カスタムプロンプトモーダルが表示されるのを待つ
    await page.waitForSelector('#custom-prompt-modal .prompt-input', { state: 'visible' })

    // プロンプトメッセージを確認（作成者入力なし）
    const promptMessage = await page.textContent('#custom-prompt-modal .prompt-message')
    expect(promptMessage).not.toContain('作成者')

    // タイトルを入力してOKをクリック
    await page.fill('#custom-prompt-modal .prompt-input', 'New Child Node')
    await page.click('#custom-prompt-modal .prompt-ok')

    // 作成されたノードを確認
    await page.waitForTimeout(1000)
    const nodesRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes`)
    const nodesData = await nodesRes.json()
    const childNode = nodesData.data.find(n => n.title === 'New Child Node')

    expect(childNode).toBeTruthy()
    expect(childNode.author_user_id).toBe(meData.data.id)

    console.log('✅ TC-AUTHOR-DEFAULT-002: Child node uses logged-in user as default author')
  })
})

// ===========================
// 保存ショートカットテスト
// ===========================

test.describe('保存ショートカット', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-SHORTCUT-001: Cmd/Ctrl+Enterで保存できる', async ({ page }) => {
    await testLogin(page, 1)
    const tree = await createTree(page, 'Shortcut Test Tree')
    const node = await createNode(page, tree.id, {
      title: 'Original Title',
      content: '',
      author_user_id: 1
    })
    await addRelationAPI(page, tree.id, tree.root_node_id, node.id)

    // エディタページにアクセス
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForSelector('.tree-item')

    // ノードをクリック
    await page.click(`.tree-item[data-node-id="${node.id}"]`)
    await page.waitForSelector('#node-title')

    // タイトルを編集
    await page.fill('#node-title', 'Updated Title')

    // Cmd+Enter または Ctrl+Enter を押下
    const isMac = process.platform === 'darwin'
    await page.keyboard.press(isMac ? 'Meta+Enter' : 'Control+Enter')

    // 保存完了を待つ
    await page.waitForTimeout(1000)

    // ノードが更新されていることを確認
    const nodesRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes`)
    const nodesData = await nodesRes.json()
    const updatedNode = nodesData.data.find(n => n.id === node.id)

    expect(updatedNode.title).toBe('Updated Title')

    console.log('✅ TC-SHORTCUT-001: Save shortcut works')
  })

  test('TC-SHORTCUT-002: 保存ボタンにツールチップが表示される', async ({ page }) => {
    await testLogin(page, 1)
    const tree = await createTree(page, 'Tooltip Test Tree')
    const node = await createNode(page, tree.id, {
      title: 'Test Node',
      content: '',
      author_user_id: 1
    })
    await addRelationAPI(page, tree.id, tree.root_node_id, node.id)

    // エディタページにアクセス
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForSelector('.tree-item')

    // ノードをクリック
    await page.click(`.tree-item[data-node-id="${node.id}"]`)
    await page.waitForSelector('#save-node-btn')

    // 保存ボタンのtitle属性を確認
    const title = await page.$eval('#save-node-btn', btn => btn.getAttribute('title'))
    expect(title).toBeTruthy()
    expect(title).toContain('保存')
    expect(title).toMatch(/⌘|Ctrl|cmd/)
    expect(title).toMatch(/Enter|enter/)

    console.log('✅ TC-SHORTCUT-002: Save button has tooltip with shortcut info')
  })
})

// ===========================
// UIテスト
// ===========================

test.describe('UI改善', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-UI-TITLE-001: タイトル入力欄が現行のコンパクトなスタイルで表示される', async ({ page }) => {
    await testLogin(page, 1)
    const tree = await createTree(page, 'UI Test Tree')
    const node = await createNode(page, tree.id, {
      title: 'Test Node',
      content: '',
      author_user_id: 1
    })
    await addRelationAPI(page, tree.id, tree.root_node_id, node.id)

    // エディタページにアクセス
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForSelector('.tree-item')

    // ノードをクリック
    await page.click(`.tree-item[data-node-id="${node.id}"]`)
    await page.waitForSelector('#node-title')

    // 現行UIではタイトル入力欄は本文より控えめな text-sm スタイル
    const titleInput = page.locator('#node-title')
    await expect(titleInput).toHaveClass(/\btext-sm\b/)

    // クラス名だけでなく、ブラウザが適用した実際のフォントサイズを確認
    const fontSize = await titleInput.evaluate(el => window.getComputedStyle(el).fontSize)
    const fontSizePx = parseFloat(fontSize)
    expect(fontSizePx).toBe(14) // text-sm = 0.875rem = 14px

    console.log('✅ TC-UI-TITLE-001: Title input uses the current compact style')
  })
})

// ===========================
// テストスイート終了
// ===========================

console.log('✅ TODO 2026-02-06 Tests: 8 test cases')
