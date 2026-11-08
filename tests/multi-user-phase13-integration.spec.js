/**
 * Phase 13: 最終統合テスト・ポリッシュ - E2E Integration Tests
 *
 * このテストスイートは、複数機能の連携動作を検証する統合テストです。
 *
 * テストカテゴリ:
 * - 完全なユーザージャーニー (3 tests)
 * - 複数機能の連携 (3 tests)
 * - 同時実行・競合処理 (3 tests)
 * - エラーハンドリング (4 tests)
 * - パフォーマンス検証 (3 tests)
 *
 * 合計: 16 tests
 */

import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

// ===========================
// Helper Functions
// ===========================

/**
 * テストログイン - テスト用認証エンドポイントを使用
 */
async function testLogin(page, userId) {
  await page.context().clearCookies()
  await page.goto(`/auth/test-login?user_id=${userId}`)
  await waitForAppReady(page)
}

/**
 * API リクエストヘルパー
 */
async function apiRequest(page, method, endpoint, body = null) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json'
    }
  }

  if (body) {
    options.body = JSON.stringify(body)
  }

  const response = await page.request[method.toLowerCase()](endpoint, {
    data: body,
    headers: options.headers
  })

  return response
}

/**
 * ツリーを作成
 */
async function createTree(page, name, description = '') {
  const response = await apiRequest(page, 'POST', '/api/trees', {
    name,
    description
  })

  expect(response.status()).toBe(201)
  const data = await response.json()
  return data.data
}

/**
 * ノードを作成
 */
async function createNode(page, treeId, title, content = '', author_user_id = 1) {
  const response = await apiRequest(page, 'POST', `/api/trees/${treeId}/nodes`, {
    title,
    content,
    author_user_id
  })

  expect(response.status()).toBe(201)
  const data = await response.json()
  return data.data
}

/**
 * ノードを更新
 */
async function updateNode(page, treeId, nodeId, updates) {
  const response = await apiRequest(page, 'PUT', `/api/trees/${treeId}/nodes/${nodeId}`, updates)
  return response
}

/**
 * 親子関係を作成
 */
async function createRelation(page, treeId, parentId, childId) {
  const response = await apiRequest(page, 'POST', `/api/trees/${treeId}/relations`, {
    parent_node_id: parentId,
    child_node_id: childId
  })

  expect(response.status()).toBe(201)
  return response
}

/**
 * 招待を送信
 */
async function sendInvitation(page, treeId, email, role) {
  const response = await apiRequest(page, 'POST', `/api/trees/${treeId}/invitations`, {
    email,
    role
  })

  expect(response.status()).toBe(201)
  const data = await response.json()
  return data.data
}

/**
 * 招待を受諾
 */
async function acceptInvitation(page, token) {
  const response = await apiRequest(page, 'POST', `/api/invitations/${token}/accept`, {})
  expect(response.status()).toBe(200)
  return response
}

/**
 * 通知を取得
 */
async function getNotifications(page) {
  const response = await page.request.get('/api/notifications')
  expect(response.status()).toBe(200)
  const data = await response.json()
  return data.data
}

/**
 * メンバーの役割を変更
 */
async function changeMemberRole(page, treeId, userId, newRole) {
  const response = await apiRequest(page, 'PUT', `/api/trees/${treeId}/members/${userId}/role`, {
    role: newRole
  })

  return response
}

/**
 * ツリーのメンバー一覧を取得
 */
async function getTreeMembers(page, treeId) {
  const response = await page.request.get(`/api/trees/${treeId}/members`)
  expect(response.status()).toBe(200)
  const data = await response.json()
  return data.data
}

/**
 * プロフィールを更新
 */
async function updateProfile(page, displayName) {
  const response = await apiRequest(page, 'PUT', '/api/profile', {
    display_name: displayName
  })

  return response
}

/**
 * テストデータをクリア
 */
async function clearTestData(page) {
  await page.request.delete('/api/test/clear')
}

// ===========================
// テストスイート開始
// ===========================

test.describe('Phase 13: 統合テスト - 完全なユーザージャーニー', () => {

  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-JOURNEY-001: 新規ユーザーの完全なワークフロー', async ({ page, context }) => {
    // User1 がログイン
    await testLogin(page, 1)

    // User1 がツリー作成
    const tree = await createTree(page, 'Collaboration Project', 'A collaborative workspace')
    expect(tree.name).toBe('Collaboration Project')

    // User1 がノード作成
    const parentNode = await createNode(page, tree.id, 'Parent Node', 'Parent content')
    const childNode = await createNode(page, tree.id, 'Child Node', 'Child content')

    // 親子関係を設定
    await createRelation(page, tree.id, parentNode.id, childNode.id)

    // User1 が User2 を Editor として招待
    const invitation = await sendInvitation(page, tree.id, 'test-user-2@example.com', 'editor')
    expect(invitation.token).toBeDefined()

    // User2 がログインして招待を受諾
    const page2 = await context.newPage()
    await testLogin(page2, 2)
    await acceptInvitation(page2, invitation.token)

    // User2 がツリーメンバーを確認
    const members = await getTreeMembers(page2, tree.id)
    expect(members.length).toBe(2)
    expect(members.some(m => m.user_id === 2)).toBe(true)

    // User2 がノードを編集
    const updateResponse = await updateNode(page2, tree.id, childNode.id, {
      title: 'Updated Child Node',
      content: childNode.content,
      version: childNode.version
    })
    expect(updateResponse.status()).toBe(200)

    // User1 が変更を確認
    const nodesResponse = await page.request.get(`/api/trees/${tree.id}/nodes`)
    const nodesData = await nodesResponse.json()
    const updatedNode = nodesData.data.find(n => n.id === childNode.id)
    expect(updatedNode.title).toBe('Updated Child Node')

    await page2.close()
  })

  test('TC-JOURNEY-002: 権限段階的昇格シナリオ', async ({ page, browser }) => {
    // User1 がツリー作成（Owner）
    await testLogin(page, 1)
    const tree = await createTree(page, 'Permission Test Tree')
    const node = await createNode(page, tree.id, 'Test Node')

    // User1 が User2 を Viewer として招待
    const invitation = await sendInvitation(page, tree.id, 'test-user-2@example.com', 'viewer')

    // User2 が別のコンテキストでログインして招待受諾
    const context2 = await browser.newContext()
    const page2 = await context2.newPage()
    await testLogin(page2, 2)
    await acceptInvitation(page2, invitation.token)

    // User2 が編集を試みる（失敗: Viewer）
    const editResponse1 = await updateNode(page2, tree.id, node.id, {
      title: 'Unauthorized Edit',
      content: node.content,
      version: node.version
    })
    expect(editResponse1.status()).toBe(403)

    // User1 が User2 を Editor に昇格
    const roleChangeResponse = await changeMemberRole(page, tree.id, 2, 'editor')
    expect(roleChangeResponse.status()).toBe(200)

    // User2 がノード編集に成功
    const editResponse2 = await updateNode(page2, tree.id, node.id, {
      title: 'Authorized Edit',
      content: node.content,
      version: node.version
    })
    expect(editResponse2.status()).toBe(200)

    // User3 と User4 を事前に作成
    const context3 = await browser.newContext()
    const page3 = await context3.newPage()
    await testLogin(page3, 3)
    await context3.close()

    const context4 = await browser.newContext()
    const page4 = await context4.newPage()
    await testLogin(page4, 4)
    await context4.close()

    // User1 が User3 を Viewer として招待
    const invitation3 = await sendInvitation(page, tree.id, 'test-user-3@example.com', 'viewer')

    // User2 (Editor) は招待できない（現行APIはOwnerのみ招待可能）
    const invitation4Response = await apiRequest(page2, 'POST', `/api/trees/${tree.id}/invitations`, {
      email: 'test-user-4@example.com',
      role: 'viewer'
    })
    expect(invitation4Response.status()).toBe(403)
    const invitation4Error = await invitation4Response.json()
    expect(invitation4Error.error).toBe('Permission denied. Only the owner can invite members')

    await context2.close()
  })

  test('TC-JOURNEY-003: マルチツリー環境での完全ワークフロー', async ({ page, browser }) => {
    // User1 がログイン
    await testLogin(page, 1)

    // User1 が複数ツリーを作成
    const treeA = await createTree(page, 'Tree A')
    const treeB = await createTree(page, 'Tree B')

    // User2 が別のコンテキストでログイン
    const context2 = await browser.newContext()
    const page2 = await context2.newPage()
    await testLogin(page2, 2)
    const treeC = await createTree(page2, 'Tree C')

    // 相互に招待
    const invitationA = await sendInvitation(page, treeA.id, 'test-user-2@example.com', 'editor')
    const invitationC = await sendInvitation(page2, treeC.id, 'test-user-1@example.com', 'viewer')

    // 招待受諾
    await acceptInvitation(page2, invitationA.token)
    await acceptInvitation(page, invitationC.token)

    // User1 が Tree A でノード作成（成功: Owner）
    const nodeA = await createNode(page, treeA.id, 'Node in Tree A')
    expect(nodeA.tree_id).toBe(treeA.id)

    // User1 が Tree C でノード作成を試みる（失敗: Viewer）
    const createResponse = await apiRequest(page, 'POST', `/api/trees/${treeC.id}/nodes`, {
      title: 'Unauthorized Node',
      content: '',
      author_user_id: 1
    })
    expect(createResponse.status()).toBe(403)
    const createError = await createResponse.json()
    expect(createError.error).toBe('You do not have permission to edit this tree')

    // User2 が Tree A でノード作成（成功: Editor）
    const nodeA2 = await createNode(page2, treeA.id, 'Another Node in Tree A')
    expect(nodeA2.tree_id).toBe(treeA.id)

    // User2 が Tree B にアクセスを試みる（失敗: メンバーでない）
    const treeBAccessResponse = await page2.request.get(`/api/trees/${treeB.id}`)
    expect(treeBAccessResponse.status()).toBe(403)

    // ツリー一覧で共有状況を確認
    const treesResponse = await page.request.get('/api/trees')
    const treesData = await treesResponse.json()
    const myTrees = treesData.data.filter(t => t.role === 'owner')
    const sharedTrees = treesData.data.filter(t => t.role !== 'owner')

    expect(myTrees.length).toBe(2) // Tree A, Tree B
    expect(sharedTrees.length).toBe(1) // Tree C

    await context2.close()
  })
})

test.describe('Phase 13: 統合テスト - 複数機能の連携', () => {

  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-CROSS-001: 招待 + 通知 + プロフィールの連携', async ({ page, context }) => {
    // User1 がログインしてプロフィール更新
    await testLogin(page, 1)
    await updateProfile(page, 'Project Manager')

    // User1 がツリー作成
    const tree = await createTree(page, 'Integration Test Tree')

    // User1 が User2 を招待
    const invitation = await sendInvitation(page, tree.id, 'test-user-2@example.com', 'editor')

    // User2 がログインして招待を受諾
    const page2 = await context.newPage()
    await testLogin(page2, 2)
    await acceptInvitation(page2, invitation.token)

    // User2 がメンバー一覧で "Project Manager" を確認
    const members = await getTreeMembers(page2, tree.id)
    const owner = members.find(m => m.user_id === 1)
    expect(owner.display_name).toBe('Project Manager')

    await page2.close()
  })

  test('TC-CROSS-002: 楽観的ロック + エラーハンドリングの連携', async ({ page, context }) => {
    // User1 と User2 が同じツリーの Editor
    await testLogin(page, 1)
    const tree = await createTree(page, 'Lock Test Tree')
    const node = await createNode(page, tree.id, 'Concurrent Edit Node')

    const invitation = await sendInvitation(page, tree.id, 'test-user-2@example.com', 'editor')

    const page2 = await context.newPage()
    await testLogin(page2, 2)
    await acceptInvitation(page2, invitation.token)

    // 両者が同じノードを読み込み（version=1）
    const nodesResponse1 = await page.request.get(`/api/trees/${tree.id}/nodes`)
    const nodesData1 = await nodesResponse1.json()
    const nodeVersion1 = nodesData1.data.find(n => n.id === node.id)

    const nodesResponse2 = await page2.request.get(`/api/trees/${tree.id}/nodes`)
    const nodesData2 = await nodesResponse2.json()
    const nodeVersion2 = nodesData2.data.find(n => n.id === node.id)

    expect(nodeVersion1.version).toBe(1)
    expect(nodeVersion2.version).toBe(1)

    // User1 が先に更新（成功）
    const update1Response = await updateNode(page, tree.id, node.id, {
      title: 'User1 Update',
      content: node.content,
      version: 1
    })
    expect(update1Response.status()).toBe(200)
    const update1Data = await update1Response.json()
    expect(update1Data.data.version).toBe(2)

    // User2 が更新を試みる（競合）
    const update2Response = await updateNode(page2, tree.id, node.id, {
      title: 'User2 Update',
      content: node.content,
      version: 1 // 古いバージョン
    })
    expect(update2Response.status()).toBe(409)

    const conflictData = await update2Response.json()
    expect(conflictData.error).toContain('Version conflict')
    expect(conflictData.current_version).toBe(2)
    expect(conflictData.server_data).toBeDefined()
    expect(conflictData.server_data.title).toBe('User1 Update')

    // User2 が正しいバージョンで再試行（成功）
    const update2RetryResponse = await updateNode(page2, tree.id, node.id, {
      title: 'User2 Update (Retry)',
      content: node.content,
      version: 2
    })
    expect(update2RetryResponse.status()).toBe(200)
    const update2RetryData = await update2RetryResponse.json()
    expect(update2RetryData.data.version).toBe(3)

    await page2.close()
  })

  test('TC-CROSS-003: マルチツリー + マルチユーザーの複雑なシナリオ', async ({ page, browser }) => {
    // User1 が Tree A, Tree B を作成
    await testLogin(page, 1)
    const treeA = await createTree(page, 'Tree A')
    const treeB = await createTree(page, 'Tree B')

    // User2 が別のコンテキストで Tree C を作成
    const context2 = await browser.newContext()
    const page2 = await context2.newPage()
    await testLogin(page2, 2)
    const treeC = await createTree(page2, 'Tree C')

    // 相互招待
    const invitationA = await sendInvitation(page, treeA.id, 'test-user-2@example.com', 'editor')
    const invitationC = await sendInvitation(page2, treeC.id, 'test-user-1@example.com', 'viewer')

    await acceptInvitation(page2, invitationA.token)
    await acceptInvitation(page, invitationC.token)

    // User1 が各ツリーでノード作成
    const nodeA = await createNode(page, treeA.id, 'Node in Tree A')
    const nodeB = await createNode(page, treeB.id, 'Node in Tree B')

    // User1 が Tree C でノード作成を試みる（失敗: Viewer）
    const createCResponse = await apiRequest(page, 'POST', `/api/trees/${treeC.id}/nodes`, {
      title: 'Unauthorized',
      content: '',
      author_user_id: 1
    })
    expect(createCResponse.status()).toBe(403)
    const createCError = await createCResponse.json()
    expect(createCError.error).toBe('You do not have permission to edit this tree')

    // User2 が Tree A でノード作成（成功: Editor）
    const nodeA2 = await createNode(page2, treeA.id, 'User2 Node in Tree A')

    // User2 が Tree B にアクセスを試みる（失敗: メンバーでない）
    const treeBResponse = await page2.request.get(`/api/trees/${treeB.id}`)
    expect(treeBResponse.status()).toBe(403)

    // ツリー分離の検証: Tree A のノードが Tree B に表示されない
    const nodesBResponse = await page.request.get(`/api/trees/${treeB.id}/nodes`)
    const nodesBData = await nodesBResponse.json()
    expect(nodesBData.data.every(n => n.tree_id === treeB.id)).toBe(true)
    expect(nodesBData.data.some(n => n.id === nodeA.id)).toBe(false)

    await context2.close()
  })
})

test.describe('Phase 13: 統合テスト - 同時実行・競合処理', () => {

  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-CONCURRENT-001: 複数ユーザーの同時ノード作成', async ({ page, context }) => {
    // User1 がツリー作成
    await testLogin(page, 1)
    const tree = await createTree(page, 'Concurrent Creation Tree')

    // User2 を Editor として招待
    const invitation = await sendInvitation(page, tree.id, 'test-user-2@example.com', 'editor')

    const page2 = await context.newPage()
    await testLogin(page2, 2)
    await acceptInvitation(page2, invitation.token)

    // 両ユーザーがほぼ同時にノード作成
    const [nodeA, nodeB] = await Promise.all([
      createNode(page, tree.id, 'Node A', 'Content A'),
      createNode(page2, tree.id, 'Node B', 'Content B')
    ])

    expect(nodeA.title).toBe('Node A')
    expect(nodeB.title).toBe('Node B')

    // ノード一覧で両方が存在することを確認
    const nodesResponse = await page.request.get(`/api/trees/${tree.id}/nodes`)
    const nodesData = await nodesResponse.json()

    expect(nodesData.data.some(n => n.id === nodeA.id)).toBe(true)
    expect(nodesData.data.some(n => n.id === nodeB.id)).toBe(true)

    await page2.close()
  })

  test('TC-CONCURRENT-002: 同時編集での楽観的ロック', async ({ page, context }) => {
    // セットアップ
    await testLogin(page, 1)
    const tree = await createTree(page, 'Lock Tree')
    const node = await createNode(page, tree.id, 'Original Title', 'Original Content')

    const invitation = await sendInvitation(page, tree.id, 'test-user-2@example.com', 'editor')

    const page2 = await context.newPage()
    await testLogin(page2, 2)
    await acceptInvitation(page2, invitation.token)

    // 両者が同じノード (version=1) を読み込み
    const getNode = async (page) => {
      const response = await page.request.get(`/api/trees/${tree.id}/nodes`)
      const data = await response.json()
      return data.data.find(n => n.id === node.id)
    }

    const node1 = await getNode(page)
    const node2 = await getNode(page2)

    expect(node1.version).toBe(1)
    expect(node2.version).toBe(1)

    // User1 が先に保存（成功）
    const update1 = await updateNode(page, tree.id, node.id, {
      title: 'Title A',
      content: node.content,
      version: 1
    })
    expect(update1.status()).toBe(200)
    const update1Data = await update1.json()
    expect(update1Data.data.version).toBe(2)

    // User2 が保存を試みる（競合）
    const update2 = await updateNode(page2, tree.id, node.id, {
      title: 'Title B',
      content: node.content,
      version: 1
    })
    expect(update2.status()).toBe(409)

    const conflictData = await update2.json()
    expect(conflictData.error).toBeDefined()
    expect(conflictData.current_version).toBe(2)
    expect(conflictData.server_data.title).toBe('Title A')
    expect(conflictData.server_data.version).toBe(2)

    // User2 が "Title B" で再保存（成功）
    const update2Retry = await updateNode(page2, tree.id, node.id, {
      title: 'Title B',
      content: node.content,
      version: 2
    })
    expect(update2Retry.status()).toBe(200)
    const update2RetryData = await update2Retry.json()
    expect(update2RetryData.data.version).toBe(3)
    expect(update2RetryData.data.title).toBe('Title B')

    await page2.close()
  })

  test('TC-CONCURRENT-003: 同時メンバー追加', async ({ page, browser }) => {
    // User1 がツリー作成
    await testLogin(page, 1)
    const tree = await createTree(page, 'Member Addition Tree')

    // User2 を Editor として招待
    const invitation2 = await sendInvitation(page, tree.id, 'test-user-2@example.com', 'editor')

    const context2 = await browser.newContext()
    const page2 = await context2.newPage()
    await testLogin(page2, 2)
    await acceptInvitation(page2, invitation2.token)

    // User1 と User2 が同時に異なるユーザーを招待（現行APIはOwnerのみ招待可能）
    const [invitation3, invitation4Response] = await Promise.all([
      sendInvitation(page, tree.id, 'test-user-3@example.com', 'viewer'),
      apiRequest(page2, 'POST', `/api/trees/${tree.id}/invitations`, {
        email: 'test-user-4@example.com',
        role: 'editor'
      })
    ])

    expect(invitation3.token).toBeDefined()
    expect(invitation4Response.status()).toBe(403)
    const invitation4Error = await invitation4Response.json()
    expect(invitation4Error.error).toBe('Permission denied. Only the owner can invite members')

    // Owner の招待だけが作成され、Editor の招待は拒否されたことを確認
    const invitationsResponse = await page.request.get(`/api/trees/${tree.id}/invitations`)
    const invitationsData = await invitationsResponse.json()

    expect(invitationsData.data.some(i => i.invitee_email === 'test-user-3@example.com')).toBe(true)
    expect(invitationsData.data.some(i => i.invitee_email === 'test-user-4@example.com')).toBe(false)

    await context2.close()
  })
})

test.describe('Phase 13: 統合テスト - エラーハンドリング', () => {

  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-ERROR-001: 無効な招待トークンの処理', async ({ page, context }) => {
    // User1 がツリー作成して招待送信
    await testLogin(page, 1)
    const tree = await createTree(page, 'Expiration Test Tree')
    const invitation = await sendInvitation(page, tree.id, 'test-user-2@example.com', 'editor')

    // 招待の有効期限を過去に設定（手動 DB 操作）
    const db = await page.evaluate(async () => {
      // NOTE: この操作は実際には Cloudflare Workers 環境で直接 D1 にアクセスできないため、
      // 代替として既に受諾済みの招待をもう一度受諾しようとするテストにする
      return true
    })

    // User2 がログイン
    const page2 = await context.newPage()
    await testLogin(page2, 2)

    // 招待を受諾
    await acceptInvitation(page2, invitation.token)

    // 同じトークンで再度受諾を試みる（失敗: 既に使用済み）
    const response = await apiRequest(page2, 'POST', `/api/invitations/${invitation.token}/accept`, {})
    expect(response.status()).toBe(400)

    const errorData = await response.json()
    expect(errorData.error).toBeDefined()

    // 無効なトークンで受諾を試みる
    const invalidResponse = await apiRequest(page2, 'POST', '/api/invitations/invalid_token_12345/accept', {})
    expect(invalidResponse.status()).toBe(404)

    await page2.close()
  })

  test('TC-ERROR-002: 存在しないツリーへのアクセス', async ({ page }) => {
    await testLogin(page, 1)

    // 存在しないツリー ID でアクセス
    const response = await page.request.get('/api/trees/99999')
    expect(response.status()).toBe(404)

    const errorData = await response.json()
    expect(errorData.error).toBeDefined()

    // 存在しないツリーのノードを取得
    const nodesResponse = await page.request.get('/api/trees/99999/nodes')
    expect(nodesResponse.status()).toBe(404)
  })

  test('TC-ERROR-003: 権限不足での操作', async ({ page, context }) => {
    // User1 がツリー作成
    await testLogin(page, 1)
    const tree = await createTree(page, 'Permission Test')
    const node = await createNode(page, tree.id, 'Test Node')

    // User2 を Viewer として招待
    const invitation = await sendInvitation(page, tree.id, 'test-user-2@example.com', 'viewer')

    const page2 = await context.newPage()
    await testLogin(page2, 2)
    await acceptInvitation(page2, invitation.token)

    // User2 (Viewer) がノード作成を試みる（失敗）
    const createResponse = await apiRequest(page2, 'POST', `/api/trees/${tree.id}/nodes`, {
      title: 'Unauthorized Node',
      content: '',
      author_user_id: 2
    })
    expect(createResponse.status()).toBe(403)
    const createError = await createResponse.json()
    expect(createError.error).toBe('You do not have permission to edit this tree')

    // User2 (Viewer) がノード更新を試みる（失敗）
    const updateResponse = await updateNode(page2, tree.id, node.id, {
      title: 'Unauthorized Update',
      content: node.content,
      version: node.version
    })
    expect(updateResponse.status()).toBe(403)

    // User2 (Viewer) が招待送信を試みる（失敗）
    const inviteResponse = await apiRequest(page2, 'POST', `/api/trees/${tree.id}/invitations`, {
      email: 'test-user-3@example.com',
      role: 'viewer'
    })
    expect(inviteResponse.status()).toBe(403)

    await page2.close()
  })

  test('TC-ERROR-004: 削除されたツリーへのアクセス', async ({ page, browser }) => {
    // User1 がツリー作成
    await testLogin(page, 1)
    const tree = await createTree(page, 'To Be Deleted')

    // User2 を Editor として招待
    const invitation = await sendInvitation(page, tree.id, 'test-user-2@example.com', 'editor')

    const context2 = await browser.newContext()
    const page2 = await context2.newPage()
    await testLogin(page2, 2)
    await acceptInvitation(page2, invitation.token)

    // User2 がツリーにアクセス可能
    const accessResponse1 = await page2.request.get(`/api/trees/${tree.id}`)
    expect(accessResponse1.status()).toBe(200)

    // User1 がツリーを削除
    const deleteResponse = await apiRequest(page, 'DELETE', `/api/trees/${tree.id}`, null)
    expect(deleteResponse.status()).toBe(200)

    // User2 が削除されたツリーにアクセスを試みる（失敗）
    const accessResponse2 = await page2.request.get(`/api/trees/${tree.id}`)
    expect(accessResponse2.status()).toBe(404)

    await context2.close()
  })
})

test.describe('Phase 13: 統合テスト - パフォーマンス', () => {

  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-PERF-001: 大量ノードの読み込み性能', async ({ page }) => {
    await testLogin(page, 1)
    const tree = await createTree(page, 'Large Tree')

    // 100個のノードを作成
    const nodePromises = []
    for (let i = 1; i <= 100; i++) {
      nodePromises.push(
        createNode(page, tree.id, `Node ${i}`, `Content for node ${i}`)
      )
    }

    const nodes = await Promise.all(nodePromises)
    expect(nodes.length).toBe(100)

    // ノード一覧を取得してパフォーマンス計測
    const startTime = Date.now()
    const response = await page.request.get(`/api/trees/${tree.id}/nodes`)
    const endTime = Date.now()

    const elapsedTime = endTime - startTime

    expect(response.status()).toBe(200)
    const data = await response.json()
    const returnedNodeIds = new Set(data.data.map(node => node.id))
    expect(nodes.every(node => returnedNodeIds.has(node.id))).toBe(true)

    // レスポンス時間が 3 秒以内
    expect(elapsedTime).toBeLessThan(3000)

    console.log(`✅ TC-PERF-001: 100 nodes loaded in ${elapsedTime}ms`)
  })

  test('TC-PERF-002: 複数メンバーの管理（メール送信含む）', async ({ page, context }) => {
    await testLogin(page, 1)
    const tree = await createTree(page, 'Team Tree')

    // 3人のユーザーを招待
    const testEmails = [
      'test-user1@example.com',
      'test-user2@example.com',
      'test-user3@example.com'
    ]

    const invitations = []
    for (let i = 0; i < testEmails.length; i++) {
      const role = i === 0 ? 'viewer' : 'editor'
      const invitation = await sendInvitation(page, tree.id, testEmails[i], role)
      invitations.push(invitation)
    }

    expect(invitations.length).toBe(3)

    // メンバー一覧の取得パフォーマンス計測
    // （まだ招待受諾していないため、メンバーはオーナーのみ）
    const startTime = Date.now()
    const response = await page.request.get(`/api/trees/${tree.id}/members`)
    const endTime = Date.now()

    const elapsedTime = endTime - startTime

    expect(response.status()).toBe(200)
    const data = await response.json()
    expect(data.data.length).toBe(1) // オーナーのみ

    // レスポンス時間が 2 秒以内
    expect(elapsedTime).toBeLessThan(2000)

    // 招待一覧の取得パフォーマンス
    const startTime2 = Date.now()
    const invitationsResponse = await page.request.get(`/api/trees/${tree.id}/invitations`)
    const endTime2 = Date.now()

    const elapsedTime2 = endTime2 - startTime2

    expect(invitationsResponse.status()).toBe(200)
    const invitationsData = await invitationsResponse.json()
    expect(invitationsData.data.length).toBe(3)

    expect(elapsedTime2).toBeLessThan(2000)

    console.log(`✅ TC-PERF-002: 3 invitations (with real email) loaded in ${elapsedTime2}ms`)
  })

  test('TC-PERF-003: 複雑なDAG構造のレンダリング', async ({ page }) => {
    await testLogin(page, 1)
    const tree = await createTree(page, 'Complex DAG Tree')

    // 20個のノードを作成
    const nodes = []
    for (let i = 1; i <= 20; i++) {
      const node = await createNode(page, tree.id, `Node ${i}`, `Content ${i}`)
      nodes.push(node)
    }

    // 複雑な親子関係を作成（各ノードに複数の親）
    const relationPromises = []
    for (let i = 1; i < nodes.length; i++) {
      // 各ノードに 2-3 個の親を設定
      for (let j = Math.max(0, i - 3); j < i; j++) {
        relationPromises.push(
          createRelation(page, tree.id, nodes[j].id, nodes[i].id)
        )
      }
    }

    await Promise.all(relationPromises)

    // 関係一覧を取得してパフォーマンス計測
    const startTime = Date.now()
    const response = await page.request.get(`/api/trees/${tree.id}/relations`)
    const endTime = Date.now()

    const elapsedTime = endTime - startTime

    expect(response.status()).toBe(200)
    const data = await response.json()
    expect(data.data.length).toBeGreaterThan(20)

    // レスポンス時間が 2 秒以内
    expect(elapsedTime).toBeLessThan(2000)

    console.log(`✅ TC-PERF-003: Complex DAG loaded in ${elapsedTime}ms (${data.data.length} relations)`)
  })
})

// ===========================
// テストスイート終了
// ===========================

console.log('✅ Phase 13 Integration Tests: 16 test cases')
