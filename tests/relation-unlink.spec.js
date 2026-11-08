import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'
import { callMcp, issueMcpAuth } from './helpers/mcp-oauth.js'

const BASE_URL = 'http://localhost:3000'

async function testLogin(page, userId = 1) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
}

async function clearTestData(page) {
  await page.request.delete(`${BASE_URL}/api/test/clear`)
}

async function createTree(page, name) {
  const response = await page.request.post(`${BASE_URL}/api/trees`, {
    data: { name, description: 'Relation unlink test tree' }
  })
  const data = await response.json()
  return data.data
}

async function createNode(page, treeId, title) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes`, {
    data: { title, content: '', author_user_id: 1 }
  })
  const data = await response.json()
  return data.data
}

async function addRelation(page, treeId, parentId, childId, relationTypeId) {
  return page.request.post(`${BASE_URL}/api/trees/${treeId}/relations`, {
    data: {
      parent_node_id: parentId,
      child_node_id: childId,
      ...(relationTypeId === undefined ? {} : { relation_type_id: relationTypeId })
    }
  })
}

async function getRelationTypeIds(page, treeId, childId) {
  const response = await page.request.get(`${BASE_URL}/api/trees/${treeId}/relations`)
  const data = await response.json()
  return Object.fromEntries(
    (data.data || [])
      .filter(r => r.child_node_id === childId)
      .map(r => [r.parent_node_id, Number(r.relation_type_id)])
  )
}

async function getParentIds(page, treeId, childId) {
  const response = await page.request.get(`${BASE_URL}/api/trees/${treeId}/relations`)
  const data = await response.json()
  return (data.data || [])
    .filter(r => r.child_node_id === childId)
    .map(r => r.parent_node_id)
}

test.describe('Relation Unlink API (TC-FUNC-049)', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
    await testLogin(page, 1)
  })

  test('唯一の親の解除は400エラー、2親以上なら解除できる（MCPと同挙動）', async ({ page }) => {
    const tree = await createTree(page, 'Unlink Test Tree')
    const treeId = tree.id

    // P1, P2, A を作成（いずれも root 直下に作られる）
    const p1 = await createNode(page, treeId, 'Parent P1')
    const p2 = await createNode(page, treeId, 'Parent P2')
    const child = await createNode(page, treeId, 'Child A')

    // POST /nodes で作ったノードは親なしで作られる（親は relations で付ける）
    const initialParents = await getParentIds(page, treeId, child.id)
    expect(initialParents.length).toBe(0)

    // P1 -> A を追加（A の唯一の親になる）
    const addRes = await addRelation(page, treeId, p1.id, child.id)
    expect(addRes.ok()).toBeTruthy()
    const parentsAfterLink = await getParentIds(page, treeId, child.id)
    expect(parentsAfterLink).toEqual([p1.id])

    // 唯一の親 P1 -> A の解除 → 400 エラー（旧挙動の root 付け替えは発生しない）
    const delLastRes = await page.request.delete(
      `${BASE_URL}/api/trees/${treeId}/relations/${p1.id}/${child.id}`
    )
    const delLastData = await delLastRes.json()
    expect(delLastRes.status()).toBe(400)
    expect(delLastData.success).toBeFalsy()
    expect(delLastData.error.startsWith('Cannot remove the last parent from a node')).toBeTruthy()

    // A の親は P1 のまま（root へ付け替えられていない）
    const parentsAfterFailedUnlink = await getParentIds(page, treeId, child.id)
    expect(parentsAfterFailedUnlink).toEqual([p1.id])

    // P2 -> A を追加して2親化 → P1 -> A の解除が成功する
    const addP2Res = await addRelation(page, treeId, p2.id, child.id)
    expect(addP2Res.ok()).toBeTruthy()

    const delP1Res = await page.request.delete(
      `${BASE_URL}/api/trees/${treeId}/relations/${p1.id}/${child.id}`
    )
    const delP1Data = await delP1Res.json()
    expect(delP1Res.ok()).toBeTruthy()
    expect(delP1Data.success).toBeTruthy()

    // A の親は P2 のみ
    const finalParents = await getParentIds(page, treeId, child.id)
    expect(finalParents).toEqual([p2.id])
  })

  test('TC-FUNC-050: リレーション作成・解除の拒否規則と末尾追加がREST/MCPで一致する', async ({ page }) => {
    const tree = await createTree(page, 'Relation Rules Tree')
    const treeId = tree.id
    const parent = await createNode(page, treeId, 'Parent')
    const c1 = await createNode(page, treeId, 'C1')
    const c2 = await createNode(page, treeId, 'C2')
    const stray = await createNode(page, treeId, 'Stray')
    // MCP のスコープ（ルート配下）に入れるため Parent と Stray をルートへ接続する
    const rootRes = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes`)
    const rootId = String((await rootRes.json()).root_node_id)
    expect((await addRelation(page, treeId, rootId, parent.id)).status()).toBe(201)
    expect((await addRelation(page, treeId, rootId, stray.id)).status()).toBe(201)

    // REST: 子は親の末尾（position 0, 1）に追加される
    expect((await addRelation(page, treeId, parent.id, c1.id)).status()).toBe(201)
    expect((await addRelation(page, treeId, parent.id, c2.id)).status()).toBe(201)
    const relRes = await page.request.get(`${BASE_URL}/api/trees/${treeId}/relations`)
    const positions = Object.fromEntries(
      ((await relRes.json()).data || [])
        .filter(r => r.parent_node_id === parent.id)
        .map(r => [r.child_node_id, r.position])
    )
    expect(positions).toEqual({ [c1.id]: 0, [c2.id]: 1 })

    // REST: 自己参照・重複は400、存在しないリレーションの解除は404
    const selfRes = await addRelation(page, treeId, parent.id, parent.id)
    expect(selfRes.status()).toBe(400)
    expect((await selfRes.json()).error).toBe('Cannot create self-reference')
    const dupRes = await addRelation(page, treeId, parent.id, c1.id)
    expect(dupRes.status()).toBe(400)
    expect((await dupRes.json()).error).toBe('Relation already exists')
    const missingRes = await page.request.delete(`${BASE_URL}/api/trees/${treeId}/relations/${stray.id}/${c1.id}`)
    expect(missingRes.status()).toBe(404)
    expect((await missingRes.json()).error).toBe('Relation not found')

    // MCP: 同じ規則が tool error として返る
    const auth = await issueMcpAuth(page, treeId)
    let rpcId = 0
    const callTool = async (name, args) => {
      const res = await callMcp(page, auth, { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
      return res.result
    }
    const mcpSelf = await callTool('link_node', { parent_id: parent.id, child_id: parent.id })
    expect(mcpSelf.isError).toBe(true)
    expect(mcpSelf.content[0].text).toContain('Cannot self-link node')
    const mcpDup = await callTool('link_node', { parent_id: parent.id, child_id: c1.id })
    expect(mcpDup.isError).toBe(true)
    expect(mcpDup.content[0].text).toContain('Relation already exists')
    const mcpMissing = await callTool('unlink_node', { parent_id: stray.id, child_id: c1.id })
    expect(mcpMissing.isError).toBe(true)
    expect(mcpMissing.content[0].text).toContain('Relation not found')

    // MCP: link_node も末尾（position 2）に追加される
    const mcpLink = await callTool('link_node', { parent_id: parent.id, child_id: stray.id })
    expect(mcpLink.isError).toBeFalsy()
    const relAfter = await page.request.get(`${BASE_URL}/api/trees/${treeId}/relations`)
    const strayRel = ((await relAfter.json()).data || [])
      .find(r => r.parent_node_id === parent.id && r.child_node_id === stray.id)
    expect(strayRel.position).toBe(2)
  })
})

const STRUCTURAL = 1
const REFERENCE = 3

test.describe('親が1人になったノードの関係はSTRUCTURALにする (TC-FUNC-051)', () => {
  let treeId
  let rootId
  let p1
  let p2
  let p3

  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
    await testLogin(page, 1)
    const tree = await createTree(page, 'Sole Parent Structural Tree')
    treeId = tree.id
    rootId = String(tree.root_node_id)
    p1 = await createNode(page, treeId, 'P1')
    p2 = await createNode(page, treeId, 'P2')
    p3 = await createNode(page, treeId, 'P3')
    // MCP のスコープ（ルート配下）に入れるため親をルートへ接続する
    for (const parent of [p1, p2, p3]) {
      expect((await addRelation(page, treeId, rootId, parent.id)).status()).toBe(201)
    }
  })

  async function createChildWithParents(page, title, parents) {
    const child = await createNode(page, treeId, title)
    for (const [parent, relationTypeId] of parents) {
      expect((await addRelation(page, treeId, parent.id, child.id, relationTypeId)).status()).toBe(201)
    }
    return child
  }

  async function callMcpTool(page, name, args) {
    const auth = await issueMcpAuth(page, treeId)
    const res = await callMcp(page, auth, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    return res.result
  }

  test('REST: 2親→1親になると残った REFERENCE 関係が STRUCTURAL になる', async ({ page }) => {
    const child = await createChildWithParents(page, 'C', [[p1, STRUCTURAL], [p2, REFERENCE]])

    const res = await page.request.delete(`${BASE_URL}/api/trees/${treeId}/relations/${p1.id}/${child.id}`)
    expect(res.ok()).toBeTruthy()

    expect(await getRelationTypeIds(page, treeId, child.id)).toEqual({ [p2.id]: STRUCTURAL })
  })

  test('REST: 3親→2親では残った関係の種別は変わらない', async ({ page }) => {
    const child = await createChildWithParents(page, 'C', [[p1, STRUCTURAL], [p2, REFERENCE], [p3, REFERENCE]])

    const res = await page.request.delete(`${BASE_URL}/api/trees/${treeId}/relations/${p1.id}/${child.id}`)
    expect(res.ok()).toBeTruthy()

    expect(await getRelationTypeIds(page, treeId, child.id)).toEqual({ [p2.id]: REFERENCE, [p3.id]: REFERENCE })
  })

  test('MCP unlink_node: 2親→1親になると残った REFERENCE 関係が STRUCTURAL になる', async ({ page }) => {
    const child = await createChildWithParents(page, 'C', [[p1, STRUCTURAL], [p2, REFERENCE]])

    const result = await callMcpTool(page, 'unlink_node', { parent_id: p1.id, child_id: child.id })
    expect(result.isError).toBeFalsy()

    expect(await getRelationTypeIds(page, treeId, child.id)).toEqual({ [p2.id]: STRUCTURAL })
  })

  test('MCP unlink_nodes: 2親→1親になったノードだけ STRUCTURAL になる', async ({ page }) => {
    const c1 = await createChildWithParents(page, 'C1', [[p1, STRUCTURAL], [p2, REFERENCE]])
    const c2 = await createChildWithParents(page, 'C2', [[p1, STRUCTURAL], [p2, REFERENCE], [p3, REFERENCE]])

    const result = await callMcpTool(page, 'unlink_nodes', {
      links: [
        { parent_id: p1.id, child_id: c1.id },
        { parent_id: p1.id, child_id: c2.id },
      ],
    })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent.unlinked).toBe(2)

    expect(await getRelationTypeIds(page, treeId, c1.id)).toEqual({ [p2.id]: STRUCTURAL })
    expect(await getRelationTypeIds(page, treeId, c2.id)).toEqual({ [p2.id]: REFERENCE, [p3.id]: REFERENCE })
  })
})
