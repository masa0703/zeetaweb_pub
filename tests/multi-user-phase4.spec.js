import { test, expect } from '@playwright/test'
import { waitForAppReady, createTreeViaUi, openTreeByName, drawerRow, openTreeDrawer } from './helpers/app.js'

/**
 * Phase 4 E2E Tests - Multi-User Features
 *
 * Test Coverage:
 * 1. Authentication Flow
 * 2. Tree Management
 * 3. Node Operations
 * 4. Permissions
 * 5. Tree Isolation
 */

// Test helper functions
async function testLogin(page, userId = 1) {
  // Clear cookies and storage before login to ensure clean state
  await page.context().clearCookies()
  await page.goto(`/auth/test-login?user_id=${userId}`)
  await waitForAppReady(page)
}

async function clearTestData(page) {
  await page.request.delete('/api/test/clear')
}

// 左バーから作成し、作成したツリーの編集画面へ移る
async function createTestTree(page, name = 'Test Tree', description = 'Test Description') {
  return createTreeViaUi(page, name, description)
}

// ===========================================
// 1. Authentication Flow Tests
// ===========================================

test.describe('Authentication Flow', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-AUTH-001: Unauthenticated user redirect to login', async ({ page }) => {
    await page.goto(`/index.html`)

    // Should redirect to login page
    await page.waitForURL(/\/login(?:\.html)?(?:[?#]|$)/, { timeout: 3000 })
    expect(new URL(page.url()).pathname).toMatch(/^\/login(?:\.html)?$/)
  })

  test('TC-AUTH-002: Login and land on the editor', async ({ page }) => {
    await testLogin(page, 1)

    // マイページ廃止後は編集画面に着地する
    expect(new URL(page.url()).pathname).toBe('/index.html')

    // ログイン中であること（ヘッダーにログアウトがある）。ユーザー名はヘッダーに出さない
    await expect(page.locator('#logout-btn')).toBeVisible()
  })

  test('TC-AUTH-003: Session persistence after page reload', async ({ page }) => {
    await testLogin(page, 1)

    // Reload page
    await page.reload()

    // Should still be on the editor (not redirected to login)
    await waitForAppReady(page)
    expect(new URL(page.url()).pathname).toBe('/index.html')
  })

  test('TC-AUTH-004: Logout functionality', async ({ page }) => {
    await testLogin(page, 1)

    // Click logout button
    await page.click('#logout-btn')

    // Should redirect to login page
    await page.waitForURL(/\/login(?:\.html)?(?:[?#]|$)/)
    expect(new URL(page.url()).pathname).toMatch(/^\/login(?:\.html)?$/)

    // Try to access the editor again
    await page.goto(`/index.html`)

    // Should be redirected to login
    await page.waitForURL(/\/login(?:\.html)?(?:[?#]|$)/)
    expect(new URL(page.url()).pathname).toMatch(/^\/login(?:\.html)?$/)
  })
})

// ===========================================
// 2. Tree Management Tests
// ===========================================

test.describe('Tree Management', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
    await testLogin(page, 1)
  })

  test('TC-TREE-001: Create a new tree', async ({ page }) => {
    await createTestTree(page, 'テストプロジェクト', 'テスト用のプロジェクトです')

    // Verify tree appears in My Trees section of the left bar
    await openTreeDrawer(page)
    const treeRow = page.locator('#tree-drawer .tree-drawer-row', { hasText: 'テストプロジェクト' })
    await expect(treeRow).toBeVisible()

    // Verify owner badge is displayed
    await expect(page.locator('#tree-header')).toContainText('オーナー')
  })

  test('TC-TREE-002: Display tree list', async ({ page }) => {
    // Create a tree
    await createTestTree(page, 'マイツリー1')

    // Reload to verify persistence
    await page.reload()
    await waitForAppReady(page)

    // Verify tree is displayed in My Trees section
    await openTreeDrawer(page)
    await expect(page.locator('#tree-drawer .tree-drawer-row', { hasText: 'マイツリー1' })).toBeVisible()
  })

  test('TC-TREE-004: Clear a tree description with null', async ({ page }) => {
    const created = await page.request.post('http://localhost:3000/api/trees', {
      data: { name: '説明クリア', description: '消される説明' }
    })
    const tree = (await created.json()).data

    const updated = await page.request.put(`http://localhost:3000/api/trees/${tree.id}`, {
      data: { description: null }
    })

    expect(updated.status()).toBe(200)
    expect((await updated.json()).data.description).toBeNull()
  })

  test('TC-TREE-003: Access tree editor', async ({ page }) => {
    // Create a tree, then open another tree and come back from the left bar
    await createTestTree(page, 'エディタテスト')
    await createTestTree(page, '別のツリー')
    await openTreeByName(page, 'エディタテスト')
    expect(page.url()).toMatch(/tree=\d+/)

    // Tree header should display tree name
    await expect(page.locator('#tree-header')).toContainText('エディタテスト')
    await expect(page.locator('#tree-header')).toContainText('オーナー')
  })
})

// ===========================================
// 3. Node Operations Tests
// ===========================================

test.describe('Node Operations', () => {
  let treeId

  test.beforeEach(async ({ page, context }) => {
    await clearTestData(page)
    await testLogin(page, 1)

    // Create a test tree (作成すると編集画面へ移る)
    treeId = String(await createTestTree(page, 'ノードテスト'))
  })

  test('TC-NODE-001: Create a node', async ({ page }) => {
    // "(new)" ノードを選択して兄弟追加でノード作成
    await page.waitForSelector('.tree-item')
    await page.locator('.tree-item').first().click({ force: true })
    await page.waitForTimeout(300)
    await page.keyboard.press('Alt+Shift+N')

    // カスタムプロンプトモーダルが表示されるのを待つ
    await page.waitForSelector('#custom-prompt-modal .prompt-input', { state: 'visible' })
    await page.fill('#custom-prompt-modal .prompt-input', 'テストノード')
    await page.click('#custom-prompt-modal .prompt-ok')

    // Wait for node to be created
    await page.waitForSelector('.tree-item:has-text("テストノード")', { timeout: 5000 })

    // Verify node appears in tree view
    await expect(page.locator('.tree-item:has-text("テストノード")')).toBeVisible()
  })

  test('TC-NODE-002: Edit a node', async ({ page }) => {
    // "(new)" ノードを選択して兄弟追加でノード作成
    await page.waitForSelector('.tree-item')
    await page.locator('.tree-item').first().click({ force: true })
    await page.waitForTimeout(300)
    await page.keyboard.press('Alt+Shift+N')
    await page.waitForSelector('#custom-prompt-modal .prompt-input', { state: 'visible' })
    await page.fill('#custom-prompt-modal .prompt-input', '編集テスト')
    await page.click('#custom-prompt-modal .prompt-ok')
    await page.waitForSelector('.tree-item:has-text("編集テスト")', { timeout: 5000 })

    // Select the node
    await page.click('.tree-item:has-text("編集テスト")')
    await page.waitForTimeout(1000)

    // Edit title
    await page.fill('#node-title', '更新されたタイトル')

    // Click save button
    await page.click('#save-node-btn')
    await page.waitForTimeout(1000)

    // Verify updated title in tree view
    await expect(page.locator('.tree-item:has-text("更新されたタイトル")')).toBeVisible()
  })

  test('TC-NODE-003: Delete a node', async ({ page }) => {
    // confirm ダイアログは native なので dialog handler で処理
    page.on('dialog', async dialog => {
      if (dialog.type() === 'confirm') {
        await dialog.accept()
      }
    })

    // "(new)" ノードを選択して兄弟追加でノード作成
    await page.waitForSelector('.tree-item')
    await page.locator('.tree-item').first().click({ force: true })
    await page.waitForTimeout(300)
    await page.keyboard.press('Alt+Shift+N')
    await page.waitForSelector('#custom-prompt-modal .prompt-input', { state: 'visible' })
    await page.fill('#custom-prompt-modal .prompt-input', '削除テスト')
    await page.click('#custom-prompt-modal .prompt-ok')
    await page.waitForSelector('.tree-item:has-text("削除テスト")', { timeout: 5000 })

    // Select the node
    await page.click('.tree-item:has-text("削除テスト")')
    await page.waitForTimeout(1000)

    // Delete node
    await page.click('#delete-node-btn')
    await page.waitForTimeout(2000)

    // Verify node is removed from tree view
    await expect(page.locator('.tree-item:has-text("削除テスト")')).not.toBeVisible()
  })
})

// ===========================================
// 4. Permission Tests
// ===========================================

test.describe('Permissions', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-PERM-001: Owner has full access', async ({ page }) => {
    // Login as owner (user 1)
    await testLogin(page, 1)

    // Create a tree
    // 作成すると編集画面へ移る
    await createTestTree(page, 'オーナーテスト')

    // Verify owner badge is displayed
    await expect(page.locator('#tree-header')).toContainText('オーナー')

    // Verify edit controls are enabled (ノードを選択して確認)
    await page.waitForSelector('.tree-item')
    await page.locator('.tree-item').first().click({ force: true })
    await page.waitForTimeout(500)
    await expect(page.locator('#save-node-btn')).toBeEnabled()
  })

  test('TC-PERM-003: Viewer has read-only access', async ({ page, context }) => {
    // Login as owner and create a tree
    await testLogin(page, 1)
    const treeId = await createTestTree(page, '閲覧者テスト')

    // Login as user 2 to create user record (testLogin handles session switch)
    await testLogin(page, 2)

    // Login back as owner
    await testLogin(page, 1)

    // Add user 2 as viewer via API
    const addMemberResponse = await page.request.post(`/api/trees/${treeId}/members`, {
      data: {
        user_id: 2,
        role: 'viewer'
      }
    })

    // Check if member was added successfully
    expect(addMemberResponse.status()).toBe(200)
    const addMemberData = await addMemberResponse.json()
    expect(addMemberData.success).toBe(true)

    // Login as viewer (user 2)
    await testLogin(page, 2)

    // Navigate to the shared tree
    await page.goto(`/index.html?tree=${treeId}`)

    // Wait for tree header to be populated
    await page.waitForFunction(() => {
      const header = document.getElementById('tree-header')
      return header && header.innerHTML.trim() !== ''
    }, { timeout: 10000 })

    // Verify viewer badge is displayed
    await expect(page.locator('#tree-header')).toContainText('閲覧者')
    await expect(page.locator('#tree-header')).toContainText('閲覧専用')

    // Verify edit controls are disabled (ノードを選択して確認)
    await page.waitForSelector('.tree-item')
    await page.locator('.tree-item').first().click({ force: true })
    await page.waitForTimeout(500)
    await expect(page.locator('#save-node-btn')).toBeDisabled()
  })

  test('TC-PERM-004: Viewer API edit attempt is rejected', async ({ page }) => {
    // Login as owner and create a tree
    await testLogin(page, 1)
    const treeId = await createTestTree(page, 'API権限テスト')

    // Login as user 2 to create user record (testLogin handles session switch)
    await testLogin(page, 2)

    // Login back as owner
    await testLogin(page, 1)

    // Add user 2 as viewer
    const addResponse = await page.request.post(`/api/trees/${treeId}/members`, {
      data: {
        user_id: 2,
        role: 'viewer'
      }
    })

    // Check if member was added successfully
    expect(addResponse.status()).toBe(200)
    const addData = await addResponse.json()
    expect(addData.success).toBe(true)

    // Login as viewer
    await testLogin(page, 2)

    // Try to create a node via API
    const createResponse = await page.request.post(`/api/trees/${treeId}/nodes`, {
      data: {
        title: '不正ノード',
        content: 'テスト',
        author_user_id: 2
      }
    })

    // Should be rejected with 403
    expect(createResponse.status()).toBe(403)
    const createData = await createResponse.json()
    expect(createData.error).toContain('permission')
  })
})

// ===========================================
// 5. Tree Isolation Tests
// ===========================================

test.describe('Tree Isolation', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-ISOL-003: Access denied to non-member tree', async ({ page }) => {
    // Login as user 1 and create a tree
    await testLogin(page, 1)
    const treeId = await createTestTree(page, 'プライベートツリー')

    // Login as user 2 (testLogin handles session switch)
    await testLogin(page, 2)

    // Try to access user 1's tree
    await page.goto(`/index.html?tree=${treeId}`)

    // エラーを出し、user 2 は他にツリーが無いので作成を促す空画面になる
    await waitForAppReady(page)
    await expect(page.locator('.toast').first()).toBeVisible()
    expect(new URL(page.url()).searchParams.get('tree')).not.toBe(String(treeId))
    await expect(page.locator('#tree-empty-state')).toBeVisible()
  })

  test('TC-ISOL-002: Cannot create cross-tree parent-child relation', async ({ page }) => {
    // Login and create two trees
    await testLogin(page, 1)

    await createTestTree(page, 'ツリーA')
    await createTestTree(page, 'ツリーB')

    // Get both tree IDs by switching trees from the left bar
    const treeAId = String(await openTreeByName(page, 'ツリーA'))
    const treeBId = String(await openTreeByName(page, 'ツリーB'))

    // Create a node in tree A
    const nodeAResponse = await page.request.post(`/api/trees/${treeAId}/nodes`, {
      data: {
        title: 'ノードA',
        content: 'ツリーAのノード',
        author_user_id: 1
      }
    })
    const nodeAData = await nodeAResponse.json()
    const nodeAId = nodeAData.data.id

    // Create a node in tree B
    const nodeBResponse = await page.request.post(`/api/trees/${treeBId}/nodes`, {
      data: {
        title: 'ノードB',
        content: 'ツリーBのノード',
        author_user_id: 1
      }
    })
    const nodeBData = await nodeBResponse.json()
    const nodeBId = nodeBData.data.id

    // Try to create cross-tree relation
    const relationResponse = await page.request.post(`/api/trees/${treeAId}/relations`, {
      data: {
        parent_node_id: nodeAId,
        child_node_id: nodeBId
      }
    })

    // The current public-ID resolver scopes both IDs to tree A. A node from
    // tree B is therefore rejected as not found before same-tree validation.
    expect(relationResponse.status()).toBe(404)
    const data = await relationResponse.json()
    expect(data.error).toBe('Parent or child node not found')
  })
})
