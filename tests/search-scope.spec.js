import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

// 「配下のノードを検索」(parent_node_id 指定の検索) が、配下外・他ツリーのノードを
// ヒットさせないことを確認する回帰テスト（id:juwvwo）。
//
// 注意: ローカル dev には AI / VECTORIZE のエミュレーターが無いため（wrangler.toml参照）、
// ベクトル検索は常に空を返す。このテストが守るのは「parent_node_id のスコープ解決・
// アクセス制御」の骨格部分（word検索のスコープ、他ツリーへのアクセス拒否時に即座に
// 空を返すこと）。ベクトル検索自体が配下外を返さないことは、本番相当の環境（preview
// の zeeta-dev index など）で手動確認する必要がある。

const BASE_URL = 'http://localhost:3000'

async function testLogin(page, userId) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
}

async function clearTestData(page) {
  await page.request.delete(`${BASE_URL}/api/test/clear`)
}

async function createTree(page, name) {
  const response = await page.request.post(`${BASE_URL}/api/trees`, {
    data: { name, description: 'search scope test tree' }
  })
  expect(response.ok()).toBe(true)
  const data = await response.json()
  return data.data
}

async function createNode(page, treeId, title, content, authorUserId) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes`, {
    data: { title, content, author_user_id: authorUserId }
  })
  expect(response.ok()).toBe(true)
  const data = await response.json()
  return data.data
}

async function addRelation(page, treeId, parentId, childId) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/relations`, {
    data: { parent_node_id: parentId, child_node_id: childId }
  })
  expect(response.ok()).toBe(true)
}

test.describe('search scope (「配下のノードを検索」の範囲外ヒット防止)', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('parent_node_id 指定時、配下ではない兄弟ノードはワード検索でヒットしない', async ({ page }) => {
    // Arrange
    await testLogin(page, 1)
    const tree = await createTree(page, 'Scope Tree')
    const keyword = 'スコープ回帰テスト用ユニーク文字列XYZ789'
    const parent = await createNode(page, tree.id, '配下ルート', '', 1)
    const child = await createNode(page, tree.id, '配下の子', keyword, 1)
    const sibling = await createNode(page, tree.id, '配下外の兄弟', keyword, 1)
    await addRelation(page, tree.id, tree.root_node_id, parent.id)
    await addRelation(page, tree.id, parent.id, child.id)
    await addRelation(page, tree.id, tree.root_node_id, sibling.id)

    // Act
    const response = await page.request.get(
      `${BASE_URL}/api/search?q=${encodeURIComponent(keyword)}&parent_node_id=${parent.id}`
    )
    const body = await response.json()

    // Assert
    expect(body.success).toBe(true)
    const ids = body.data.map((n) => n.id)
    expect(ids).toContain(child.id)
    expect(ids).not.toContain(sibling.id)
  })

  test('parent_node_id が他ユーザーのツリーに属する場合はアクセス拒否で空を返す', async ({ page }) => {
    // Arrange: user 2 が自分のツリーにノードを作る
    await testLogin(page, 2)
    const otherTree = await createTree(page, 'Other User Tree')
    const keyword = 'クロステナントアクセス拒否テスト用文字列ABC456'
    const otherNode = await createNode(page, otherTree.id, '他ユーザーの秘密ノード', keyword, 2)

    // user 1 に戻って、他人のツリーのノードを parent_node_id に指定する
    await testLogin(page, 1)
    const myTree = await createTree(page, 'My Tree')
    await createNode(page, myTree.id, '無関係なノード', keyword, 1)

    // Act
    const response = await page.request.get(
      `${BASE_URL}/api/search?q=${encodeURIComponent(keyword)}&parent_node_id=${otherNode.id}`
    )
    const body = await response.json()

    // Assert: 他ツリーへのアクセス権が無いので、word/vector 双方とも即座に空
    expect(body.success).toBe(true)
    expect(body.data).toEqual([])
  })
})
