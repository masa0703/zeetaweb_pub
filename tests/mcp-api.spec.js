import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'
import {
  BASE_URL,
  callMcp,
  callMcpWithBearer,
  callModernMcp,
  issueMcpAuth,
  mcpResourceUrl,
  modernMcpPayload,
} from './helpers/mcp-oauth.js'

async function clearTestData(page) {
  await page.request.delete(`${BASE_URL}/api/test/clear`)
}

async function testLogin(page, userId = 1) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`)
  await waitForAppReady(page)
}

async function createTree(page, name) {
  const res = await page.request.post(`${BASE_URL}/api/trees`, {
    data: { name, description: 'MCP API test tree' }
  })
  const data = await res.json()
  expect(res.ok()).toBeTruthy()
  expect(data.success).toBeTruthy()
  return data.data
}

async function getTreeRootNodeId(page, treeId) {
  const res = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes`)
  const data = await res.json()
  expect(res.ok()).toBeTruthy()
  expect(data.success).toBeTruthy()
  return String(data.root_node_id)
}

/**
 * オブジェクトのキー集合が期待と**完全一致**することを検証する。
 *
 * `toHaveProperty` の積み上げでは「あるべき項目が無い」しか検出できず、
 * **余計な項目が増えたこと**を検出できない。read_node_history が内部の
 * 行ID（node_snapshots.id）を返していた不具合は、必要な項目の存在だけを
 * 検証していたため通り抜けた。以後 MCP の応答は形ごと固定する。
 */
function expectExactKeys(actual, expectedKeys, label) {
  expect(Object.keys(actual).sort(), `${label} のキー集合`).toEqual([...expectedKeys].sort())
}

/**
 * 応答に出てくる項目名がすべてツール説明に書かれていることを検証する。
 *
 * MCP ではツール説明が唯一の契約書で、エージェントはそれを読んで応答を解釈する。
 * **説明に無い項目を返すと必ず誤読される**（node_snapshots.id は「版の識別子」と
 * 読まれ、欠番がバグとして報告された）。項目を増やすなら説明も直す、を強制する。
 *
 * 部分文字列一致にすると 'node_id' の中の 'id' が通ってしまうため語境界で照合する。
 */
function expectFieldsDocumented(fieldNames, description, label) {
  const undocumented = [...new Set(fieldNames)].filter((name) => {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`)
    return !pattern.test(description)
  })
  expect(undocumented, `${label}: ツール説明に記載が無い応答項目`).toEqual([])
}

async function createNodeWithParent(page, treeId, title, parentNodeId, authorUserId = 1) {
  const res = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes/with-parent`, {
    data: {
      title,
      content: '',
      author_user_id: authorUserId,
      parent_node_id: parentNodeId
    }
  })
  const data = await res.json()
  expect(res.status()).toBe(201)
  expect(data.success).toBeTruthy()
  return data.data.node
}

async function createNodeWithParentAndContent(page, treeId, title, content, parentNodeId, authorUserId = 1) {
  const res = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes/with-parent`, {
    data: {
      title,
      content,
      author_user_id: authorUserId,
      parent_node_id: parentNodeId
    }
  })
  const data = await res.json()
  expect(res.status()).toBe(201)
  expect(data.success).toBeTruthy()
  return data.data.node
}

async function createDeepChain(page, treeId, startParentId, depth) {
  const nodeIds = []
  let parentId = startParentId
  for (let i = 0; i < depth; i += 1) {
    const node = await createNodeWithParent(page, treeId, `deep-${i + 1}`, parentId)
    nodeIds.push(String(node.id))
    parentId = String(node.id)
  }
  return nodeIds
}

test.describe('MCP over OAuth (ツリー固有エンドポイント)', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
    await testLogin(page, 1)
  })

  test('TC-MCP-API-015: MCP 2026-07-28 Streamable HTTP と旧仕様の互換性', async ({ page }) => {
    const tree = await createTree(page, 'MCP 2026 Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const issued = await issueMcpAuth(page, tree.id)

    const discover = await callModernMcp(page, issued, modernMcpPayload('discover', 'server/discover'))
    expect(discover.response.status()).toBe(200)
    expect(discover.body.result.resultType).toBe('complete')
    expect(discover.body.result.supportedVersions).toContain('2026-07-28')
    expect(discover.body.result.capabilities.tools).toEqual({})
    expect(discover.body.result.ttlMs).toBeGreaterThanOrEqual(0)
    expect(discover.body.result.cacheScope).toBe('private')
    expect(discover.body.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('zeetaweb-mcp')
    expect(discover.response.headers()['mcp-session-id']).toBeUndefined()

    const toolsList = await callModernMcp(page, issued, modernMcpPayload('tools', 'tools/list'))
    expect(toolsList.response.status()).toBe(200)
    expect(toolsList.body.result.resultType).toBe('complete')
    expect(toolsList.body.result.tools.length).toBeGreaterThan(0)
    expect(toolsList.body.result.ttlMs).toBeGreaterThanOrEqual(0)

    const rootCall = modernMcpPayload('root', 'tools/call', {
      name: 'get_root_node_id',
      arguments: {},
    })
    const rootResult = await callModernMcp(page, issued, rootCall)
    expect(rootResult.response.status()).toBe(200)
    expect(rootResult.body.result.resultType).toBe('complete')
    expect(rootResult.body.result.structuredContent.id).toBe(rootNodeId)

    const unknownTool = await callModernMcp(page, issued, modernMcpPayload('unknown-tool', 'tools/call', {
      name: 'does_not_exist',
      arguments: {},
    }))
    expect(unknownTool.response.status()).toBe(200)
    expect(unknownTool.body.error.code).toBe(-32602)

    const unknownResource = await callModernMcp(page, issued, modernMcpPayload('unknown-resource', 'resources/read', {
      uri: 'zeeta://missing',
    }))
    expect(unknownResource.response.status()).toBe(200)
    expect(unknownResource.body.error.code).toBe(-32602)

    const mismatchedHeader = await callModernMcp(
      page,
      issued,
      modernMcpPayload('mismatch', 'tools/list'),
      { 'mcp-method': 'resources/list' },
    )
    expect(mismatchedHeader.response.status()).toBe(400)
    expect(mismatchedHeader.body.error.code).toBe(-32020)

    const unsupported = await callModernMcp(
      page,
      issued,
      modernMcpPayload('unsupported', 'tools/list', {}, '2099-01-01'),
    )
    expect(unsupported.response.status()).toBe(400)
    expect(unsupported.body.error.code).toBe(-32022)
    expect(unsupported.body.error.data.supported).toContain('2026-07-28')

    const missingCapabilitiesPayload = modernMcpPayload('missing-capabilities', 'tools/list')
    delete missingCapabilitiesPayload.params._meta['io.modelcontextprotocol/clientCapabilities']
    const missingCapabilities = await callModernMcp(page, issued, missingCapabilitiesPayload)
    expect(missingCapabilities.response.status()).toBe(400)
    expect(missingCapabilities.body.error.code).toBe(-32602)

    const batchResponse = await page.request.post(mcpResourceUrl(tree.id), {
      headers: {
        authorization: `Bearer ${issued.key}`,
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list',
      },
      data: [modernMcpPayload('batch', 'tools/list')],
    })
    expect(batchResponse.status()).toBe(400)
    expect((await batchResponse.json()).error.code).toBe(-32600)

    const unknownMethod = await callModernMcp(page, issued, modernMcpPayload('unknown-method', 'unknown/method'))
    expect(unknownMethod.response.status()).toBe(404)
    expect(unknownMethod.body.error.code).toBe(-32601)

    const invalidOrigin = await callModernMcp(
      page,
      issued,
      modernMcpPayload('origin', 'tools/list'),
      { origin: 'https://attacker.example' },
    )
    expect(invalidOrigin.response.status()).toBe(403)

    const getResponse = await page.request.get(mcpResourceUrl(tree.id))
    expect(getResponse.status()).toBe(405)
    expect(getResponse.headers().allow).toBe('POST')
    const deleteResponse = await page.request.delete(mcpResourceUrl(tree.id))
    expect(deleteResponse.status()).toBe(405)
    expect(deleteResponse.headers().allow).toBe('POST')

    const notificationPayload = modernMcpPayload('remove-me', 'notifications/example')
    delete notificationPayload.id
    const notification = await callModernMcp(page, issued, notificationPayload)
    expect(notification.response.status()).toBe(202)
    expect(notification.body).toBeNull()

    const queryTokenOnly = await page.request.post(`${mcpResourceUrl(tree.id)}?token=${encodeURIComponent(issued.key)}`, {
      headers: {
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list',
      },
      data: modernMcpPayload('query-auth', 'tools/list'),
    })
    expect(queryTokenOnly.status()).toBe(401)

    const preflight = await page.request.fetch(mcpResourceUrl(tree.id), {
      method: 'OPTIONS',
      headers: {
        origin: BASE_URL,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,mcp-protocol-version,mcp-method,mcp-name',
      },
    })
    expect(preflight.status()).toBe(204)
    const allowedHeaders = preflight.headers()['access-control-allow-headers'].toLowerCase()
    expect(allowedHeaders).toContain('mcp-protocol-version')
    expect(allowedHeaders).toContain('mcp-method')
    expect(allowedHeaders).toContain('mcp-name')

    const legacyInitialize = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'legacy-init',
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy', version: '1.0.0' } },
    })
    expect(legacyInitialize.result.protocolVersion).toBe('2025-11-25')
    expect(legacyInitialize.result.serverInfo.name).toBe('zeetaweb-mcp')
  })

  test('TC-MCP-API-016: MCP-Protocol-Version ヘッダーのみのクライアントが接続できる', async ({ page }) => {
    // Codex / Claude などの実クライアントは MCP-Protocol-Version ヘッダーを送るが、
    // 2026-07-28 固有の params._meta へのミラーリングは行わない。
    // ヘッダーの存在だけで modern 判定すると initialize が弾かれるため、
    // _meta が無いリクエストは legacy 互換パスで処理されること。
    const tree = await createTree(page, 'MCP Header Only Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const issued = await issueMcpAuth(page, tree.id)

    const postHeaderOnly = (path, protocolVersion, payload) => page.request.post(`${BASE_URL}${path}`, {
      headers: {
        authorization: `Bearer ${issued.key}`,
        'content-type': 'application/json',
        'mcp-protocol-version': protocolVersion,
      },
      data: payload,
    })

    // 実在するMCPリビジョンと本実装の2バージョンを網羅する
    for (const protocolVersion of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28']) {
      for (const path of [`/api/mcp/trees/${tree.id}`]) {
        const res = await postHeaderOnly(path, protocolVersion, {
          jsonrpc: '2.0',
          id: `init-${protocolVersion}`,
          method: 'initialize',
          params: {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: 'header-only-client', version: '1.0.0' },
          },
        })
        const body = await res.json()
        expect(res.status(), `${path} ${protocolVersion}`).toBe(200)
        expect(body.error, `${path} ${protocolVersion}`).toBeUndefined()
        expect(body.result.protocolVersion).toBe(protocolVersion)
        expect(body.result.serverInfo.name).toBe('zeetaweb-mcp')
      }
    }

    // 初期化後の tools/list と通知もヘッダーのみで通る
    const toolsRes = await postHeaderOnly(`/api/mcp/trees/${tree.id}`, '2025-06-18', {
      jsonrpc: '2.0', id: 'tools', method: 'tools/list',
    })
    const toolsBody = await toolsRes.json()
    expect(toolsRes.status()).toBe(200)
    expect(toolsBody.result.tools.length).toBeGreaterThan(0)

    const notifyRes = await postHeaderOnly(`/api/mcp/trees/${tree.id}`, '2025-06-18', {
      jsonrpc: '2.0', method: 'notifications/initialized',
    })
    expect(notifyRes.status()).toBe(202)

    // 2026-07-28 を宣言した batch は、_meta 有無にかかわらず拒否され続ける
    const batchRes = await postHeaderOnly(`/api/mcp/trees/${tree.id}`, '2026-07-28', [
      { jsonrpc: '2.0', id: 'batch', method: 'tools/list' },
    ])
    expect(batchRes.status()).toBe(400)
    expect((await batchRes.json()).error.code).toBe(-32600)

    // _meta を送るクライアントには 2026-07-28 の厳格な検証が引き続き適用される
    const mismatchRes = await page.request.post(mcpResourceUrl(tree.id), {
      headers: {
        authorization: `Bearer ${issued.key}`,
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
        'mcp-method': 'tools/list',
      },
      data: modernMcpPayload('meta-mismatch', 'tools/list'),
    })
    expect(mismatchRes.status()).toBe(400)
    expect((await mismatchRes.json()).error.code).toBe(-32020)
  })

  test('TC-MCP-API-008: mcp:read のみのトークンは参照系ツールしか使えない', async ({ page }) => {
    const tree = await createTree(page, 'MCP Read Only Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)

    const readOnlyKey = await issueMcpAuth(page, tree.id, 'read_only')

    const toolsList = await callMcp(page, readOnlyKey, {
      jsonrpc: '2.0',
      id: 'tools-list-read-only',
      method: 'tools/list',
      params: {}
    })
    const toolNames = toolsList.result.tools.map(t => t.name).sort()
    expect(toolNames).toEqual(['find_in_node', 'get_children', 'get_parents', 'get_root_node_id', 'read_node', 'read_node_history', 'read_node_image', 'search_nodes'])

    // ツリー固有エンドポイントでは scope 不足を HTTP 403 insufficient_scope で拒否する
    // （JSON-RPC の tool error ではない）
    const deniedWrite = await callMcpWithBearer(page, readOnlyKey.treeId, readOnlyKey.key, {
      jsonrpc: '2.0',
      id: 'create-denied',
      method: 'tools/call',
      params: {
        name: 'create_node',
        arguments: {
          title: 'Denied node',
          parent_ids: [String(rootNodeId)],
          relation_type: 'STRUCTURAL'
        }
      }
    })
    expect(deniedWrite.status()).toBe(403)
    expect(deniedWrite.headers()['www-authenticate']).toContain('insufficient_scope')

    const allowedRead = await callMcp(page, readOnlyKey, {
      jsonrpc: '2.0',
      id: 'search-allowed',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: { keyword: 'Read Only', limit: 5, offset: 0 }
      }
    })
    expect(Array.isArray(allowedRead.result.structuredContent.items)).toBeTruthy()

    const readOnlyParent = await createNodeWithParent(page, tree.id, 'Read Only Children Parent', rootNodeId)
    const readOnlyChildA = await createNodeWithParentAndContent(
      page,
      tree.id,
      'Read Only Child A',
      'Child A body',
      readOnlyParent.id
    )
    await createNodeWithParentAndContent(
      page,
      tree.id,
      'Read Only Child B',
      'Child B body',
      readOnlyParent.id
    )
    const readOnlyChildrenRpc = await callMcp(page, readOnlyKey, {
      jsonrpc: '2.0',
      id: 'children-allowed',
      method: 'tools/call',
      params: {
        name: 'get_children',
        arguments: {
          node_id: String(readOnlyParent.id),
          limit: 10,
          offset: 0
        }
      }
    })
    expect(readOnlyChildrenRpc.result.isError).toBeFalsy()
    expect(readOnlyChildrenRpc.result.structuredContent.returned).toBeGreaterThan(0)
    expect(Array.isArray(readOnlyChildrenRpc.result.structuredContent.items)).toBeTruthy()
    expect(readOnlyChildrenRpc.result.structuredContent.items.some(item => String(item.id) === String(readOnlyChildA.id))).toBeTruthy()

    const readOnlyParentsRpc = await callMcp(page, readOnlyKey, {
      jsonrpc: '2.0',
      id: 'parents-allowed',
      method: 'tools/call',
      params: {
        name: 'get_parents',
        arguments: {
          node_id: String(readOnlyChildA.id),
          limit: 10,
          offset: 0
        }
      }
    })
    expect(readOnlyParentsRpc.result.isError).toBeFalsy()
    expect(readOnlyParentsRpc.result.structuredContent.returned).toBeGreaterThan(0)
    expect(Array.isArray(readOnlyParentsRpc.result.structuredContent.items)).toBeTruthy()
    expect(readOnlyParentsRpc.result.structuredContent.items.some(item => String(item.id) === String(readOnlyParent.id))).toBeTruthy()
  })

  test('TC-MCP-API-002: MCP JSON-RPC tools/list + get_root_node_id + create/read/link/search/unlink/update-link + batch + update-node', async ({ page }) => {
    const tree = await createTree(page, 'MCP Tool Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const issued = await issueMcpAuth(page, tree.id, 'full_access')

    const toolsList = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'tools-list',
      method: 'tools/list',
      params: {}
    })
    expect(Array.isArray(toolsList.result.tools)).toBeTruthy()
    expect(toolsList.result.tools.some(t => t.name === 'search_nodes')).toBeTruthy()
    expect(toolsList.result.tools.some(t => t.name === 'unlink_node')).toBeTruthy()
    expect(toolsList.result.tools.some(t => t.name === 'update_link_relation_type')).toBeTruthy()
    expect(toolsList.result.tools.some(t => t.name === 'link_nodes')).toBeTruthy()
    expect(toolsList.result.tools.some(t => t.name === 'unlink_nodes')).toBeTruthy()
    expect(toolsList.result.tools.some(t => t.name === 'move_node')).toBeTruthy()
    expect(toolsList.result.tools.some(t => t.name === 'move_nodes')).toBeTruthy()
    expect(toolsList.result.tools.some(t => t.name === 'update_node')).toBeTruthy()
    expect(toolsList.result.tools.some(t => t.name === 'update_node_title')).toBeTruthy()
    expect(toolsList.result.tools.some(t => t.name === 'append_node_content')).toBeTruthy()
    expect(toolsList.result.tools.some(t => t.name === 'read_node_image')).toBeTruthy()
    expect(toolsList.result.tools.some(t => t.name === 'create_node_image')).toBeTruthy()
    expect(toolsList.result.tools.some(t => t.name === 'trash_node')).toBeTruthy()
    expect(toolsList.result.tools.some(t => t.name === 'get_children')).toBeTruthy()
    expect(toolsList.result.tools.some(t => t.name === 'get_parents')).toBeTruthy()
    const createNodeTool = toolsList.result.tools.find(t => t.name === 'create_node')
    expect(createNodeTool?.description).toContain('created_at and updated_at can be specified')
    expect(createNodeTool?.description).toContain('child_sort_mode and child_sort_direction can be specified')
    expect(createNodeTool?.description).toContain('if omitted, the existing automatic timestamp behavior is used')
    expect(createNodeTool?.inputSchema?.properties?.child_sort_mode?.enum).toContain('title')
    expect(createNodeTool?.inputSchema?.properties?.child_sort_direction?.enum).toContain('desc')
    expect(createNodeTool?.inputSchema?.properties?.created_at?.type).toBe('string')
    expect(createNodeTool?.inputSchema?.properties?.updated_at?.type).toBe('string')

    const updateNodeTool = toolsList.result.tools.find(t => t.name === 'update_node')
    expect(updateNodeTool?.description).toContain('created_at and updated_at can be specified')
    expect(updateNodeTool?.inputSchema?.properties?.child_sort_mode?.enum).toContain('updated_at')
    expect(updateNodeTool?.inputSchema?.properties?.child_sort_direction?.enum).toContain('asc')
    expect(updateNodeTool?.inputSchema?.properties?.created_at?.type).toBe('string')
    expect(updateNodeTool?.inputSchema?.properties?.updated_at?.type).toBe('string')

    const readNodeTool = toolsList.result.tools.find(t => t.name === 'read_node')
    expect(readNodeTool?.inputSchema?.properties?.include_images?.type).toBe('boolean')
    const getChildrenTool = toolsList.result.tools.find(t => t.name === 'get_children')
    expect(getChildrenTool?.inputSchema?.properties?.include_images?.type).toBe('boolean')

    const readNodeImageTool = toolsList.result.tools.find(t => t.name === 'read_node_image')
    expect(readNodeImageTool?.inputSchema?.properties?.image_id?.type).toBe('integer')
    const createNodeImageTool = toolsList.result.tools.find(t => t.name === 'create_node_image')
    expect(createNodeImageTool?.inputSchema?.properties?.data_base64?.type).toBe('string')

    const rootRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'root',
      method: 'tools/call',
      params: {
        name: 'get_root_node_id',
        arguments: {}
      }
    })
    const rootStructured = rootRpc.result.structuredContent
    expect(String(rootStructured.id)).toBe(rootNodeId)

    const createRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'create',
      method: 'tools/call',
      params: {
        name: 'create_node',
        arguments: {
          title: 'MCP Node',
          content: 'Created by API test',
          parent_ids: [String(rootNodeId)],
          relation_type: 'REFERENCE'
        }
      }
    })
    const created = createRpc.result.structuredContent
    expect(String(created.id)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{6}$/)
    expect(created).toHaveProperty('author')
    expect(created).toHaveProperty('created_at')
    expect(created).toHaveProperty('updated_at')
    expect(created).toHaveProperty('path')
    expect(created).toHaveProperty('path_relation_mode')

    const restoredCreatedAt = '2026-01-02 03:04:05'
    const restoredUpdatedAt = '2026-01-03 04:05:06'
    const createWithTimestampsRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'create-with-timestamps',
      method: 'tools/call',
      params: {
        name: 'create_node',
        arguments: {
          title: 'MCP Node With Restored Timestamps',
          content: 'Created with caller supplied timestamps',
          parent_ids: [String(rootNodeId)],
          relation_type: 'STRUCTURAL',
          child_sort_mode: 'title',
          child_sort_direction: 'desc',
          created_at: restoredCreatedAt,
          updated_at: restoredUpdatedAt
        }
      }
    })
    expect(createWithTimestampsRpc.result.isError).toBeFalsy()
    expect(createWithTimestampsRpc.result.structuredContent.created_at).toBe(restoredCreatedAt)
    expect(createWithTimestampsRpc.result.structuredContent.updated_at).toBe(restoredUpdatedAt)
    expect(createWithTimestampsRpc.result.structuredContent.child_sort_mode).toBe('title')
    expect(createWithTimestampsRpc.result.structuredContent.child_sort_direction).toBe('desc')

    const createWithoutContentRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'create-no-content',
      method: 'tools/call',
      params: {
        name: 'create_node',
        arguments: {
          title: 'MCP Node Without Content',
          parent_ids: [String(rootNodeId)],
          relation_type: null
        }
      }
    })
    const appendTarget = createWithoutContentRpc.result.structuredContent

    await page.waitForTimeout(1100)
    const appendFirstRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'append-first',
      method: 'tools/call',
      params: {
        name: 'append_node_content',
        arguments: {
          node_id: String(appendTarget.id),
          content: 'part1',
        }
      }
    })
    expect(appendFirstRpc.result.isError).toBeFalsy()
    expect(appendFirstRpc.result.structuredContent.content).toBe('part1')
    expect(appendFirstRpc.result.structuredContent).toHaveProperty('path')
    expect(appendFirstRpc.result.structuredContent).toHaveProperty('path_relation_mode')
    expect(appendFirstRpc.result.structuredContent.updated_at).not.toBe(appendTarget.updated_at)

    const appendSecondRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'append-second',
      method: 'tools/call',
      params: {
        name: 'append_node_content',
        arguments: {
          node_id: String(appendTarget.id),
          content: 'part2',
        }
      }
    })
    expect(appendSecondRpc.result.isError).toBeFalsy()
    expect(appendSecondRpc.result.structuredContent.content).toBe('part1\npart2')
    expect(appendSecondRpc.result.structuredContent).toHaveProperty('path')
    expect(appendSecondRpc.result.structuredContent).toHaveProperty('path_relation_mode')

    const readRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'read',
      method: 'tools/call',
      params: {
        name: 'read_node',
        arguments: { node_id: String(created.id) }
      }
    })
    expect(String(readRpc.result.structuredContent.id)).toBe(String(created.id))
    expect(Array.isArray(readRpc.result.structuredContent.parents)).toBeTruthy()
    expect(readRpc.result.structuredContent.parents.length).toBeGreaterThan(0)
    expect(readRpc.result.structuredContent).toHaveProperty('author')
    expect(readRpc.result.structuredContent).toHaveProperty('created_at')
    expect(readRpc.result.structuredContent).toHaveProperty('updated_at')
    expect(readRpc.result.structuredContent).toHaveProperty('child_sort_mode')
    expect(readRpc.result.structuredContent).toHaveProperty('child_sort_direction')
    expect(readRpc.result.structuredContent).toHaveProperty('path')
    expect(readRpc.result.structuredContent).toHaveProperty('path_relation_mode')
    expect(readRpc.result.structuredContent.images).toBeUndefined()
    // children/parents payload is intentionally reduced for performance
    if (readRpc.result.structuredContent.parents.length > 0) {
      const parentSample = readRpc.result.structuredContent.parents[0]
      expect(Object.keys(parentSample).sort()).toEqual(['id', 'relation_type_name', 'title'])
      expect(['STRUCTURAL', 'REFERENCE']).toContain(parentSample.relation_type_name)
    }

    const sampleImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
    const createImageRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'create-node-image',
      method: 'tools/call',
      params: {
        name: 'create_node_image',
        arguments: {
          node_id: String(created.id),
          filename: 'copy-tree-sample.png',
          content_type: 'image/png',
          data_base64: sampleImageBase64
        }
      }
    })
    expect(createImageRpc.result.isError).toBeFalsy()
    expect(createImageRpc.result.structuredContent.image_id).toBeGreaterThan(0)
    expect(createImageRpc.result.structuredContent.url).toContain(`/nodes/${created.id}/images/`)

    const readWithImagesRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'read-with-images',
      method: 'tools/call',
      params: {
        name: 'read_node',
        arguments: { node_id: String(created.id), include_images: true }
      }
    })
    expect(readWithImagesRpc.result.isError).toBeFalsy()
    expect(readWithImagesRpc.result.structuredContent.images).toEqual([
      {
        id: createImageRpc.result.structuredContent.image_id,
        filename: 'copy-tree-sample.png',
        content_type: 'image/png'
      }
    ])

    const readImageRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'read-node-image',
      method: 'tools/call',
      params: {
        name: 'read_node_image',
        arguments: {
          node_id: String(created.id),
          image_id: createImageRpc.result.structuredContent.image_id
        }
      }
    })
    expect(readImageRpc.result.isError).toBeFalsy()
    expect(readImageRpc.result.structuredContent.filename).toBe('copy-tree-sample.png')
    expect(readImageRpc.result.structuredContent.content_type).toBe('image/png')
    expect(readImageRpc.result.structuredContent.data_base64).toBe(sampleImageBase64)

    const linkRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'link',
      method: 'tools/call',
      params: {
        name: 'link_node',
        arguments: {
          child_id: String(created.id),
          parent_id: String(rootNodeId),
          relation_type: 'REFERENCE'
        }
      }
    })
    // already linked to root, so this should return tool error payload
    expect(linkRpc.result.isError).toBeTruthy()

    const extraParentRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'create-parent',
      method: 'tools/call',
      params: {
        name: 'create_node',
        arguments: {
          title: 'MCP Extra Parent',
          parent_ids: [String(rootNodeId)],
          relation_type: 'STRUCTURAL'
        }
      }
    })
    const extraParent = extraParentRpc.result.structuredContent

    const linkToExtraParentRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'link-extra',
      method: 'tools/call',
      params: {
        name: 'link_node',
        arguments: {
          child_id: String(created.id),
          parent_id: String(extraParent.id),
          relation_type: 'REFERENCE'
        }
      }
    })
    expect(linkToExtraParentRpc.result.structuredContent.relation_type_name).toBe('REFERENCE')

    const updateLinkTypeRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'update-link-type',
      method: 'tools/call',
      params: {
        name: 'update_link_relation_type',
        arguments: {
          child_id: String(created.id),
          parent_id: String(extraParent.id),
          relation_type: 'STRUCTURAL'
        }
      }
    })
    expect(updateLinkTypeRpc.result.structuredContent.relation_type_name).toBe('STRUCTURAL')

    const unlinkRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'unlink',
      method: 'tools/call',
      params: {
        name: 'unlink_node',
        arguments: {
          child_id: String(created.id),
          parent_id: String(extraParent.id)
        }
      }
    })
    expect(unlinkRpc.result.structuredContent.success).toBeTruthy()
    expect(unlinkRpc.result.structuredContent.parent_id).toBe(String(extraParent.id))
    expect(unlinkRpc.result.structuredContent.child_id).toBe(String(created.id))

    const batchLinkTargetRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'create-batch-target',
      method: 'tools/call',
      params: {
        name: 'create_node',
        arguments: {
          title: 'MCP Batch Target',
          parent_ids: [String(rootNodeId)],
          relation_type: 'STRUCTURAL'
        }
      }
    })
    const batchLinkTarget = batchLinkTargetRpc.result.structuredContent

    const linkNodesRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'link-nodes',
      method: 'tools/call',
      params: {
        name: 'link_nodes',
        arguments: {
          links: [
            {
              child_id: String(created.id),
              parent_id: String(batchLinkTarget.id),
              relation_type: 'REFERENCE'
            }
          ]
        }
      }
    })
    expect(linkNodesRpc.result.structuredContent.linked).toBe(1)
    expect(linkNodesRpc.result.structuredContent.failed).toBe(0)

    const linkNodesFailRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'link-nodes-fail',
      method: 'tools/call',
      params: {
        name: 'link_nodes',
        arguments: {
          links: [
            {
              child_id: String(created.id),
              parent_id: String(batchLinkTarget.id),
              relation_type: 'REFERENCE'
            },
            {
              child_id: String(created.id),
              parent_id: String(extraParent.id),
              relation_type: 'REFERENCE'
            }
          ]
        }
      }
    })
    expect(linkNodesFailRpc.result.isError).toBeTruthy()
    expect(linkNodesFailRpc.result.structuredContent.rolled_back).toBeTruthy()
    expect(linkNodesFailRpc.result.structuredContent.failed).toBeGreaterThan(0)
    expect(linkNodesFailRpc.result.structuredContent.results.some(r => r.status === 'failed')).toBeTruthy()

    const readAfterFailedBatchRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'read-after-failed-batch',
      method: 'tools/call',
      params: {
        name: 'read_node',
        arguments: { node_id: String(created.id) }
      }
    })
    const parentIdsAfterFailedBatch = readAfterFailedBatchRpc.result.structuredContent.parents.map(p => String(p.id))
    expect(parentIdsAfterFailedBatch).not.toContain(String(extraParent.id))

    const unlinkNodesRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'unlink-nodes',
      method: 'tools/call',
      params: {
        name: 'unlink_nodes',
        arguments: {
          links: [
            {
              child_id: String(created.id),
              parent_id: String(batchLinkTarget.id)
            }
          ]
        }
      }
    })
    expect(unlinkNodesRpc.result.structuredContent.unlinked).toBe(1)
    expect(unlinkNodesRpc.result.structuredContent.failed).toBe(0)

    // unlink_node on the sole parent is rejected (a node must keep at least one parent)
    // At this point `created` is only linked to root.
    const unlinkLastParentRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'unlink-last-parent',
      method: 'tools/call',
      params: {
        name: 'unlink_node',
        arguments: {
          child_id: String(created.id),
          parent_id: String(rootNodeId)
        }
      }
    })
    expect(unlinkLastParentRpc.result.isError).toBeTruthy()
    // The relation must still exist after the rejected unlink.
    const readAfterLastParentRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'read-after-last-parent',
      method: 'tools/call',
      params: { name: 'read_node', arguments: { node_id: String(created.id) } }
    })
    expect(readAfterLastParentRpc.result.structuredContent.parents.map(p => String(p.id))).toContain(String(rootNodeId))

    // unlink_nodes on the sole parent is rejected and the batch is rolled back
    const unlinkNodesLastParentRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'unlink-nodes-last-parent',
      method: 'tools/call',
      params: {
        name: 'unlink_nodes',
        arguments: { links: [{ child_id: String(created.id), parent_id: String(rootNodeId) }] }
      }
    })
    expect(unlinkNodesLastParentRpc.result.structuredContent.rolled_back).toBeTruthy()
    expect(unlinkNodesLastParentRpc.result.structuredContent.failed).toBeGreaterThan(0)
    // ロールバックされたバッチ失敗は isError で示される（MCPクライアントは isError で失敗判定する）
    expect(unlinkNodesLastParentRpc.result.isError).toBeTruthy()

    // move_node: relocate a node from one parent to another, inheriting relation_type
    const moveChildRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'create-move-child',
      method: 'tools/call',
      params: { name: 'create_node', arguments: { title: 'MCP Move Child', parent_ids: [String(rootNodeId)], relation_type: 'REFERENCE' } }
    })
    const moveChild = moveChildRpc.result.structuredContent
    const moveDestRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'create-move-dest',
      method: 'tools/call',
      params: { name: 'create_node', arguments: { title: 'MCP Move Dest', parent_ids: [String(rootNodeId)], relation_type: 'STRUCTURAL' } }
    })
    const moveDest = moveDestRpc.result.structuredContent

    const moveNodeRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'move-node',
      method: 'tools/call',
      params: {
        name: 'move_node',
        arguments: { child_id: String(moveChild.id), from_parent_id: String(rootNodeId), to_parent_id: String(moveDest.id) }
      }
    })
    expect(moveNodeRpc.result.isError).toBeFalsy()
    expect(moveNodeRpc.result.structuredContent.success).toBeTruthy()
    expect(moveNodeRpc.result.structuredContent.child_id).toBe(String(moveChild.id))
    expect(moveNodeRpc.result.structuredContent.from_parent_id).toBe(String(rootNodeId))
    expect(moveNodeRpc.result.structuredContent.to_parent_id).toBe(String(moveDest.id))
    // relation_type is inherited from the original (root) edge, which was REFERENCE
    expect(moveNodeRpc.result.structuredContent.relation_type_name).toBe('REFERENCE')

    // moveChild is now under moveDest and no longer under root
    const readAfterMoveRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'read-after-move',
      method: 'tools/call',
      params: { name: 'read_node', arguments: { node_id: String(moveChild.id) } }
    })
    const moveChildParents = readAfterMoveRpc.result.structuredContent.parents.map(p => String(p.id))
    expect(moveChildParents).toContain(String(moveDest.id))
    expect(moveChildParents).not.toContain(String(rootNodeId))

    // move_node rejects same source and destination parent
    const moveSameRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'move-same',
      method: 'tools/call',
      params: {
        name: 'move_node',
        arguments: { child_id: String(moveChild.id), from_parent_id: String(moveDest.id), to_parent_id: String(moveDest.id) }
      }
    })
    expect(moveSameRpc.result.isError).toBeTruthy()

    // move_node rejects a cycle: moving moveDest under its own descendant (moveChild)
    const moveCycleRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'move-cycle',
      method: 'tools/call',
      params: {
        name: 'move_node',
        arguments: { child_id: String(moveDest.id), from_parent_id: String(rootNodeId), to_parent_id: String(moveChild.id) }
      }
    })
    expect(moveCycleRpc.result.isError).toBeTruthy()

    // move_nodes: batch relocation and rollback on failure
    const moveBatchARpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'create-move-batch-a',
      method: 'tools/call',
      params: { name: 'create_node', arguments: { title: 'MCP Move Batch A', parent_ids: [String(rootNodeId)], relation_type: 'STRUCTURAL' } }
    })
    const moveBatchA = moveBatchARpc.result.structuredContent

    const moveNodesRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'move-nodes',
      method: 'tools/call',
      params: {
        name: 'move_nodes',
        arguments: { moves: [{ child_id: String(moveBatchA.id), from_parent_id: String(rootNodeId), to_parent_id: String(moveDest.id) }] }
      }
    })
    expect(moveNodesRpc.result.isError).toBeFalsy()
    expect(moveNodesRpc.result.structuredContent.moved).toBe(1)
    expect(moveNodesRpc.result.structuredContent.failed).toBe(0)
    expect(moveNodesRpc.result.structuredContent.rolled_back).toBeFalsy()

    // move_nodes rollback: a move whose from_parent_id is not a real parent fails the whole batch
    const moveNodesFailRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'move-nodes-fail',
      method: 'tools/call',
      params: {
        name: 'move_nodes',
        arguments: { moves: [{ child_id: String(moveBatchA.id), from_parent_id: String(rootNodeId), to_parent_id: String(moveChild.id) }] }
      }
    })
    expect(moveNodesFailRpc.result.structuredContent.rolled_back).toBeTruthy()
    expect(moveNodesFailRpc.result.structuredContent.failed).toBeGreaterThan(0)
    // ロールバックされたバッチ失敗は isError で示される（MCPクライアントは isError で失敗判定する）
    expect(moveNodesFailRpc.result.isError).toBeTruthy()

    // content を伴う update_node は if_version が必須。
    // 値は直前の read から取る（固定値を書くとテスト順序の変更で壊れる）
    const readBeforeUpdateRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'read-before-update',
      method: 'tools/call',
      params: {
        name: 'read_node',
        arguments: { node_id: String(created.id) }
      }
    })
    const versionBeforeUpdate = readBeforeUpdateRpc.result.structuredContent.version
    expect(versionBeforeUpdate).toBeGreaterThanOrEqual(1)

    const updateNodeRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'update-node',
      method: 'tools/call',
      params: {
        name: 'update_node',
        arguments: {
          node_id: String(created.id),
          title: 'MCP Node Updated',
          content: 'updated by MCP',
          if_version: versionBeforeUpdate,
          child_sort_mode: 'updated_at',
          child_sort_direction: 'desc'
        }
      }
    })
    expect(updateNodeRpc.result.structuredContent.success).toBeTruthy()
    expect(updateNodeRpc.result.structuredContent.updated_at).toBeTruthy()
    const readAfterUpdateRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'read-after-update',
      method: 'tools/call',
      params: {
        name: 'read_node',
        arguments: { node_id: String(created.id) }
      }
    })
    expect(readAfterUpdateRpc.result.structuredContent.title).toBe('MCP Node Updated')
    expect(readAfterUpdateRpc.result.structuredContent.content).toBe('updated by MCP')
    expect(readAfterUpdateRpc.result.structuredContent.child_sort_mode).toBe('updated_at')
    expect(readAfterUpdateRpc.result.structuredContent.child_sort_direction).toBe('desc')

    // update_node can restore created_at / updated_at when supplied
    const updateRestoredCreatedAt = '2025-11-02 03:04:05'
    const updateRestoredUpdatedAt = '2025-11-03 04:05:06'
    const updateWithTimestampsRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'update-node-timestamps',
      method: 'tools/call',
      params: {
        name: 'update_node',
        arguments: {
          node_id: String(created.id),
          created_at: updateRestoredCreatedAt,
          updated_at: updateRestoredUpdatedAt
        }
      }
    })
    expect(updateWithTimestampsRpc.result.isError).toBeFalsy()
    expect(updateWithTimestampsRpc.result.structuredContent.success).toBeTruthy()
    expect(updateWithTimestampsRpc.result.structuredContent.updated_at).toBe(updateRestoredUpdatedAt)
    const readAfterTimestampsRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'read-after-timestamps',
      method: 'tools/call',
      params: {
        name: 'read_node',
        arguments: { node_id: String(created.id) }
      }
    })
    expect(readAfterTimestampsRpc.result.structuredContent.created_at).toBe(updateRestoredCreatedAt)
    expect(readAfterTimestampsRpc.result.structuredContent.updated_at).toBe(updateRestoredUpdatedAt)
    // title/content are preserved when only timestamps are updated
    expect(readAfterTimestampsRpc.result.structuredContent.title).toBe('MCP Node Updated')
    expect(readAfterTimestampsRpc.result.structuredContent.content).toBe('updated by MCP')

    // omitting updated_at falls back to the current time (not the restored value)
    const updateWithoutUpdatedAtRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'update-node-auto-updated-at',
      method: 'tools/call',
      params: {
        name: 'update_node',
        arguments: {
          node_id: String(created.id),
          content: 'updated by MCP',
          // 直前の read_after_timestamps が返した version を使う（固定値を書かない）
          if_version: readAfterTimestampsRpc.result.structuredContent.version
        }
      }
    })
    expect(updateWithoutUpdatedAtRpc.result.isError).toBeFalsy()
    expect(updateWithoutUpdatedAtRpc.result.structuredContent.success).toBeTruthy()
    expect(updateWithoutUpdatedAtRpc.result.structuredContent.updated_at).not.toBe(updateRestoredUpdatedAt)
    const readAfterAutoUpdatedAtRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'read-after-auto-updated-at',
      method: 'tools/call',
      params: {
        name: 'read_node',
        arguments: { node_id: String(created.id) }
      }
    })
    // created_at is left unchanged when not supplied
    expect(readAfterAutoUpdatedAtRpc.result.structuredContent.created_at).toBe(updateRestoredCreatedAt)

    // update_node with no updatable field is rejected
    const updateNoFieldRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'update-node-no-field',
      method: 'tools/call',
      params: {
        name: 'update_node',
        arguments: { node_id: String(created.id) }
      }
    })
    expect(updateNoFieldRpc.result.isError).toBeTruthy()

    // update_node_title changes only the title and preserves content
    const updateTitleRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'update-node-title',
      method: 'tools/call',
      params: {
        name: 'update_node_title',
        arguments: {
          node_id: String(created.id),
          title: 'MCP Node Retitled'
        }
      }
    })
    expect(updateTitleRpc.result.structuredContent.success).toBeTruthy()
    expect(updateTitleRpc.result.structuredContent.updated_at).toBeTruthy()
    const readAfterTitleRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'read-after-title',
      method: 'tools/call',
      params: {
        name: 'read_node',
        arguments: { node_id: String(created.id) }
      }
    })
    expect(readAfterTitleRpc.result.structuredContent.title).toBe('MCP Node Retitled')
    expect(readAfterTitleRpc.result.structuredContent.content).toBe('updated by MCP')

    // update_node_title without a title is rejected
    const updateTitleMissingRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'update-node-title-missing',
      method: 'tools/call',
      params: {
        name: 'update_node_title',
        arguments: { node_id: String(created.id) }
      }
    })
    expect(updateTitleMissingRpc.result.isError).toBeTruthy()

    // rename back so later search assertions keep matching
    await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'update-node-title-restore',
      method: 'tools/call',
      params: {
        name: 'update_node_title',
        arguments: {
          node_id: String(created.id),
          title: 'MCP Node Updated'
        }
      }
    })

    const scopedChildRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'create-scoped-child',
      method: 'tools/call',
      params: {
        name: 'create_node',
        arguments: {
          title: 'MCP Scoped Child',
          content: 'scoped search target',
          parent_ids: [String(created.id)],
          relation_type: 'STRUCTURAL'
        }
      }
    })
    const scopedChild = scopedChildRpc.result.structuredContent

    const searchRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'search',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: { keyword: 'MCP Node Updated', limit: 1, offset: 0 }
      }
    })
    expect(Array.isArray(searchRpc.result.structuredContent.items)).toBeTruthy()
    expect(searchRpc.result.structuredContent.items.some(n => String(n.id) === String(created.id))).toBeTruthy()
    const firstItem = searchRpc.result.structuredContent.items[0]
    expect(firstItem).toHaveProperty('id')
    expect(firstItem).toHaveProperty('title')
    expect(firstItem).toHaveProperty('relation_type_name')
    expect(firstItem).toHaveProperty('path')
    expect(firstItem).toHaveProperty('created_at')
    expect(firstItem).toHaveProperty('updated_at')
    expect(firstItem).toHaveProperty('path_relation_mode')
    expect(firstItem.content).toBeUndefined()
    expect(firstItem.author).toBeUndefined()
    expect(searchRpc.result.structuredContent.limit).toBe(1)
    expect(searchRpc.result.structuredContent.offset).toBe(0)
    expect(searchRpc.result.structuredContent.returned).toBe(1)
    expect(searchRpc.result.structuredContent.has_more).toBeFalsy()

    const searchByQueryAliasRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'search-by-query-alias',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: { query: 'MCP Node Updated', limit: 1, offset: 0 }
      }
    })
    expect(searchByQueryAliasRpc.result.isError).toBeFalsy()
    expect(searchByQueryAliasRpc.result.structuredContent.items.some(n => String(n.id) === String(created.id))).toBeTruthy()

    const missingKeywordRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'search-missing-keyword',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: { limit: 1, offset: 0 }
      }
    })
    expect(missingKeywordRpc.result.isError).toBeTruthy()

    const appendEmptyContentRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'append-empty-content',
      method: 'tools/call',
      params: {
        name: 'append_node_content',
        arguments: {
          node_id: String(created.id),
          content: '',
        }
      }
    })
    expect(appendEmptyContentRpc.result.isError).toBeTruthy()

    const appendInvalidNodeIdRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'append-invalid-node-id',
      method: 'tools/call',
      params: {
        name: 'append_node_content',
        arguments: {
          node_id: 'invalid',
          content: 'part',
        }
      }
    })
    expect(appendInvalidNodeIdRpc.result.isError).toBeTruthy()

    const outsideTree = await createTree(page, 'MCP Outside Scope Tree')
    const outsideRootNodeId = await getTreeRootNodeId(page, outsideTree.id)
    const outsideNode = await createNodeWithParent(page, outsideTree.id, 'Outside Scope Node', outsideRootNodeId)
    const appendOutOfScopeRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'append-out-of-scope',
      method: 'tools/call',
      params: {
        name: 'append_node_content',
        arguments: {
          node_id: String(outsideNode.id),
          content: 'part',
        }
      }
    })
    expect(appendOutOfScopeRpc.result.isError).toBeTruthy()

    const pagedSearchRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'search-paged',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: { keyword: 'MCP', limit: 1, offset: 0 }
      }
    })
    expect(pagedSearchRpc.result.structuredContent.returned).toBe(1)
    expect(pagedSearchRpc.result.structuredContent.has_more).toBeTruthy()
    expect(Number(pagedSearchRpc.result.structuredContent.next_offset)).toBe(1)

    const andSearchRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'search-and',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: { keyword: 'MCP Scoped' }
      }
    })
    expect(andSearchRpc.result.structuredContent.items.some(n => String(n.id) === String(scopedChild.id))).toBeTruthy()

    const strictAndSearchRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'search-and-strict',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: {
          keyword: 'MCP MissingTerm',
          match_mode: 'and'
        }
      }
    })
    expect(strictAndSearchRpc.result.structuredContent.returned).toBe(0)

    const orSearchRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'search-or',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: {
          keyword: 'MCP MissingTerm',
          match_mode: 'or'
        }
      }
    })
    expect(orSearchRpc.result.structuredContent.items.some(n => String(n.id) === String(created.id))).toBeTruthy()

    const excludeSearchRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'search-exclude',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: {
          keyword: 'MCP',
          exclude_keywords: 'Scoped'
        }
      }
    })
    expect(excludeSearchRpc.result.structuredContent.items.some(n => String(n.id) === String(scopedChild.id))).toBeFalsy()
    expect(excludeSearchRpc.result.structuredContent.items.some(n => String(n.id) === String(created.id))).toBeTruthy()

    const createdAscSearchRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'search-created-asc',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: {
          keyword: 'MCP',
          sort_by: 'created_at',
          sort_order: 'asc'
        }
      }
    })
    const createdAscItems = createdAscSearchRpc.result.structuredContent.items
    for (let i = 1; i < createdAscItems.length; i += 1) {
      const prev = createdAscItems[i - 1]
      const curr = createdAscItems[i]
      // Public node IDs no longer track internal numeric id order, so only the
      // primary sort key (created_at) is assertable from the client side.
      expect(prev.created_at <= curr.created_at).toBeTruthy()
    }

    const updatedAscSearchRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'search-updated-asc',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: {
          keyword: 'MCP',
          sort_by: 'updated_at',
          sort_order: 'asc'
        }
      }
    })
    const updatedAscItems = updatedAscSearchRpc.result.structuredContent.items
    for (let i = 1; i < updatedAscItems.length; i += 1) {
      const prev = updatedAscItems[i - 1]
      const curr = updatedAscItems[i]
      // Public node IDs no longer track internal numeric id order, so only the
      // primary sort key (updated_at) is assertable from the client side.
      expect(prev.updated_at <= curr.updated_at).toBeTruthy()
    }

    const invalidMatchModeRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'search-invalid-match-mode',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: {
          keyword: 'MCP',
          match_mode: 'xor'
        }
      }
    })
    expect(invalidMatchModeRpc.result.isError).toBeTruthy()

    const invalidSortByRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'search-invalid-sort-by',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: {
          keyword: 'MCP',
          sort_by: 'title'
        }
      }
    })
    expect(invalidSortByRpc.result.isError).toBeTruthy()

    const invalidSortOrderRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'search-invalid-sort-order',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: {
          keyword: 'MCP',
          sort_order: 'up'
        }
      }
    })
    expect(invalidSortOrderRpc.result.isError).toBeTruthy()

    const scopeSearchRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'search-scope',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: {
          keyword: 'Scoped Child',
          parent_node_id: String(created.id)
        }
      }
    })
    expect(scopeSearchRpc.result.structuredContent.items.some(n => String(n.id) === String(scopedChild.id))).toBeTruthy()

    const invalidScopeSearchRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'search-scope-invalid',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: {
          keyword: 'MCP',
          parent_node_id: 'invalid'
        }
      }
    })
    expect(invalidScopeSearchRpc.result.isError).toBeTruthy()

    // ---- trash ----

    const trashTargetRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'trash-target',
      method: 'tools/call',
      params: {
        name: 'create_node',
        arguments: {
          title: 'MCP Trash Target',
          parent_ids: [String(rootNodeId)],
          relation_type: 'STRUCTURAL'
        }
      }
    })
    const trashTarget = trashTargetRpc.result.structuredContent

    const trashTargetMoveRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'trash-target-move',
      method: 'tools/call',
      params: {
        name: 'trash_node',
        arguments: { node_id: String(trashTarget.id) }
      }
    })
    expect(trashTargetMoveRpc.result.structuredContent.status).toBe('moved_to_trash')
    expect(trashTargetMoveRpc.result.structuredContent.deleted_at).toBeTruthy()

  })

  test('TC-MCP-API-009: get_children で子一覧の詳細取得とページングができる', async ({ page }) => {
    const tree = await createTree(page, 'MCP Children Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const issued = await issueMcpAuth(page, tree.id, 'full_access')

    const parent = await createNodeWithParent(page, tree.id, 'Children Parent', rootNodeId)
    const firstChild = await createNodeWithParentAndContent(
      page,
      tree.id,
      'Children First',
      'First child body',
      parent.id
    )
    await createNodeWithParentAndContent(
      page,
      tree.id,
      'Children Second',
      'Second child body',
      parent.id
    )
    const thirdChild = await createNodeWithParentAndContent(
      page,
      tree.id,
      'Children Third',
      'Third child body',
      parent.id
    )
    const childrenSampleImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
    const firstChildImageRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'create-child-image',
      method: 'tools/call',
      params: {
        name: 'create_node_image',
        arguments: {
          node_id: String(firstChild.id),
          filename: 'children-first.png',
          content_type: 'image/png',
          data_base64: childrenSampleImageBase64
        }
      }
    })
    expect(firstChildImageRpc.result.isError).toBeFalsy()

    const firstPageRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'get-children-first-page',
      method: 'tools/call',
      params: {
        name: 'get_children',
        arguments: {
          node_id: String(parent.id),
          limit: 2,
          offset: 0
        }
      }
    })
    expect(firstPageRpc.result.isError).toBeFalsy()
    expect(firstPageRpc.result.structuredContent.limit).toBe(2)
    expect(firstPageRpc.result.structuredContent.offset).toBe(0)
    expect(firstPageRpc.result.structuredContent.returned).toBe(2)
    expect(firstPageRpc.result.structuredContent.has_more).toBeTruthy()
    expect(Number(firstPageRpc.result.structuredContent.next_offset)).toBe(2)
    expect(Array.isArray(firstPageRpc.result.structuredContent.items)).toBeTruthy()
    expect(firstPageRpc.result.structuredContent.items).toHaveLength(2)
    const firstItem = firstPageRpc.result.structuredContent.items[0]
    expect(String(firstItem.id)).toBe(String(firstChild.id))
    expect(firstItem.title).toBe('Children First')
    expect(firstItem.content).toBe('First child body')
    expect(firstItem.author).toBeTruthy()
    expect(firstItem.created_at).toBeTruthy()
    expect(firstItem.updated_at).toBeTruthy()
    expect(firstItem.child_sort_mode).toBeTruthy()
    expect(firstItem.child_sort_direction).toBeTruthy()
    expect(firstItem.path).toBeTruthy()
    expect(firstItem.path_relation_mode).toBeTruthy()
    expect(firstItem.relation_type_name).toBeTruthy()
    expect(firstItem.children).toBeUndefined()
    expect(firstItem.parents).toBeUndefined()
    expect(firstItem.images).toBeUndefined()
    expect(Object.keys(firstItem).sort()).toEqual([
      'author',
      'child_sort_direction',
      'child_sort_mode',
      'content',
      'created_at',
      'id',
      'path',
      'path_relation_mode',
      'relation_type_name',
      'title',
      'updated_at'
      ,'version'
    ])

    const withImagesRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'get-children-with-images',
      method: 'tools/call',
      params: {
        name: 'get_children',
        arguments: {
          node_id: String(parent.id),
          limit: 2,
          offset: 0,
          include_images: true
        }
      }
    })
    expect(withImagesRpc.result.isError).toBeFalsy()
    const firstItemWithImages = withImagesRpc.result.structuredContent.items[0]
    expect(firstItemWithImages.images).toEqual([
      {
        id: firstChildImageRpc.result.structuredContent.image_id,
        filename: 'children-first.png',
        content_type: 'image/png'
      }
    ])

    const secondPageRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'get-children-second-page',
      method: 'tools/call',
      params: {
        name: 'get_children',
        arguments: {
          node_id: String(parent.id),
          limit: 2,
          offset: 2
        }
      }
    })
    expect(secondPageRpc.result.isError).toBeFalsy()
    expect(secondPageRpc.result.structuredContent.limit).toBe(2)
    expect(secondPageRpc.result.structuredContent.offset).toBe(2)
    expect(secondPageRpc.result.structuredContent.returned).toBe(1)
    expect(secondPageRpc.result.structuredContent.has_more).toBeFalsy()
    expect(secondPageRpc.result.structuredContent.next_offset).toBeUndefined()
    expect(secondPageRpc.result.structuredContent.items).toHaveLength(1)
    expect(String(secondPageRpc.result.structuredContent.items[0].id)).toBe(String(thirdChild.id))
    expect(secondPageRpc.result.structuredContent.items[0].content).toBe('Third child body')

    const invalidNodeRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'get-children-invalid-node',
      method: 'tools/call',
      params: {
        name: 'get_children',
        arguments: {
          node_id: 'invalid'
        }
      }
    })
    expect(invalidNodeRpc.result.isError).toBeTruthy()

    const outsideTree = await createTree(page, 'MCP Children Outside Scope Tree')
    const outsideRootNodeId = await getTreeRootNodeId(page, outsideTree.id)
    const outsideScopeRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'get-children-outside-scope',
      method: 'tools/call',
      params: {
        name: 'get_children',
        arguments: {
          node_id: String(outsideRootNodeId)
        }
      }
    })
    expect(outsideScopeRpc.result.isError).toBeTruthy()
    expect(String(outsideScopeRpc.result.content?.[0]?.text || '')).toContain('Node not found')
  })

  test('TC-MCP-API-010: get_parents で親一覧の詳細取得とページングができる', async ({ page }) => {
    const tree = await createTree(page, 'MCP Parents Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const issued = await issueMcpAuth(page, tree.id, 'full_access')

    const parentA = await createNodeWithParentAndContent(
      page,
      tree.id,
      'Parents First',
      'First parent body',
      rootNodeId
    )
    const parentB = await createNodeWithParentAndContent(
      page,
      tree.id,
      'Parents Second',
      'Second parent body',
      rootNodeId
    )
    const parentC = await createNodeWithParentAndContent(
      page,
      tree.id,
      'Parents Third',
      'Third parent body',
      rootNodeId
    )

    const child = await createNodeWithParentAndContent(
      page,
      tree.id,
      'Parents Child',
      'Child body',
      parentA.id
    )

    const linkParentBRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'link-parent-b',
      method: 'tools/call',
      params: {
        name: 'link_node',
        arguments: {
          child_id: String(child.id),
          parent_id: String(parentB.id),
          relation_type: 'REFERENCE'
        }
      }
    })
    expect(linkParentBRpc.result.isError).toBeFalsy()

    const linkParentCRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'link-parent-c',
      method: 'tools/call',
      params: {
        name: 'link_node',
        arguments: {
          child_id: String(child.id),
          parent_id: String(parentC.id),
          relation_type: 'REFERENCE'
        }
      }
    })
    expect(linkParentCRpc.result.isError).toBeFalsy()

    const firstPageRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'get-parents-first-page',
      method: 'tools/call',
      params: {
        name: 'get_parents',
        arguments: {
          node_id: String(child.id),
          limit: 2,
          offset: 0
        }
      }
    })
    expect(firstPageRpc.result.isError).toBeFalsy()
    expect(firstPageRpc.result.structuredContent.limit).toBe(2)
    expect(firstPageRpc.result.structuredContent.offset).toBe(0)
    expect(firstPageRpc.result.structuredContent.returned).toBe(2)
    expect(firstPageRpc.result.structuredContent.has_more).toBeTruthy()
    expect(Number(firstPageRpc.result.structuredContent.next_offset)).toBe(2)
    expect(Array.isArray(firstPageRpc.result.structuredContent.items)).toBeTruthy()
    expect(firstPageRpc.result.structuredContent.items).toHaveLength(2)
    const firstItem = firstPageRpc.result.structuredContent.items[0]
    expect(String(firstItem.id)).toBe(String(parentA.id))
    expect(firstItem.title).toBe('Parents First')
    expect(firstItem.content).toBe('First parent body')
    expect(firstItem.author).toBeTruthy()
    expect(firstItem.created_at).toBeTruthy()
    expect(firstItem.updated_at).toBeTruthy()
    expect(firstItem.child_sort_mode).toBeTruthy()
    expect(firstItem.child_sort_direction).toBeTruthy()
    expect(firstItem.path).toBeTruthy()
    expect(firstItem.path_relation_mode).toBeTruthy()
    expect(firstItem.relation_type_name).toBe('STRUCTURAL')
    expect(firstItem.children).toBeUndefined()
    expect(firstItem.parents).toBeUndefined()
    expect(Object.keys(firstItem).sort()).toEqual([
      'author',
      'child_sort_direction',
      'child_sort_mode',
      'content',
      'created_at',
      'id',
      'path',
      'path_relation_mode',
      'relation_type_name',
      'title',
      'updated_at'
      ,'version'
    ])

    const secondItem = firstPageRpc.result.structuredContent.items[1]
    expect(String(secondItem.id)).toBe(String(parentB.id))
    expect(secondItem.title).toBe('Parents Second')
    expect(secondItem.content).toBe('Second parent body')
    expect(secondItem.relation_type_name).toBe('REFERENCE')
    expect(secondItem.children).toBeUndefined()
    expect(secondItem.parents).toBeUndefined()

    const secondPageRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'get-parents-second-page',
      method: 'tools/call',
      params: {
        name: 'get_parents',
        arguments: {
          node_id: String(child.id),
          limit: 2,
          offset: 2
        }
      }
    })
    expect(secondPageRpc.result.isError).toBeFalsy()
    expect(secondPageRpc.result.structuredContent.limit).toBe(2)
    expect(secondPageRpc.result.structuredContent.offset).toBe(2)
    expect(secondPageRpc.result.structuredContent.returned).toBe(1)
    expect(secondPageRpc.result.structuredContent.has_more).toBeFalsy()
    expect(secondPageRpc.result.structuredContent.next_offset).toBeUndefined()
    expect(secondPageRpc.result.structuredContent.items).toHaveLength(1)
    expect(String(secondPageRpc.result.structuredContent.items[0].id)).toBe(String(parentC.id))
    expect(secondPageRpc.result.structuredContent.items[0].title).toBe('Parents Third')
    expect(secondPageRpc.result.structuredContent.items[0].content).toBe('Third parent body')
    expect(secondPageRpc.result.structuredContent.items[0].relation_type_name).toBe('REFERENCE')
    expect(secondPageRpc.result.structuredContent.items[0].children).toBeUndefined()
    expect(secondPageRpc.result.structuredContent.items[0].parents).toBeUndefined()

    const invalidNodeRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'get-parents-invalid-node',
      method: 'tools/call',
      params: {
        name: 'get_parents',
        arguments: {
          node_id: 'invalid'
        }
      }
    })
    expect(invalidNodeRpc.result.isError).toBeTruthy()

    const outsideTree = await createTree(page, 'MCP Parents Outside Scope Tree')
    const outsideRootNodeId = await getTreeRootNodeId(page, outsideTree.id)
    const outsideScopeRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'get-parents-outside-scope',
      method: 'tools/call',
      params: {
        name: 'get_parents',
        arguments: {
          node_id: String(outsideRootNodeId)
        }
      }
    })
    expect(outsideScopeRpc.result.isError).toBeTruthy()
    expect(String(outsideScopeRpc.result.content?.[0]?.text || '')).toContain('Node not found')
  })

  test('TC-MCP-API-003: 不正トークンは401', async ({ page }) => {
    const tree = await createTree(page, 'MCP Invalid Token Tree')

    const res = await page.request.post(mcpResourceUrl(tree.id), {
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer invalid-token',
      },
      data: { jsonrpc: '2.0', id: 'invalid', method: 'tools/list' },
    })
    expect(res.status()).toBe(401)
    const data = await res.json()
    expect(data.success).toBeFalsy()
  })

  test('TC-MCP-API-011: create_node_tree の schema は children.items を持つ', async ({ page }) => {
    const tree = await createTree(page, 'MCP Schema Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const issued = await issueMcpAuth(page, tree.id)

    const toolsList = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'tools-list-schema',
      method: 'tools/list',
      params: {}
    })
    const createNodeTreeTool = toolsList.result.tools.find(t => t.name === 'create_node_tree')
    expect(createNodeTreeTool?.inputSchema?.properties?.nodes?.items).toEqual({ $ref: '#/$defs/createNodeTreeNodeInput' })
    expect(createNodeTreeTool?.inputSchema?.$defs?.createNodeTreeNodeInput?.properties?.children?.items).toEqual({ $ref: '#/$defs/createNodeTreeNodeInput' })
    expect(createNodeTreeTool?.inputSchema?.$defs?.createNodeTreeNodeInput?.properties?.child_sort_mode?.enum).toContain('title')
    expect(createNodeTreeTool?.inputSchema?.$defs?.createNodeTreeNodeInput?.properties?.child_sort_direction?.enum).toContain('desc')
  })

  test('TC-MCP-API-004: create_node_tree で階層を再帰作成できる', async ({ page }) => {
    const tree = await createTree(page, 'MCP Recursive Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const issued = await issueMcpAuth(page, tree.id)

    const createTreeRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'create-tree',
      method: 'tools/call',
      params: {
        name: 'create_node_tree',
        arguments: {
          parent_node_id: String(rootNodeId),
          nodes: [
            {
              title: 'Project A',
              content: 'Top level',
              child_sort_mode: 'title',
              child_sort_direction: 'desc',
              relation_type: 'STRUCTURAL',
              children: [
                {
                  title: 'Task A-1',
                  relation_type: 'STRUCTURAL',
                  children: [
                    {
                      title: 'Note A-1-x',
                      content: 'Leaf note',
                      relation_type: 'REFERENCE'
                    }
                  ]
                },
                {
                  title: 'Task A-2'
                }
              ]
            }
          ]
        }
      }
    })

    expect(createTreeRpc.result.structuredContent.created_count).toBe(4)
    const createdNodes = createTreeRpc.result.structuredContent.created_nodes
    expect(Array.isArray(createdNodes)).toBeTruthy()
    expect(createdNodes.some(n => n.title === 'Project A')).toBeTruthy()
    expect(createdNodes.some(n => n.title === 'Task A-1')).toBeTruthy()
    expect(createdNodes.some(n => n.title === 'Note A-1-x')).toBeTruthy()
    expect(createdNodes.some(n => n.title === 'Task A-2')).toBeTruthy()
    expect(createdNodes[0]).toHaveProperty('content')
    expect(createdNodes[0]).toHaveProperty('author')
    expect(createdNodes[0]).toHaveProperty('created_at')
    expect(createdNodes[0]).toHaveProperty('updated_at')
    expect(createdNodes[0].child_sort_mode).toBe('title')
    expect(createdNodes[0].child_sort_direction).toBe('desc')

    const searchRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'search-created',
      method: 'tools/call',
      params: {
        name: 'search_nodes',
        arguments: { keyword: 'Task A-1' }
      }
    })

    const hit = searchRpc.result.structuredContent.items.find(n => n.title === 'Task A-1')
    expect(hit).toBeTruthy()

    const readRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'read-created',
      method: 'tools/call',
      params: {
        name: 'read_node',
        arguments: { node_id: String(hit.id) }
      }
    })
    expect(readRpc.result.structuredContent.title).toBe('Task A-1')
    expect(readRpc.result.structuredContent.children.some(n => n.title === 'Note A-1-x')).toBeTruthy()
  })

  test('TC-MCP-API-005: ゴミ箱配下の子ノードを単体で完全削除できる', async ({ page }) => {
    const tree = await createTree(page, 'Trash Permanent Child Delete')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)

    const nodesRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes`)
    const nodesData = await nodesRes.json()
    expect(nodesRes.ok()).toBeTruthy()
    expect(nodesData.success).toBeTruthy()
    const trashRootNodeId = String(nodesData.trash_root_node_id)
    expect(trashRootNodeId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{6}$/)

    const aaa = await createNodeWithParent(page, tree.id, 'AAA', rootNodeId)
    const bbb = await createNodeWithParent(page, tree.id, 'BBB', aaa.id)

    const moveToTrashRes = await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${aaa.id}`)
    const moveToTrashData = await moveToTrashRes.json()
    expect(moveToTrashRes.ok()).toBeTruthy()
    expect(moveToTrashData.success).toBeTruthy()

    const permDeleteBbbRes = await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${bbb.id}/permanent`)
    const permDeleteBbbData = await permDeleteBbbRes.json()
    expect(permDeleteBbbRes.ok()).toBeTruthy()
    expect(permDeleteBbbData.success).toBeTruthy()
    expect(Number(permDeleteBbbData.deleted_count)).toBeGreaterThanOrEqual(1)

    const nodesAfterRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes`)
    const nodesAfterData = await nodesAfterRes.json()
    expect(nodesAfterRes.ok()).toBeTruthy()
    expect(nodesAfterData.success).toBeTruthy()
    expect(nodesAfterData.data.some(n => String(n.id) === String(bbb.id))).toBeFalsy()
    expect(nodesAfterData.data.some(n => String(n.id) === String(aaa.id))).toBeTruthy()
    expect(String(nodesAfterData.trash_root_node_id)).toBe(trashRootNodeId)
  })

  test('TC-MCP-API-006: 循環参照になるリンク作成はAPIで拒否される', async ({ page }) => {
    const tree = await createTree(page, 'Cycle Guard Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)

    const parent = await createNodeWithParent(page, tree.id, 'consultations', rootNodeId)
    const child = await createNodeWithParent(page, tree.id, 'service_histories', parent.id)

    const cycleRes = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/relations`, {
      data: {
        parent_node_id: String(child.id),
        child_node_id: String(parent.id),
        relation_type_id: 3
      }
    })
    const cycleData = await cycleRes.json()
    expect(cycleRes.status()).toBe(400)
    expect(cycleData.success).toBeFalsy()
    expect(String(cycleData.error || '')).toContain('Circular reference detected')
  })

  test('TC-MCP-API-018: ノード content の履歴・復元・purge', async ({ page }) => {
    const tree = await createTree(page, 'Node Content History')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const issued = await issueMcpAuth(page, tree.id)
    const node = await createNodeWithParentAndContent(page, tree.id, 'Undo target', 'V0', rootNodeId)

    const call = (id, name, arguments_) => callMcp(page, issued, {
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ },
    })
    const read = await call('read', 'read_node', { node_id: String(node.id) })
    const v1 = read.result.structuredContent.version
    const update = await call('update', 'update_node', { node_id: String(node.id), content: 'V1', if_version: v1 })
    expect(update.result.isError).toBeFalsy()
    const v2 = update.result.structuredContent.version
    const append = await call('append', 'append_node_content', { node_id: String(node.id), content: 'V2' })
    expect(append.result.isError).toBeFalsy()
    const v3 = append.result.structuredContent.version

    const restNode = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}`)
    const restNodeData = await restNode.json()
    const restSave = await page.request.put(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}`, {
      data: { title: 'Undo target', content: 'V3', version: restNodeData.data.version },
    })
    expect(restSave.ok()).toBeTruthy()

    const title = await call('title', 'update_node_title', { node_id: String(node.id), title: 'Undo target renamed' })
    expect(title.result.isError).toBeFalsy()
    const history = await call('history', 'read_node_history', { node_id: String(node.id) })
    expect(history.result.structuredContent.items.length).toBe(3)
    expect(history.result.structuredContent.items.map(x => x.node_version)).toEqual([v3, v2, v1])
    expect(history.result.structuredContent.items[0]).not.toHaveProperty('content')
    expect(history.result.structuredContent.items[0]).not.toHaveProperty('id')
    const historyWithContent = await call('history-content', 'read_node_history', { node_id: String(node.id), include_content: true })
    expect(historyWithContent.result.structuredContent.items[0].content).toBe('V1\nV2')

    const restore = await call('restore', 'restore_node_version', {
      node_id: String(node.id), node_version: v3, if_version: v3 + 2,
    })
    expect(restore.result.isError).toBeFalsy()
    expect(restore.result.structuredContent.version).toBe(v3 + 3)
    const afterRestore = await call('after-restore', 'read_node', { node_id: String(node.id) })
    expect(afterRestore.result.structuredContent.content).toBe('V1\nV2')
    const restoreHistory = await call('restore-history', 'read_node_history', { node_id: String(node.id), include_content: true })
    expect(restoreHistory.result.structuredContent.items.length).toBe(4)
    expect(restoreHistory.result.structuredContent.items[0].node_version).toBe(v3 + 2)
    expect(restoreHistory.result.structuredContent.items[0].content).toBe('V3')

    const staleRestore = await call('stale-restore', 'restore_node_version', {
      node_id: String(node.id), node_version: v1, if_version: v3,
    })
    expect(staleRestore.result.isError).toBeTruthy()
    expect(staleRestore.result.structuredContent.current_version).toBe(v3 + 3)
    expect(staleRestore.result.structuredContent.server_data.content).toBe('V1\nV2')

    for (let i = 0; i < 101; i += 1) {
      const current = await call(`purge-read-${i}`, 'read_node', { node_id: String(node.id) })
      await call(`purge-${i}`, 'append_node_content', { node_id: String(node.id), content: `p${i}` })
      expect(current.result.structuredContent.version).toBeGreaterThan(0)
    }
    const purgedHistory = await call('purged-history', 'read_node_history', { node_id: String(node.id) })
    expect(purgedHistory.result.structuredContent.items.length).toBe(20)
    expect(purgedHistory.result.structuredContent.returned).toBe(20)
    // 100件上限が効いていることは **total（保持総数）** で判定する。
    // items.length は readNodeSnapshots の clamp(100) に丸められるため、
    // 上限が壊れて105件残っていても100件返り、検知できない（偽陽性になる）
    expect(purgedHistory.result.structuredContent.total).toBe(100)
    const allHistory = await call('all-history', 'read_node_history', { node_id: String(node.id), limit: 100 })
    expect(allHistory.result.structuredContent.items.length).toBe(100)
    expect(allHistory.result.structuredContent.total).toBe(100)

    const imageNode = await createNodeWithParentAndContent(page, tree.id, 'Image side effect', 'image placeholder', rootNodeId)
    const imageRead = await call('image-read', 'read_node', { node_id: String(imageNode.id) })
    const image = await call('image-create', 'create_node_image', {
      node_id: String(imageNode.id), filename: 'undo.png', content_type: 'image/png',
      data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    })
    const imageUrl = image.result.structuredContent.url
    await call('image-content', 'update_node', {
      node_id: String(imageNode.id), content: `![image](${imageUrl})`, if_version: imageRead.result.structuredContent.version,
    })
    const imageHistoryBefore = await call('image-history-before', 'read_node_history', { node_id: String(imageNode.id), limit: 100 })
    const imageId = image.result.structuredContent.image_id
    const imageDelete = await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${imageNode.id}/images/${imageId}`)
    expect(imageDelete.ok()).toBeTruthy()
    const imageHistoryAfter = await call('image-history-after', 'read_node_history', { node_id: String(imageNode.id), limit: 100 })
    expect(imageHistoryAfter.result.structuredContent.items.length).toBe(imageHistoryBefore.result.structuredContent.items.length)

    const deleteNode = await createNodeWithParentAndContent(page, tree.id, 'Delete snapshots', 'before-delete', rootNodeId)
    const deleteRead = await call('delete-read', 'read_node', { node_id: String(deleteNode.id) })
    await call('delete-update', 'update_node', { node_id: String(deleteNode.id), content: 'after-delete', if_version: deleteRead.result.structuredContent.version })
    const trash = await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${deleteNode.id}`)
    expect(trash.ok()).toBeTruthy()
    const permanent = await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${deleteNode.id}/permanent`)
    expect(permanent.ok()).toBeTruthy()
    const deletedHistory = await call('deleted-history', 'read_node_history', { node_id: String(deleteNode.id) })
    expect(deletedHistory.result.isError).toBeTruthy()
  })

  test('TC-MCP-API-019: ノードcontentの部分編集・行単位読み取り・ノード内検索', async ({ page }) => {
    const tree = await createTree(page, 'MCP Partial Content Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const content = 'alpha\nneedle one\nmiddle\nneedle two\nneedle three'
    const node = await createNodeWithParentAndContent(page, tree.id, 'Partial node', content, rootNodeId)
    const issued = await issueMcpAuth(page, tree.id, 'full_access')
    const call = (id, name, arguments_) => callMcp(page, issued, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } })

    const full = await call('full', 'read_node', { node_id: String(node.id) })
    expect(full.result.structuredContent.content_total_lines).toBe(5)
    const sliced = await call('slice', 'read_node', { node_id: String(node.id), content_offset: 1, content_limit: 2 })
    expect(sliced.result.structuredContent.content).toBe('needle one\nmiddle')
    expect(sliced.result.structuredContent.content_offset).toBe(1)
    expect(sliced.result.structuredContent.content_limit).toBe(2)
    expect(sliced.result.structuredContent.content_total_lines).toBe(5)

    const found = await call('find', 'find_in_node', { node_id: String(node.id), keyword: 'needle', limit: 2 })
    expect(found.result.structuredContent.total).toBe(3)
    expect(found.result.structuredContent.returned).toBe(2)
    expect(found.result.structuredContent.items).toEqual([
      { line: 2, text: 'needle one' },
      { line: 4, text: 'needle two' },
    ])

    const missing = await call('missing', 'edit_node_content', { node_id: String(node.id), old_str: 'absent', new_str: 'changed' })
    expect(missing.result.isError).toBeTruthy()
    expect(missing.result.structuredContent.match_count).toBe(0)
    expect(missing.result.structuredContent.match_lines).toEqual([])
    const afterMissing = await call('after-missing', 'read_node', { node_id: String(node.id) })
    expect(afterMissing.result.structuredContent.content).toBe(content)

    const ambiguous = await call('ambiguous', 'edit_node_content', { node_id: String(node.id), old_str: 'needle', new_str: 'hit' })
    expect(ambiguous.result.isError).toBeTruthy()
    expect(ambiguous.result.structuredContent.match_count).toBe(3)
    expect(ambiguous.result.structuredContent.match_lines).toEqual([2, 4, 5])
    const afterAmbiguous = await call('after-ambiguous', 'read_node', { node_id: String(node.id) })
    expect(afterAmbiguous.result.structuredContent.content).toBe(content)

    expect(missing.result.structuredContent.error).toBe('No match')
    expect(ambiguous.result.structuredContent.error).toBe('Multiple matches')

    const invalidVersion = await call('invalid-version', 'edit_node_content', { node_id: String(node.id), old_str: 'alpha', new_str: 'omega', if_version: 0 })
    expect(invalidVersion.result.isError).toBeTruthy()
    expect(invalidVersion.result.structuredContent).toBeUndefined()
    expect(String(invalidVersion.result.content[0].text)).toContain('positive integer')

    const replaced = await call('replace-all', 'edit_node_content', { node_id: String(node.id), old_str: 'needle', new_str: 'hit', replace_all: true })
    expect(replaced.result.isError).toBeFalsy()
    expect(replaced.result.structuredContent.version).toBe(full.result.structuredContent.version + 1)
    const afterReplace = await call('after-replace', 'read_node', { node_id: String(node.id) })
    expect(afterReplace.result.structuredContent.content).toBe('alpha\nhit one\nmiddle\nhit two\nhit three')
    const history = await call('history', 'read_node_history', { node_id: String(node.id) })
    expect(history.result.structuredContent.total).toBe(1)
    expect(history.result.structuredContent.current_version).toBe(full.result.structuredContent.version + 1)
    expect(history.result.structuredContent.items[0].replaced_at).toBeTruthy()
    expect(history.result.structuredContent.items[0].created_at).toBeUndefined()
    expect(history.result.structuredContent.items[0].node_version).toBe(full.result.structuredContent.version)

    const stale = await call('stale', 'edit_node_content', { node_id: String(node.id), old_str: 'alpha', new_str: 'omega', if_version: full.result.structuredContent.version })
    expect(stale.result.isError).toBeTruthy()
    expect(stale.result.structuredContent.error).toBe('Version conflict')
    expect(stale.result.structuredContent.server_data.content).toContain('hit one')

    // 一意一致での置換（replace_all を付けない既定パス）。
    // このツールの主要な使い方であり、replace_all=true とは別のコードを通る。
    // ここを検証しないと、単一一致の置換を no-op に壊してもテストが通ってしまう
    const uniqueBefore = await call('unique-before', 'read_node', { node_id: String(node.id) })
    const historyBefore = await call('unique-history-before', 'read_node_history', { node_id: String(node.id) })
    const unique = await call('unique', 'edit_node_content', { node_id: String(node.id), old_str: 'middle', new_str: 'center' })
    expect(unique.result.isError).toBeFalsy()
    expect(unique.result.structuredContent.match_count).toBe(1)
    expect(unique.result.structuredContent.version).toBe(uniqueBefore.result.structuredContent.version + 1)
    const afterUnique = await call('after-unique', 'read_node', { node_id: String(node.id) })
    // 一致した1箇所だけが置換され、他の行は無傷であること
    expect(afterUnique.result.structuredContent.content).toBe('alpha\nhit one\ncenter\nhit two\nhit three')
    // 部分編集でもスナップショットが積まれること
    const historyAfter = await call('unique-history-after', 'read_node_history', { node_id: String(node.id) })
    expect(historyAfter.result.structuredContent.total).toBe(historyBefore.result.structuredContent.total + 1)
    expect(historyAfter.result.structuredContent.items[0].node_version).toBe(uniqueBefore.result.structuredContent.version)
  })

  test('TC-MCP-API-020: edit_node_content の逐次バッチ原子性と後方互換', async ({ page }) => {
    const tree = await createTree(page, 'MCP Batch Edit Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const originalContent = 'first needle\nsecond needle\nthird line'
    const node = await createNodeWithParentAndContent(page, tree.id, 'Batch node', originalContent, rootNodeId)
    const issued = await issueMcpAuth(page, tree.id, 'full_access')
    const call = (id, name, arguments_) => callMcp(page, issued, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } })
    const before = await call('before', 'read_node', { node_id: String(node.id) })
    const beforeHistory = await call('before-history', 'read_node_history', { node_id: String(node.id) })
    const batch = await call('batch', 'edit_node_content', { node_id: String(node.id), if_version: before.result.structuredContent.version, edits: [
      { old_str: 'first needle', new_str: 'first hit' },
      { old_str: 'second needle', new_str: 'second hit' },
    ] })
    expect(batch.result.isError).toBeFalsy()
    expect(batch.result.structuredContent.applied).toBe(2)
    expect(batch.result.structuredContent.version).toBe(before.result.structuredContent.version + 1)
    const after = await call('after', 'read_node', { node_id: String(node.id) })
    expect(after.result.structuredContent.content).toBe('first hit\nsecond hit\nthird line')
    const afterHistory = await call('after-history', 'read_node_history', { node_id: String(node.id) })
    expect(afterHistory.result.structuredContent.total).toBe(beforeHistory.result.structuredContent.total + 1)

    const failed = await call('failed', 'edit_node_content', { node_id: String(node.id), edits: [
      { old_str: 'first hit', new_str: 'first final' },
      { old_str: 'does not exist', new_str: 'bad' },
    ] })
    expect(failed.result.isError).toBeTruthy()
    expect(failed.result.structuredContent.edit_index).toBe(1)
    expect(failed.result.structuredContent.error).toBe('No match')
    expect(failed.result.structuredContent.match_count).toBe(0)
    const afterFailed = await call('after-failed', 'read_node', { node_id: String(node.id) })
    expect(afterFailed.result.structuredContent.content).toBe('first hit\nsecond hit\nthird line')

    const both = await call('both', 'edit_node_content', { node_id: String(node.id), old_str: 'third line', new_str: 'third', edits: [{ old_str: 'third line', new_str: 'third' }] })
    expect(both.result.isError).toBeTruthy()
    expect(String(both.result.content[0].text)).toContain('either edits[] or scalar')

    // 空の old_str は「一致しなかった」ではなく引数エラーであること
    const emptyOld = await call('empty-old', 'edit_node_content', { node_id: String(node.id), edits: [{ old_str: '', new_str: 'x' }] })
    expect(emptyOld.result.isError).toBeTruthy()
    expect(emptyOld.result.structuredContent.error).toBe('Invalid argument')
    expect(emptyOld.result.structuredContent.edit_index).toBe(0)
    expect(emptyOld.result.structuredContent.error).not.toBe('No match')

    const scalar = await call('scalar', 'edit_node_content', { node_id: String(node.id), old_str: 'third line', new_str: 'third' })
    expect(scalar.result.isError).toBeFalsy()
    expect(scalar.result.structuredContent.applied).toBe(1)
    // スカラ形は match_count を返す（後方互換）
    expect(scalar.result.structuredContent.match_count).toBe(1)
    expect(scalar.result.structuredContent.match_counts).toEqual([1])

    // inputSchema の必須が node_id だけであること。
    // old_str/new_str を required にしていると、スキーマ準拠のクライアントは
    // それらを必ず送るため edits[] と排他エラーになり **バッチが使用不能**になる。
    // テストは生の JSON-RPC を送るのでこの矛盾を通り抜けてしまうため、
    // スキーマ自体を検証する
    const toolsList = await callMcp(page, issued, { jsonrpc: '2.0', id: 'schema', method: 'tools/list', params: {} })
    const editTool = toolsList.result.tools.find(t => t.name === 'edit_node_content')
    expect(editTool.inputSchema.required).toEqual(['node_id'])
    expect(editTool.inputSchema.properties.edits).toBeTruthy()
  })

  test('TC-MCP-API-021: read_node_history は行IDを返さず、node_version の欠番は正常', async ({ page }) => {
    const tree = await createTree(page, 'History Row Identity')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const issued = await issueMcpAuth(page, tree.id)
    const node = await createNodeWithParentAndContent(page, tree.id, 'Gap target', 'A', rootNodeId)

    const call = (id, name, arguments_) => callMcp(page, issued, {
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ },
    })

    const read = await call('read', 'read_node', { node_id: String(node.id) })
    const vA = read.result.structuredContent.version

    // content 更新 → vA のスナップショットが積まれる
    const saveB = await call('save-b', 'update_node', { node_id: String(node.id), content: 'B', if_version: vA })
    expect(saveB.result.isError).toBeFalsy()
    const vB = saveB.result.structuredContent.version

    // タイトルだけの変更は version を進めるがスナップショットを積まない。
    // これが node_version の欠番を作る主要因
    const rename = await call('rename', 'update_node_title', { node_id: String(node.id), title: 'Gap target renamed' })
    expect(rename.result.isError).toBeFalsy()
    const vC = rename.result.structuredContent.version
    expect(vC).toBe(vB + 1)

    // 次の content 更新は vC のスナップショットを積む。vB は誰も持たない
    const saveD = await call('save-d', 'update_node', { node_id: String(node.id), content: 'D', if_version: vC })
    expect(saveD.result.isError).toBeFalsy()
    const vD = saveD.result.structuredContent.version

    const history = await call('history', 'read_node_history', { node_id: String(node.id) })
    expect(history.result.isError).toBeFalsy()
    const items = history.result.structuredContent.items
    expect(items.map(x => x.node_version)).toEqual([vC, vA])
    // 欠番そのものの検証：vB は履歴に存在しない
    expect(items.map(x => x.node_version)).not.toContain(vB)
    expect(vC - vA).toBe(2)
    expect(history.result.structuredContent.current_version).toBe(vD)

    // 応答の形を完全一致で固定する。
    // node_snapshots.id はテーブル全体で共有する採番なので1ノードの履歴では必ず飛ぶ。
    // 版の識別子と誤読されるため返してはいけない（他の全ツールで id は
    // 公開ノードID=6文字 base58 を意味する）。ここを完全一致にしておけば、
    // 将来 id に限らずどんな余計な項目が混ざっても落ちる
    expectExactKeys(
      history.result.structuredContent,
      ['node_id', 'current_version', 'total', 'limit', 'returned', 'items'],
      'read_node_history の応答',
    )
    for (const item of items) {
      expectExactKeys(item, ['node_version', 'replaced_at', 'source', 'actor'], 'history item')
      expectExactKeys(item.actor, ['user_id', 'display_name', 'email', 'client_name'], 'history item.actor')
    }

    // include_content=true のときだけ content が増える
    const withContent = await call('history-content', 'read_node_history', {
      node_id: String(node.id), include_content: true,
    })
    for (const item of withContent.result.structuredContent.items) {
      expectExactKeys(item, ['node_version', 'replaced_at', 'source', 'actor', 'content'], 'history item (content 付き)')
    }

    // 返す項目はすべてツール説明に書かれていること。
    // MCP ではツール説明が唯一の契約書で、説明に無い項目は必ず誤読される
    const listed = await callMcp(page, issued, { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} })
    const historyTool = listed.result.tools.find(t => t.name === 'read_node_history')
    expect(historyTool).toBeTruthy()
    const returnedFields = [
      ...Object.keys(history.result.structuredContent),
      ...Object.keys(withContent.result.structuredContent.items[0]),
      ...Object.keys(withContent.result.structuredContent.items[0].actor),
    ]
    expectFieldsDocumented(returnedFields, historyTool.description, 'read_node_history')

    // 欠番が正常であることも説明に書かれていること（書いていないと再度バグ報告される）
    expect(historyTool.description).toContain('node_version values can skip numbers')
    expect(historyTool.description).toContain('newest 100 per node')
    expect(historyTool.description).not.toContain('7 days')

    // 復元キーは node_version だけで足りること（行IDは不要）
    const restore = await call('restore', 'restore_node_version', {
      node_id: String(node.id), node_version: vA, if_version: vD,
    })
    expect(restore.result.isError).toBeFalsy()
    const afterRestore = await call('after-restore', 'read_node', { node_id: String(node.id) })
    expect(afterRestore.result.structuredContent.content).toBe('A')
  })
  test('TC-MCP-API-022: 新ツールの応答は形が固定され、全項目がツール説明に載っている', async ({ page }) => {
    const tree = await createTree(page, 'MCP Response Contract')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const issued = await issueMcpAuth(page, tree.id)
    const content = 'alpha\nneedle one\nmiddle\nneedle two'
    const node = await createNodeWithParentAndContent(page, tree.id, 'Contract node', content, rootNodeId)

    const call = (id, name, arguments_) => callMcp(page, issued, {
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ },
    })
    const listed = await callMcp(page, issued, { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} })
    const describe = (name) => {
      const tool = listed.result.tools.find(t => t.name === name)
      expect(tool, `${name} が tools/list に無い`).toBeTruthy()
      return tool.description
    }

    // find_in_node
    const found = await call('find', 'find_in_node', { node_id: String(node.id), keyword: 'needle' })
    expect(found.result.isError).toBeFalsy()
    expectExactKeys(
      found.result.structuredContent,
      ['node_id', 'keyword', 'total', 'limit', 'returned', 'items'],
      'find_in_node の応答',
    )
    expect(found.result.structuredContent.items.length).toBeGreaterThan(0)
    for (const item of found.result.structuredContent.items) {
      expectExactKeys(item, ['line', 'text'], 'find_in_node item')
    }
    expectFieldsDocumented(
      [
        ...Object.keys(found.result.structuredContent),
        ...Object.keys(found.result.structuredContent.items[0]),
      ],
      describe('find_in_node'),
      'find_in_node',
    )

    // read_node。応答項目が多いのでキー列挙ではなく「全項目が説明にあるか」で守る。
    // content_offset/content_limit は content をスライスしたときだけエコーされるので
    // 素の応答とスライス応答の両方を突き合わせる（片方だけだと項目を取りこぼす）
    const plain = await call('plain', 'read_node', { node_id: String(node.id) })
    expect(plain.result.isError).toBeFalsy()
    expect(plain.result.structuredContent.content_offset).toBeUndefined()
    const paged = await call('paged', 'read_node', { node_id: String(node.id), content_offset: 2, content_limit: 2 })
    expect(paged.result.isError).toBeFalsy()
    expect(paged.result.structuredContent.content_total_lines).toBe(4)
    expect(paged.result.structuredContent.content_offset).toBe(2)
    expect(paged.result.structuredContent.content_limit).toBe(2)
    const withImages = await call('imgs', 'read_node', { node_id: String(node.id), include_images: true })
    expect(withImages.result.isError).toBeFalsy()
    expectFieldsDocumented(
      [
        ...Object.keys(plain.result.structuredContent),
        ...Object.keys(paged.result.structuredContent),
        ...Object.keys(withImages.result.structuredContent),
        ...Object.keys(plain.result.structuredContent.parents[0] || {}),
      ],
      describe('read_node'),
      'read_node',
    )

    // append_node_content はノード全体を返すが、説明に「何を返すか」が無かった
    const appended = await call('append', 'append_node_content', { node_id: String(node.id), content: 'appended line' })
    expect(appended.result.isError).toBeFalsy()
    expectFieldsDocumented(Object.keys(appended.result.structuredContent), describe('append_node_content'), 'append_node_content')

    // edit_node_content（スカラ形は match_count 付き）
    const vBefore = appended.result.structuredContent.version
    const scalar = await call('scalar', 'edit_node_content', {
      node_id: String(node.id), old_str: 'middle', new_str: 'center', if_version: vBefore,
    })
    expect(scalar.result.isError).toBeFalsy()
    expectExactKeys(
      scalar.result.structuredContent,
      ['success', 'node_id', 'version', 'updated_at', 'applied', 'match_counts', 'match_count'],
      'edit_node_content の応答（スカラ形）',
    )

    // edit_node_content（バッチ形は match_count を返さない）
    const batch = await call('batch', 'edit_node_content', {
      node_id: String(node.id),
      edits: [{ old_str: 'needle one', new_str: 'pin one' }, { old_str: 'needle two', new_str: 'pin two' }],
      if_version: scalar.result.structuredContent.version,
    })
    expect(batch.result.isError).toBeFalsy()
    expectExactKeys(
      batch.result.structuredContent,
      ['success', 'node_id', 'version', 'updated_at', 'applied', 'match_counts'],
      'edit_node_content の応答（バッチ形）',
    )
    expectFieldsDocumented(
      [
        ...Object.keys(scalar.result.structuredContent),
        ...Object.keys(batch.result.structuredContent),
      ],
      describe('edit_node_content'),
      'edit_node_content',
    )

    // edit_node_content の失敗応答も契約の一部
    const noMatch = await call('nomatch', 'edit_node_content', { node_id: String(node.id), old_str: 'absent', new_str: 'x' })
    expect(noMatch.result.isError).toBeTruthy()
    expectFieldsDocumented(Object.keys(noMatch.result.structuredContent), describe('edit_node_content'), 'edit_node_content(No match)')
    const multi = await call('multi', 'edit_node_content', { node_id: String(node.id), old_str: 'pin', new_str: 'x' })
    expect(multi.result.isError).toBeTruthy()
    expectFieldsDocumented(Object.keys(multi.result.structuredContent), describe('edit_node_content'), 'edit_node_content(Multiple matches)')

    // restore_node_version
    const hist = await call('hist', 'read_node_history', { node_id: String(node.id) })
    const oldest = hist.result.structuredContent.items[hist.result.structuredContent.items.length - 1]
    const restored = await call('restore', 'restore_node_version', {
      node_id: String(node.id),
      node_version: oldest.node_version,
      if_version: hist.result.structuredContent.current_version,
    })
    expect(restored.result.isError).toBeFalsy()
    expectExactKeys(
      restored.result.structuredContent,
      ['success', 'node_id', 'version', 'updated_at'],
      'restore_node_version の応答',
    )
    expectFieldsDocumented(Object.keys(restored.result.structuredContent), describe('restore_node_version'), 'restore_node_version')
  })

  test('TC-MCP-API-023: search_nodes の only_title はタイトルのみ検索し本文ヒットを返さない', async ({ page }) => {
    const tree = await createTree(page, 'MCP Only Title Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const issued = await issueMcpAuth(page, tree.id)

    const uniqueKeyword = 'zqtonlytitle'
    // (a) タイトルにのみキーワードを含むノード、(b) 本文にのみ含むノード
    const titleHit = await createNodeWithParentAndContent(page, tree.id, `${uniqueKeyword} in title`, 'unrelated body', rootNodeId)
    const contentHit = await createNodeWithParentAndContent(page, tree.id, 'plain title', `${uniqueKeyword} in body`, rootNodeId)

    const call = (id, name, arguments_) => callMcp(page, issued, {
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ },
    })

    // 既定はタイトルと本文の両方にヒット
    const both = await call('both', 'search_nodes', { keyword: uniqueKeyword })
    expect(both.result.isError).toBeFalsy()
    const bothIds = both.result.structuredContent.items.map((n) => String(n.id))
    expect(bothIds).toContain(String(titleHit.id))
    expect(bothIds).toContain(String(contentHit.id))

    // only_title=true はタイトルのみ。本文ヒットは消え、ベクトル専用結果も返らない
    const onlyTitle = await call('only-title', 'search_nodes', { keyword: uniqueKeyword, only_title: true })
    expect(onlyTitle.result.isError).toBeFalsy()
    const onlyTitleIds = onlyTitle.result.structuredContent.items.map((n) => String(n.id))
    expect(onlyTitleIds).toContain(String(titleHit.id))
    expect(onlyTitleIds).not.toContain(String(contentHit.id))

    // only_title に不正値（boolean 以外）は tool error
    const invalid = await call('invalid-only-title', 'search_nodes', { keyword: uniqueKeyword, only_title: 'yes' })
    expect(invalid.result.isError).toBeTruthy()
  })

  test('TC-MCP-API-024: path の各セグメントに公開IDが付く', async ({ page }) => {
    const tree = await createTree(page, 'MCP Path Public Id Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const issued = await issueMcpAuth(page, tree.id)

    const parent = await createNodeWithParent(page, tree.id, 'Path Parent', rootNodeId)
    const child = await createNodeWithParentAndContent(page, tree.id, 'Path Child', 'child body', parent.id)

    const call = (id, name, arguments_) => callMcp(page, issued, {
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ },
    })

    // 各セグメントは「タイトル (id:base58 6文字)」、区切りは「 > 」
    const SEGMENT = /^.+ \(id:[1-9A-HJ-NP-Za-km-z]{6}\)$/

    // read_node: root から2階層下のノードの path
    const read = await call('read', 'read_node', { node_id: String(child.id) })
    expect(read.result.isError).toBeFalsy()
    const path = read.result.structuredContent.path
    const segments = path.split(' > ')
    expect(segments).toHaveLength(3)
    for (const segment of segments) {
      expect(segment).toMatch(SEGMENT)
    }
    // 先頭は root、末尾は対象ノード自身の id
    expect(segments[0]).toBe(`root (id:${rootNodeId})`)
    expect(segments[2]).toBe(`Path Child (id:${child.id})`)

    // get_children / get_parents / search_nodes の items[].path も同じ形式
    const children = await call('children', 'get_children', { node_id: String(parent.id) })
    const childItem = children.result.structuredContent.items.find((n) => String(n.id) === String(child.id))
    expect(childItem.path).toBe(path)

    const parents = await call('parents', 'get_parents', { node_id: String(child.id) })
    const parentItem = parents.result.structuredContent.items.find((n) => String(n.id) === String(parent.id))
    expect(parentItem.path).toBe(`root (id:${rootNodeId}) > Path Parent (id:${parent.id})`)

    const search = await call('search', 'search_nodes', { keyword: 'Path Child' })
    const searchItem = search.result.structuredContent.items.find((n) => String(n.id) === String(child.id))
    expect(searchItem.path).toBe(path)

    // create_node / append_node_content の返却 path も同じ形式
    const created = await call('create', 'create_node', { title: 'Path Created', parent_ids: [String(parent.id)] })
    expect(created.result.isError).toBeFalsy()
    expect(created.result.structuredContent.path).toBe(
      `root (id:${rootNodeId}) > Path Parent (id:${parent.id}) > Path Created (id:${created.result.structuredContent.id})`
    )

    const appended = await call('append', 'append_node_content', { node_id: String(child.id), content: 'appended' })
    expect(appended.result.isError).toBeFalsy()
    expect(appended.result.structuredContent.path).toBe(path)
  })

  test('TC-MCP-API-026: 複数親のノードの path は STRUCTURAL の経路を選び、search の配下指定では起点から始まる', async ({ page }) => {
    const tree = await createTree(page, 'MCP Path Multi Parent Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const issued = await issueMcpAuth(page, tree.id)

    // root > A > B > X（STRUCTURAL）と root > R ~> X（REFERENCE、こちらの方が浅い）
    const a = await createNodeWithParent(page, tree.id, 'Multi A', rootNodeId)
    const b = await createNodeWithParent(page, tree.id, 'Multi B', a.id)
    const x = await createNodeWithParentAndContent(page, tree.id, 'Multi Target zqtmultipath', 'body', b.id)
    const r = await createNodeWithParent(page, tree.id, 'Multi R', rootNodeId)

    const call = (id, name, arguments_) => callMcp(page, issued, {
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ },
    })

    const linked = await call('link', 'link_node', { child_id: String(x.id), parent_id: String(r.id), relation_type: 'REFERENCE' })
    expect(linked.result.isError).toBeFalsy()

    const structuralPath = `root (id:${rootNodeId}) > Multi A (id:${a.id}) > Multi B (id:${b.id}) > Multi Target zqtmultipath (id:${x.id})`

    // 浅い REFERENCE 経路ではなく、STRUCTURAL だけで辿れる経路を返す
    const read = await call('read', 'read_node', { node_id: String(x.id) })
    expect(read.result.isError).toBeFalsy()
    expect(read.result.structuredContent.path).toBe(structuralPath)
    expect(read.result.structuredContent.path_relation_mode).toBe('structural_only')

    // get_parents の各親はそれぞれ自分の経路を持つ
    const parents = await call('parents', 'get_parents', { node_id: String(x.id) })
    const pathById = Object.fromEntries(parents.result.structuredContent.items.map((n) => [String(n.id), n.path]))
    expect(pathById[String(b.id)]).toBe(`root (id:${rootNodeId}) > Multi A (id:${a.id}) > Multi B (id:${b.id})`)
    expect(pathById[String(r.id)]).toBe(`root (id:${rootNodeId}) > Multi R (id:${r.id})`)

    // get_children（REFERENCE の子として現れても）path は同じ STRUCTURAL 経路
    const children = await call('children', 'get_children', { node_id: String(r.id) })
    const childItem = children.result.structuredContent.items.find((n) => String(n.id) === String(x.id))
    expect(childItem.path).toBe(structuralPath)

    // search_nodes の parent_node_id 指定では path が配下の起点ノードから始まる
    const scoped = await call('scoped', 'search_nodes', { keyword: 'zqtmultipath', parent_node_id: String(a.id) })
    expect(scoped.result.isError).toBeFalsy()
    const scopedItem = scoped.result.structuredContent.items.find((n) => String(n.id) === String(x.id))
    expect(scopedItem.path).toBe(`Multi A (id:${a.id}) > Multi B (id:${b.id}) > Multi Target zqtmultipath (id:${x.id})`)

    // R 配下で検索すると STRUCTURAL では届かないので REFERENCE 経由の経路になる
    const viaRef = await call('via-ref', 'search_nodes', { keyword: 'zqtmultipath', parent_node_id: String(r.id) })
    expect(viaRef.result.isError).toBeFalsy()
    const viaRefItem = viaRef.result.structuredContent.items.find((n) => String(n.id) === String(x.id))
    expect(viaRefItem.path).toBe(`Multi R (id:${r.id}) > Multi Target zqtmultipath (id:${x.id})`)
    expect(viaRefItem.path_relation_mode).toBe('fallback_non_structural')
  })

  test('TC-MCP-API-025: get_children は limit=100 + include_images=true でも D1 バインド上限エラーにならない', async ({ page }) => {
    const tree = await createTree(page, 'MCP Children Bind Limit Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const issued = await issueMcpAuth(page, tree.id)

    const parent = await createNodeWithParent(page, tree.id, 'Bind Limit Parent', rootNodeId)

    // 子105件を1回の create_node_tree で作る（get_children の visibleRows が limit 上限の100に達する）
    const createTreeRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'create-bulk-children',
      method: 'tools/call',
      params: {
        name: 'create_node_tree',
        arguments: {
          parent_node_id: String(parent.id),
          nodes: Array.from({ length: 105 }, (_, i) => ({ title: `bind-child-${i + 1}` })),
        },
      },
    })
    expect(createTreeRpc.result.isError).toBeFalsy()
    expect(createTreeRpc.result.structuredContent.created_count).toBe(105)

    // 修正前: 画像メタ取得の IN 句が tree_id + 100件 = 101バインドで "too many SQL variables" になる
    const childrenRpc = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'get-children-images',
      method: 'tools/call',
      params: {
        name: 'get_children',
        arguments: { node_id: String(parent.id), limit: 100, include_images: true },
      },
    })
    expect(childrenRpc.result, JSON.stringify(childrenRpc.error ?? childrenRpc.result)).toBeDefined()
    expect(childrenRpc.result.isError).toBeFalsy()
    const payload = childrenRpc.result.structuredContent
    expect(payload.returned).toBe(100)
    expect(payload.has_more).toBe(true)
    expect(payload.items.length).toBe(100)
    for (const item of payload.items) {
      // 画像が無くても images 配列は必ず返る
      expect(Array.isArray(item.images)).toBe(true)
    }
  })

  test('TC-MCP-API-007: depth>=100 到達時は fail-closed で拒否される（REST/MCP）', async ({ page }) => {
    const tree = await createTree(page, 'Depth Guard Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const chain = await createDeepChain(page, tree.id, rootNodeId, 101)
    const deepRoot = chain[0]

    const extraParent = await createNodeWithParent(page, tree.id, 'extra-parent', rootNodeId)
    const restRes = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/relations`, {
      data: {
        parent_node_id: String(extraParent.id),
        child_node_id: String(deepRoot),
        relation_type_id: 3
      }
    })
    const restData = await restRes.json()
    expect(restRes.status()).toBe(400)
    expect(restData.success).toBeFalsy()
    expect(String(restData.error || '')).toContain('Circular reference detected')

    const issued = await issueMcpAuth(page, tree.id)
    const mcpRes = await callMcp(page, issued, {
      jsonrpc: '2.0',
      id: 'depth-guard-link-node',
      method: 'tools/call',
      params: {
        name: 'link_node',
        arguments: {
          child_id: String(deepRoot),
          parent_id: String(extraParent.id),
          relation_type: 'REFERENCE'
        }
      }
    })
    expect(mcpRes.result.isError).toBeTruthy()
    const mcpErrorText = String(mcpRes.result.content?.[0]?.text || '')
    expect(mcpErrorText).toContain('Circular reference detected')
  })

  test('TC-MCP-API-017: MCP 更新系ツールの version 楽観ロック', async ({ page }) => {
    const tree = await createTree(page, 'MCP Optimistic Lock Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const node = await createNodeWithParentAndContent(page, tree.id, 'Optimistic Lock Node', 'initial', rootNodeId)
    const issued = await issueMcpAuth(page, tree.id, 'full_access')
    // 競合は tool error（JSON-RPC 200 + isError）で返る仕様なので、
    // ここで HTTP が 200 であることも同時に検証する（403 に退化していないこと）
    const callMcpJson = async (treeId, bearer, payload) => {
      const response = await callMcpWithBearer(page, treeId, bearer, payload)
      expect(response.ok()).toBeTruthy()
      return response.json()
    }

    const read = await callMcpJson(tree.id, issued.key, {
      jsonrpc: '2.0', id: 'lock-read', method: 'tools/call',
      params: { name: 'read_node', arguments: { node_id: String(node.id) } },
    })
    const version = read.result.structuredContent.version
    expect(version).toBeGreaterThanOrEqual(1)

    const children = await callMcpJson(tree.id, issued.key, {
      jsonrpc: '2.0', id: 'lock-children', method: 'tools/call',
      params: { name: 'get_children', arguments: { node_id: rootNodeId } },
    })
    expect(children.result.structuredContent.items.find(item => String(item.id) === String(node.id)).version).toBe(version)
    const parents = await callMcpJson(tree.id, issued.key, {
      jsonrpc: '2.0', id: 'lock-parents', method: 'tools/call',
      params: { name: 'get_parents', arguments: { node_id: String(node.id) } },
    })
    expect(parents.result.structuredContent.items.find(item => String(item.id) === String(rootNodeId)).version).toBeTruthy()

    const search = await callMcpJson(tree.id, issued.key, {
      jsonrpc: '2.0', id: 'lock-search', method: 'tools/call',
      params: { name: 'search_nodes', arguments: { keyword: 'Optimistic' } },
    })
    expect(search.result.structuredContent.items.find(item => String(item.id) === String(node.id)).version).toBe(version)

    // ① 古い version は tool error で拒否され、現在 version と server_data を返す
    await callMcpJson(tree.id, issued.key, {
      jsonrpc: '2.0', id: 'lock-bump', method: 'tools/call',
      params: { name: 'update_node_title', arguments: { node_id: String(node.id), title: 'Changed by another writer' } },
    })
    const stale = await callMcpJson(tree.id, issued.key, {
      jsonrpc: '2.0', id: 'lock-stale', method: 'tools/call',
      params: { name: 'update_node', arguments: { node_id: String(node.id), content: 'stale write', if_version: version } },
    })
    expect(stale.result.isError).toBeTruthy()
    // 競合ペイロードは structuredContent と text の両方に載る。
    // 文字列一致だと JSON が壊れていても通るため、構造で検証する
    const staleData = stale.result.structuredContent
    expect(staleData.error).toBe('Version conflict')
    expect(staleData.current_version).toBe(version + 1)
    expect(staleData.server_data.title).toBe('Changed by another writer')
    expect(staleData.server_data.version).toBe(version + 1)
    expect(staleData.server_data.id).toBe(String(node.id))
    // content は据え置き（競合で拒否されたので stale write は入っていない）
    expect(staleData.server_data.content).toBe('initial')
    // text 側も同じ JSON をパースできること
    expect(JSON.parse(String(stale.result.content?.[0]?.text || ''))).toEqual(staleData)

    const currentRead = await callMcpJson(tree.id, issued.key, {
      jsonrpc: '2.0', id: 'lock-current-read', method: 'tools/call',
      params: { name: 'read_node', arguments: { node_id: String(node.id) } },
    })
    const currentVersion = currentRead.result.structuredContent.version
    expect(currentVersion).toBe(version + 1)

    // ② 正しい version では content 更新に成功する
    const current = await callMcpJson(tree.id, issued.key, {
      jsonrpc: '2.0', id: 'lock-current', method: 'tools/call',
      params: { name: 'update_node', arguments: { node_id: String(node.id), content: 'current write', if_version: currentVersion } },
    })
    expect(current.result.isError).toBeFalsy()
    expect(current.result.structuredContent.version).toBe(currentVersion + 1)

    // ③ content 付きで if_version を省略すると tool error
    const missingVersion = await callMcpJson(tree.id, issued.key, {
      jsonrpc: '2.0', id: 'lock-missing', method: 'tools/call',
      params: { name: 'update_node', arguments: { node_id: String(node.id), content: 'missing version' } },
    })
    expect(missingVersion.result.isError).toBeTruthy()

    // ④ content を含まない更新は if_version 無しでも成功する
    const titleOnly = await callMcpJson(tree.id, issued.key, {
      jsonrpc: '2.0', id: 'lock-title-only', method: 'tools/call',
      params: { name: 'update_node', arguments: { node_id: String(node.id), title: 'Title only update' } },
    })
    expect(titleOnly.result.isError).toBeFalsy()
    expect(titleOnly.result.structuredContent.version).toBe(currentVersion + 2)

    // ⑤ update_node_title は if_version 任意。一致すれば成功し、古ければ競合
    const titleWithVersion = await callMcpJson(tree.id, issued.key, {
      jsonrpc: '2.0', id: 'lock-title-match', method: 'tools/call',
      params: { name: 'update_node_title', arguments: { node_id: String(node.id), title: 'Title with version', if_version: currentVersion + 2 } },
    })
    expect(titleWithVersion.result.isError).toBeFalsy()
    expect(titleWithVersion.result.structuredContent.version).toBe(currentVersion + 3)

    const titleStale = await callMcpJson(tree.id, issued.key, {
      jsonrpc: '2.0', id: 'lock-title-stale', method: 'tools/call',
      params: { name: 'update_node_title', arguments: { node_id: String(node.id), title: 'Should be rejected', if_version: currentVersion } },
    })
    expect(titleStale.result.isError).toBeTruthy()
    expect(titleStale.result.structuredContent.error).toBe('Version conflict')
    expect(titleStale.result.structuredContent.current_version).toBe(currentVersion + 3)
    // 拒否されたのでタイトルは変わっていない
    expect(titleStale.result.structuredContent.server_data.title).toBe('Title with version')

    // ⑥ 不正な if_version は「競合」ではなく引数エラーとして返る
    for (const badVersion of [0, -1, 'abc']) {
      const badContent = await callMcpJson(tree.id, issued.key, {
        jsonrpc: '2.0', id: `lock-bad-${badVersion}`, method: 'tools/call',
        params: { name: 'update_node', arguments: { node_id: String(node.id), content: 'bad version', if_version: badVersion } },
      })
      expect(badContent.result.isError).toBeTruthy()
      const badText = String(badContent.result.content?.[0]?.text || '')
      expect(badText).toContain('if_version must be a positive integer')
      expect(badText).not.toContain('Version conflict')
    }
  })
})
