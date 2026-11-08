import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

// APIガードテスト: レスポンスにノードの整数IDが露出せず、公開IDのみであること。
// 整数IDでのアクセスが拒否されること（完全切替）。

const PUBLIC_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{6}$/

async function login(page) {
  await page.goto('/auth/test-login?user_id=1')
  await waitForAppReady(page)
}

test('nodes/relations 応答は公開IDのみ、整数IDアクセスは拒否', async ({ page }) => {
  await login(page)

  const treesJson = await (await page.request.get('/api/trees')).json()
  const treeId = (treesJson.data || treesJson)[0].id
  expect(treeId).toBeTruthy()

  // --- nodes ---
  const nodesResp = await page.request.get(`/api/trees/${treeId}/nodes`)
  expect(nodesResp.status()).toBe(200)
  const nodesJson = await nodesResp.json()
  const nodes = nodesJson.data || []
  expect(nodes.length).toBeGreaterThan(0)
  for (const n of nodes) {
    expect(String(n.id), `node.id=${n.id} は公開IDであるべき`).toMatch(PUBLIC_ID_RE)
  }
  // tree メタの root/trash も公開ID
  expect(String(nodesJson.root_node_id)).toMatch(PUBLIC_ID_RE)
  if (nodesJson.trash_root_node_id) {
    expect(String(nodesJson.trash_root_node_id)).toMatch(PUBLIC_ID_RE)
  }

  // --- relations ---
  const relJson = await (await page.request.get(`/api/trees/${treeId}/relations`)).json()
  const rels = relJson.data || []
  expect(rels.length).toBeGreaterThan(0)
  for (const r of rels) {
    expect(String(r.parent_node_id), 'relation.parent_node_id は公開ID').toMatch(PUBLIC_ID_RE)
    expect(String(r.child_node_id), 'relation.child_node_id は公開ID').toMatch(PUBLIC_ID_RE)
  }

  // --- 公開IDで取得できる ---
  const okId = nodes[0].id
  expect((await page.request.get(`/api/trees/${treeId}/nodes/${okId}`)).status()).toBe(200)

  // --- 整数IDでは取得できない（完全切替）---
  const intResp = await page.request.get(`/api/trees/${treeId}/nodes/204`)
  expect(intResp.status(), '整数IDアクセスは200を返してはいけない').not.toBe(200)
})

// 1x1 PNG（透明）
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII='

test('画像アップロードは公開ID経由で往復し、整数ノードIDは拒否', async ({ page }) => {
  await login(page)
  const treesJson = await (await page.request.get('/api/trees')).json()
  const treeId = (treesJson.data || treesJson)[0].id
  const nodesJson = await (await page.request.get(`/api/trees/${treeId}/nodes`)).json()
  const nodePublicId = (nodesJson.data || [])[0].id
  expect(nodePublicId).toMatch(PUBLIC_ID_RE)

  const buffer = Buffer.from(PNG_1x1_B64, 'base64')

  // --- 公開IDノードへアップロード ---
  const uploadResp = await page.request.post(
    `/api/trees/${treeId}/nodes/${nodePublicId}/images`,
    { multipart: { file: { name: 'guard.png', mimeType: 'image/png', buffer } } }
  )
  expect(uploadResp.status(), 'アップロードは成功すべき').toBe(200)
  const uploaded = (await uploadResp.json()).data
  // 返却される node_id / url / markdown は公開IDを含み、整数を含まない
  expect(String(uploaded.node_id)).toBe(nodePublicId)
  expect(uploaded.url).toContain(`/nodes/${nodePublicId}/images/`)
  expect(uploaded.markdown).toContain(`/nodes/${nodePublicId}/images/`)

  // --- アップロードした画像ファイルが公開ID経由で取得できる ---
  const fileResp = await page.request.get(uploaded.url)
  expect(fileResp.status()).toBe(200)
  expect(fileResp.headers()['content-type']).toContain('image/')

  // --- 整数ノードIDへのアップロードは拒否（完全切替）---
  const intUpload = await page.request.post(
    `/api/trees/${treeId}/nodes/204/images`,
    { multipart: { file: { name: 'guard.png', mimeType: 'image/png', buffer } } }
  )
  expect(intUpload.status(), '整数ノードIDへのアップロードは200を返してはいけない').not.toBe(200)
})
