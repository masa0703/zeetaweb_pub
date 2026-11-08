import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'
import { callMcp, issueMcpAuth } from './helpers/mcp-oauth.js'

const BASE_URL = 'http://localhost:3000'

async function testLogin(page, userId = 1) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
}

async function openTreeEditor(page, treeId) {
  await page.goto(`${BASE_URL}/index.html?tree=${treeId}`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#tree-container')).toBeVisible()
}

async function clearTestData(page) {
  await page.request.delete(`${BASE_URL}/api/test/clear`)
}

async function createTree(page, name) {
  const response = await page.request.post(`${BASE_URL}/api/trees`, {
    data: { name, description: 'Relation type test tree' }
  })
  const data = await response.json()
  return data.data
}

async function createNode(page, treeId, title) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes`, {
    data: {
      title,
      content: '',
      author_user_id: 1
    }
  })
  const data = await response.json()
  return data.data
}

async function addRelation(page, treeId, parentId, childId, relationTypeId = null) {
  const payload = {
    parent_node_id: parentId,
    child_node_id: childId
  }
  if (relationTypeId !== null) payload.relation_type_id = relationTypeId
  return page.request.post(`${BASE_URL}/api/trees/${treeId}/relations`, { data: payload })
}

test.describe('Relation Type API', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
    await testLogin(page, 1)
  })

  test('TC-RELTYPE-001: relation_type_id can be set and fetched from tree APIs', async ({ page }) => {
    const tree = await createTree(page, 'Relation Type Tree')

    const parentNode = await createNode(page, tree.id, 'Parent A')
    const childNode = await createNode(page, tree.id, 'Child A')
    const defaultChildNode = await createNode(page, tree.id, 'Child Default')

    const addReferenceRes = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/relations`, {
      data: {
        parent_node_id: parentNode.id,
        child_node_id: childNode.id,
        relation_type_id: 3
      }
    })
    const addReferenceData = await addReferenceRes.json()
    expect(addReferenceRes.ok()).toBeTruthy()
    expect(addReferenceData.success).toBeTruthy()
    expect(addReferenceData.data.relation_type_id).toBe(3)
    expect(addReferenceData.data.relation_type_name).toBe('REFERENCE')

    const addDefaultRes = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/relations`, {
      data: {
        parent_node_id: parentNode.id,
        child_node_id: defaultChildNode.id
      }
    })
    const addDefaultData = await addDefaultRes.json()
    expect(addDefaultRes.ok()).toBeTruthy()
    expect(addDefaultData.success).toBeTruthy()
    expect(addDefaultData.data.relation_type_id).toBe(1)

    const childrenRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes/${parentNode.id}/children`)
    const childrenData = await childrenRes.json()
    expect(childrenRes.ok()).toBeTruthy()
    expect(childrenData.success).toBeTruthy()

    const referenceChild = childrenData.data.find(n => n.id === childNode.id)
    expect(referenceChild.relation_type_id).toBe(3)
    expect(referenceChild.relation_type_name).toBe('REFERENCE')

    const parentsRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes/${childNode.id}/parents`)
    const parentsData = await parentsRes.json()
    expect(parentsRes.ok()).toBeTruthy()
    expect(parentsData.success).toBeTruthy()

    const targetParent = parentsData.data.find(n => n.id === parentNode.id)
    expect(targetParent.relation_type_id).toBe(3)
    expect(targetParent.relation_type_name).toBe('REFERENCE')

    const relationsRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/relations`)
    const relationsData = await relationsRes.json()
    expect(relationsRes.ok()).toBeTruthy()
    expect(relationsData.success).toBeTruthy()

    const relation = relationsData.data.find(r => r.parent_node_id === parentNode.id && r.child_node_id === childNode.id)
    expect(relation.relation_type_id).toBe(3)
    expect(relation.relation_type_name).toBe('REFERENCE')
  })

  test('TC-RELTYPE-001A: nodes-lite omits content while keeping tree metadata', async ({ page }) => {
    const tree = await createTree(page, 'Relation Type Lite Nodes')
    const createdNode = await createNode(page, tree.id, 'Lite Node')

    const liteRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes-lite`)
    const liteData = await liteRes.json()
    expect(liteRes.ok()).toBeTruthy()
    expect(liteData.success).toBeTruthy()
    expect(liteData.root_node_id).toBeTruthy()

    const liteNode = liteData.data.find(n => n.id === createdNode.id)
    expect(liteNode).toBeTruthy()
    expect(liteNode.title).toBe('Lite Node')
    expect(Object.prototype.hasOwnProperty.call(liteNode, 'child_sort_mode')).toBeTruthy()
    expect(Object.prototype.hasOwnProperty.call(liteNode, 'child_sort_direction')).toBeTruthy()
    expect(Object.prototype.hasOwnProperty.call(liteNode, 'content')).toBeFalsy()

    const fullRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes/${createdNode.id}`)
    const fullData = await fullRes.json()
    expect(fullRes.ok()).toBeTruthy()
    expect(fullData.success).toBeTruthy()
    expect(Object.prototype.hasOwnProperty.call(fullData.data, 'content')).toBeTruthy()
  })

  test('TC-RELTYPE-002: relation_types master and relation type update API', async ({ page }) => {
    const tree = await createTree(page, 'Relation Type Update API')
    const rootNodesRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes`)
    const rootNodesData = await rootNodesRes.json()
    const rootNodeId = rootNodesData.root_node_id

    const parentNode = await createNode(page, tree.id, 'Parent B')
    const childNode = await createNode(page, tree.id, 'Child B')
    await addRelation(page, tree.id, rootNodeId, parentNode.id, 1)
    await addRelation(page, tree.id, rootNodeId, childNode.id, 1)
    await addRelation(page, tree.id, parentNode.id, childNode.id, 1)

    const relationTypesRes = await page.request.get(`${BASE_URL}/api/relation-types`)
    const relationTypesData = await relationTypesRes.json()
    expect(relationTypesRes.ok()).toBeTruthy()
    expect(relationTypesData.success).toBeTruthy()
    expect(Array.isArray(relationTypesData.data)).toBeTruthy()
    expect(relationTypesData.data.map(t => t.name)).toEqual(['STRUCTURAL', 'REFERENCE'])
    expect(relationTypesData.data[0].name).toBe('STRUCTURAL')

    const updateRes = await page.request.patch(`${BASE_URL}/api/trees/${tree.id}/relations/${parentNode.id}/${childNode.id}/type`, {
      data: { relation_type_id: 3 }
    })
    const updateData = await updateRes.json()
    expect(updateRes.ok()).toBeTruthy()
    expect(updateData.success).toBeTruthy()
    expect(updateData.data.relation_type_id).toBe(3)
    expect(updateData.data.relation_type_name).toBe('REFERENCE')

    const badTypeRes = await page.request.patch(`${BASE_URL}/api/trees/${tree.id}/relations/${parentNode.id}/${childNode.id}/type`, {
      data: { relation_type_id: 9999 }
    })
    expect(badTypeRes.status()).toBe(400)

    const missingRelRes = await page.request.patch(`${BASE_URL}/api/trees/${tree.id}/relations/${childNode.id}/${parentNode.id}/type`, {
      data: { relation_type_id: 3 }
    })
    expect(missingRelRes.status()).toBe(404)
  })

  test('TC-RELTYPE-003: parent accordion relation_type select updates immediately and viewer is disabled', async ({ page }) => {
    const tree = await createTree(page, 'Relation Type UI')
    const rootNodesRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes`)
    const rootNodesData = await rootNodesRes.json()
    const rootNodeId = rootNodesData.root_node_id

    const parentNode = await createNode(page, tree.id, 'Parent UI')
    const childNode = await createNode(page, tree.id, 'Child UI')
    await addRelation(page, tree.id, rootNodeId, parentNode.id, 1)
    await addRelation(page, tree.id, rootNodeId, childNode.id, 1)
    await addRelation(page, tree.id, parentNode.id, childNode.id, 1)

    const childTreeItem = page.locator(`.tree-item:visible[data-node-id="${childNode.id}"]`).first()

    await openTreeEditor(page, tree.id)
    await childTreeItem.click({ force: true })
    await page.locator('#editor-panel').locator('text=親ノード').first().click({ force: true })

    const relationTypeSelect = page.locator(`.relation-type-select[data-parent-id="${parentNode.id}"][data-child-id="${childNode.id}"]`)
    await expect(relationTypeSelect).toBeVisible()
    // root親にはselectを表示しない
    await expect(page.locator(`.relation-type-select[data-parent-id="${rootNodeId}"]`)).toHaveCount(0)

    await relationTypeSelect.selectOption('3')

    // 保存→再描画が完了した証拠として、再描画後のselectにdata-prev-value=3が反映される
    // （旧DOMのdata-prev-valueは1のままなので、この待ちで再描画完了まで待つ）
    await expect(relationTypeSelect).toHaveAttribute('data-prev-value', '3')
    // 再描画後もアコーディオンは開いたままになる（閉じたら回帰）
    await expect(page.locator(`#parents-accordion-content-${childNode.id}`)).toBeVisible()
    await expect(relationTypeSelect).toHaveValue('3')

    // viewer user setup and permission check
    await testLogin(page, 2) // ensure user2 exists
    await testLogin(page, 1) // back to owner
    const addViewerRes = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/members`, {
      data: { user_id: 2, role: 'viewer' }
    })
    expect(addViewerRes.ok()).toBeTruthy()

    await testLogin(page, 2)
    await openTreeEditor(page, tree.id)
    await childTreeItem.click({ force: true })
    await page.locator('#editor-panel').locator('text=親ノード').first().click({ force: true })
    const viewerSelect = page.locator(`.relation-type-select[data-parent-id="${parentNode.id}"][data-child-id="${childNode.id}"]`)
    await expect(viewerSelect).toBeDisabled()

    const forbiddenRes = await page.request.patch(`${BASE_URL}/api/trees/${tree.id}/relations/${parentNode.id}/${childNode.id}/type`, {
      data: { relation_type_id: 3 }
    })
    expect(forbiddenRes.status()).toBe(403)
  })

  test('TC-RELTYPE-004: duplicate keeps relation_type from original relation', async ({ page }) => {
    const tree = await createTree(page, 'Relation Type Duplicate')
    const rootNodesRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes`)
    const rootNodesData = await rootNodesRes.json()
    const rootNodeId = rootNodesData.root_node_id

    const sourceNode = await createNode(page, tree.id, 'Source Node')
    await addRelation(page, tree.id, rootNodeId, sourceNode.id, 3)

    await openTreeEditor(page, tree.id)
    await page.locator('.tree-item:has-text("Source Node")').first().click({ force: true })
    await page.keyboard.press('Alt+M')
    await page.waitForTimeout(1000)

    const relationsRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/relations`)
    const relationsData = await relationsRes.json()
    expect(relationsRes.ok()).toBeTruthy()
    expect(relationsData.success).toBeTruthy()

    const nodeRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes`)
    const nodeData = await nodeRes.json()
    const duplicatedNode = nodeData.data.find(n => n.title === 'Source Nodeのコピー')
    expect(duplicatedNode).toBeTruthy()

    const duplicatedRelation = relationsData.data.find(
      r => r.parent_node_id === rootNodeId && r.child_node_id === duplicatedNode.id
    )
    expect(duplicatedRelation).toBeTruthy()
    expect(duplicatedRelation.relation_type_id).toBe(3)
    expect(duplicatedRelation.relation_type_name).toBe('REFERENCE')
  })

  test('TC-RELTYPE-005: add parent defaults to REFERENCE when child already has a REFERENCE parent', async ({ page }) => {
    const tree = await createTree(page, 'Relation Type Add Parent Default')
    const rootNodesRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes`)
    const rootNodesData = await rootNodesRes.json()
    const rootNodeId = rootNodesData.root_node_id

    const parentOne = await createNode(page, tree.id, 'Parent Reference')
    const parentTwo = await createNode(page, tree.id, 'Parent Added')
    const childNode = await createNode(page, tree.id, 'Child Reference Origin')

    await addRelation(page, tree.id, rootNodeId, parentOne.id, 1)
    await addRelation(page, tree.id, rootNodeId, parentTwo.id, 1)
    await addRelation(page, tree.id, parentOne.id, childNode.id, 3)

    const addSecondParentRes = await addRelation(page, tree.id, parentTwo.id, childNode.id)
    const addSecondParentData = await addSecondParentRes.json()
    expect(addSecondParentRes.ok()).toBeTruthy()
    expect(addSecondParentData.success).toBeTruthy()
    expect(addSecondParentData.data.relation_type_id).toBe(3)
    expect(addSecondParentData.data.relation_type_name).toBe('REFERENCE')
  })

  test('TC-RELTYPE-006: move keeps relation_type when moving from REFERENCE parent', async ({ page }) => {
    const tree = await createTree(page, 'Relation Type Move Preserve')
    const rootNodesRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes`)
    const rootNodesData = await rootNodesRes.json()
    const rootNodeId = rootNodesData.root_node_id

    const oldParent = await createNode(page, tree.id, 'Old Parent Reference')
    const newParent = await createNode(page, tree.id, 'New Parent Target')
    const childNode = await createNode(page, tree.id, 'Move Target Child')

    await addRelation(page, tree.id, rootNodeId, oldParent.id, 1)
    await addRelation(page, tree.id, rootNodeId, newParent.id, 1)
    await addRelation(page, tree.id, oldParent.id, childNode.id, 3)

    const moveRes = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/relations/move`, {
      data: {
        child_node_id: childNode.id,
        old_parent_id: oldParent.id,
        new_parent_id: newParent.id
      }
    })
    const moveData = await moveRes.json()
    expect(moveRes.ok()).toBeTruthy()
    expect(moveData.success).toBeTruthy()

    const relationsRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/relations`)
    const relationsData = await relationsRes.json()
    expect(relationsRes.ok()).toBeTruthy()
    expect(relationsData.success).toBeTruthy()

    const movedRelation = relationsData.data.find(
      r => r.parent_node_id === newParent.id && r.child_node_id === childNode.id
    )
    expect(movedRelation).toBeTruthy()
    expect(movedRelation.relation_type_id).toBe(3)
    expect(movedRelation.relation_type_name).toBe('REFERENCE')
  })
})

const STRUCTURAL = 1
const REFERENCE = 3
const LAST_STRUCTURAL_ERROR = 'Cannot change the last STRUCTURAL parent to another type'

async function getParentTypes(page, treeId, childId) {
  const response = await page.request.get(`${BASE_URL}/api/trees/${treeId}/relations`)
  const data = await response.json()
  return Object.fromEntries(
    (data.data || [])
      .filter(r => r.child_node_id === childId)
      .map(r => [r.parent_node_id, Number(r.relation_type_id)])
  )
}

async function patchRelationType(page, treeId, parentId, childId, relationTypeId) {
  return page.request.patch(`${BASE_URL}/api/trees/${treeId}/relations/${parentId}/${childId}/type`, {
    data: { relation_type_id: relationTypeId }
  })
}

test.describe('STRUCTURALな親は1つ（種別変更時の矯正）', () => {
  let treeId
  let rootNodeId

  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
    await testLogin(page, 1)
    const tree = await createTree(page, 'Single Structural Parent')
    treeId = tree.id
    const nodesRes = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes`)
    rootNodeId = String((await nodesRes.json()).root_node_id)
  })

  // 親ノードをルート直下に作り、子には指定した種別で親を付ける
  async function setupChild(page, parentTypes, childTitle = 'Child') {
    const parents = {}
    for (const name of Object.keys(parentTypes)) {
      parents[name] = await createNode(page, treeId, `Parent ${name}`)
      expect((await addRelation(page, treeId, rootNodeId, parents[name].id, STRUCTURAL)).status()).toBe(201)
    }
    const child = await createNode(page, treeId, childTitle)
    for (const [name, relationTypeId] of Object.entries(parentTypes)) {
      expect((await addRelation(page, treeId, parents[name].id, child.id, relationTypeId)).status()).toBe(201)
    }
    return { parents, child }
  }

  async function callMcpTool(page, name, args) {
    const auth = await issueMcpAuth(page, treeId)
    const res = await callMcp(page, auth, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    return res.result
  }

  test('TC-RELTYPE-007: RESTでSTRUCTURALに変更すると、他のSTRUCTURALの親だけがREFERENCEに矯正される', async ({ page }) => {
    const { parents: p, child } = await setupChild(page, { A: STRUCTURAL, B: REFERENCE, C: STRUCTURAL, D: REFERENCE })

    const res = await patchRelationType(page, treeId, p.B.id, child.id, STRUCTURAL)
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect([...body.data.demoted_parent_ids].sort()).toEqual([p.A.id, p.C.id].sort())

    expect(await getParentTypes(page, treeId, child.id)).toEqual({
      [p.A.id]: REFERENCE, [p.B.id]: STRUCTURAL, [p.C.id]: REFERENCE, [p.D.id]: REFERENCE,
    })
  })

  test('TC-RELTYPE-008: STRUCTURAL以外への変更では他の親に触らない（STRUCTURALが残る場合は許可）', async ({ page }) => {
    const { parents: p, child } = await setupChild(page, { A: STRUCTURAL, B: STRUCTURAL, C: REFERENCE })

    const res = await patchRelationType(page, treeId, p.B.id, child.id, REFERENCE)
    expect(res.ok()).toBeTruthy()
    expect((await res.json()).data.demoted_parent_ids).toEqual([])

    expect(await getParentTypes(page, treeId, child.id)).toEqual({
      [p.A.id]: STRUCTURAL, [p.B.id]: REFERENCE, [p.C.id]: REFERENCE,
    })
  })

  test('TC-RELTYPE-009: RESTで最後のSTRUCTURALを他の種別に変える操作は400で拒否される（親が1人でも同じ）', async ({ page }) => {
    const multi = await setupChild(page, { A: STRUCTURAL, B: REFERENCE }, 'Multi')
    const rejected = await patchRelationType(page, treeId, multi.parents.A.id, multi.child.id, REFERENCE)
    expect(rejected.status()).toBe(400)
    expect((await rejected.json()).error.startsWith(LAST_STRUCTURAL_ERROR)).toBeTruthy()
    expect(await getParentTypes(page, treeId, multi.child.id))
      .toEqual({ [multi.parents.A.id]: STRUCTURAL, [multi.parents.B.id]: REFERENCE })

    const sole = await setupChild(page, { S: STRUCTURAL }, 'Sole')
    const soleRejected = await patchRelationType(page, treeId, sole.parents.S.id, sole.child.id, REFERENCE)
    expect(soleRejected.status()).toBe(400)
    expect(await getParentTypes(page, treeId, sole.child.id)).toEqual({ [sole.parents.S.id]: STRUCTURAL })
  })

  test('TC-RELTYPE-010: MCP update_link_relation_type もREST同様に矯正し、最後のSTRUCTURALの変更は拒否する', async ({ page }) => {
    const { parents: p, child } = await setupChild(page, { A: STRUCTURAL, B: REFERENCE, C: STRUCTURAL, D: REFERENCE })

    const promoted = await callMcpTool(page, 'update_link_relation_type', {
      parent_id: p.B.id, child_id: child.id, relation_type: 'STRUCTURAL',
    })
    expect(promoted.isError).toBeFalsy()
    expect([...promoted.structuredContent.demoted_parent_ids].sort()).toEqual([p.A.id, p.C.id].sort())
    expect(await getParentTypes(page, treeId, child.id)).toEqual({
      [p.A.id]: REFERENCE, [p.B.id]: STRUCTURAL, [p.C.id]: REFERENCE, [p.D.id]: REFERENCE,
    })

    // B が唯一の STRUCTURAL になったので、B を REFERENCE に戻す操作は拒否される
    const rejected = await callMcpTool(page, 'update_link_relation_type', {
      parent_id: p.B.id, child_id: child.id, relation_type: 'REFERENCE',
    })
    expect(rejected.isError).toBe(true)
    expect(rejected.content[0].text).toContain(LAST_STRUCTURAL_ERROR)
    expect((await getParentTypes(page, treeId, child.id))[p.B.id]).toBe(STRUCTURAL)
  })

  test('TC-RELTYPE-013: 廃止した INSTANCE（id=2）は REST・MCP のどちらでも指定できない', async ({ page }) => {
    const typesRes = await page.request.get(`${BASE_URL}/api/relation-types`)
    expect((await typesRes.json()).data.map(t => t.name)).toEqual(['STRUCTURAL', 'REFERENCE'])

    const { parents: p, child } = await setupChild(page, { A: STRUCTURAL, B: REFERENCE })
    const other = await createNode(page, treeId, 'Other Parent')
    expect((await addRelation(page, treeId, rootNodeId, other.id, STRUCTURAL)).status()).toBe(201)

    expect((await addRelation(page, treeId, other.id, child.id, 2)).status()).toBe(400)
    expect((await patchRelationType(page, treeId, p.B.id, child.id, 2)).status()).toBe(400)

    const byName = await callMcpTool(page, 'link_node', { parent_id: other.id, child_id: child.id, relation_type: 'INSTANCE' })
    expect(byName.isError).toBe(true)
    const byId = await callMcpTool(page, 'link_node', { parent_id: other.id, child_id: child.id, relation_type_id: 2 })
    expect(byId.isError).toBe(true)
    const update = await callMcpTool(page, 'update_link_relation_type', { parent_id: p.B.id, child_id: child.id, relation_type: 'INSTANCE' })
    expect(update.isError).toBe(true)

    expect(await getParentTypes(page, treeId, child.id)).toEqual({ [p.A.id]: STRUCTURAL, [p.B.id]: REFERENCE })
  })

  async function openParentsAccordionFor(page, childId) {
    await openTreeEditor(page, treeId)
    await page.locator(`.tree-item:visible[data-node-id="${childId}"]`).first().click({ force: true })
    await page.locator('#editor-panel').locator('text=親ノード').first().click({ force: true })
  }

  test('TC-RELTYPE-011: UIでSTRUCTURALに変更すると他の親の表示がREFERENCEになり、トーストで知らせる', async ({ page }) => {
    const { parents: p, child } = await setupChild(page, { A: STRUCTURAL, B: REFERENCE })
    // 子をルート直下（REFERENCE）にも置いてツリーから選べるようにする
    expect((await addRelation(page, treeId, rootNodeId, child.id, REFERENCE)).status()).toBe(201)

    await openParentsAccordionFor(page, child.id)
    const selectA = page.locator(`.relation-type-select[data-parent-id="${p.A.id}"][data-child-id="${child.id}"]`)
    const selectB = page.locator(`.relation-type-select[data-parent-id="${p.B.id}"][data-child-id="${child.id}"]`)
    await selectB.selectOption(String(STRUCTURAL))

    await expect(page.locator('.toast-message').last()).toContainText('REFERENCE に変更しました')
    await expect(selectB).toHaveAttribute('data-prev-value', String(STRUCTURAL))
    await expect(selectA).toHaveValue(String(REFERENCE))
    expect(await getParentTypes(page, treeId, child.id))
      .toEqual({ [p.A.id]: REFERENCE, [p.B.id]: STRUCTURAL, [rootNodeId]: REFERENCE })
  })

  test('TC-RELTYPE-012: UIで最後のSTRUCTURALを他の種別に変えようとするとトーストで拒否され、選択が元に戻る', async ({ page }) => {
    const { parents: p, child } = await setupChild(page, { A: STRUCTURAL, B: REFERENCE })
    expect((await addRelation(page, treeId, rootNodeId, child.id, REFERENCE)).status()).toBe(201)

    await openParentsAccordionFor(page, child.id)
    const selectA = page.locator(`.relation-type-select[data-parent-id="${p.A.id}"][data-child-id="${child.id}"]`)
    await selectA.selectOption(String(REFERENCE))

    await expect(page.locator('.toast-message').last()).toContainText('最後の STRUCTURAL の親は他の種別に変更できません')
    await expect(selectA).toHaveValue(String(STRUCTURAL))
    expect((await getParentTypes(page, treeId, child.id))[p.A.id]).toBe(STRUCTURAL)
  })
})
