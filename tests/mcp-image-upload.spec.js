import { test, expect } from '@playwright/test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { execSync } from 'node:child_process'
import { waitForAppReady } from './helpers/app.js'
import {
  BASE_URL,
  callMcp,
  callMcpWithBearer,
  completeAuthorizationCodeFlow,
  issueMcpAuth,
} from './helpers/mcp-oauth.js'

/**
 * create_node_image_upload（アップロード先を返す方式）の E2E。
 *
 * AI が画像の base64 を書き写さずに済むよう、MCP ツールで1回限りの合鍵を発行し、
 * 画像のバイトは curl で PUT /api/mcp/uploads へ直接送る。
 */

const UPLOAD_URL = `${BASE_URL}/api/mcp/uploads`

const DB_PATH =
  '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/1d75e8d9dbbf9cabcd01dd2d401aa0f9dcd6cab003b0dda8e6c31948c6e680b7.sqlite'

/** ローカルD1(sqlite)を直接叩く。期限切れの検証で使う（tests/mcp-oauth.spec.js と同じ方式） */
function dbQuery(sql) {
  return execSync(`sqlite3 "${DB_PATH}" "${sql.replace(/"/g, '""')}"`, {
    cwd: process.cwd(),
    encoding: 'utf-8',
  }).trim()
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(typeAndData) >>> 0)
  return Buffer.concat([len, typeAndData, crc])
}

/** 1x1 の有効な PNG。paddingBytes を指定すると tEXt チャンクで任意の大きさにする */
function makePng(paddingBytes = 0) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  const chunks = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
  ]
  if (paddingBytes > 0) chunks.push(pngChunk('tEXt', Buffer.alloc(paddingBytes, 0x61)))
  chunks.push(pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 0]))))
  chunks.push(pngChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

async function clearTestData(page) {
  await page.request.delete(`${BASE_URL}/api/test/clear`)
}

async function testLogin(page, userId = 1) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`)
  await waitForAppReady(page)
}

async function createTree(page, name) {
  const res = await page.request.post(`${BASE_URL}/api/trees`, {
    data: { name, description: 'MCP image upload test tree' },
  })
  const data = await res.json()
  expect(res.ok()).toBeTruthy()
  return data.data
}

async function getTreeRootNodeId(page, treeId) {
  const res = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes`)
  const data = await res.json()
  expect(res.ok()).toBeTruthy()
  return String(data.root_node_id)
}

function issueRpc(nodeId, overrides = {}) {
  return {
    jsonrpc: '2.0',
    id: 'issue-upload',
    method: 'tools/call',
    params: {
      name: 'create_node_image_upload',
      arguments: {
        node_id: nodeId,
        filename: 'upload-sample.png',
        content_type: 'image/png',
        size_bytes: 0,
        ...overrides,
      },
    },
  }
}

async function issueUpload(page, auth, nodeId, bytes, overrides = {}) {
  const rpc = await callMcp(page, auth, issueRpc(nodeId, { size_bytes: bytes.length, ...overrides }))
  expect(rpc.result.isError, JSON.stringify(rpc.result)).toBeFalsy()
  return rpc.result.structuredContent
}

/** cookie を送らない（curl と同じ条件にする）ため、page.request ではなく fetch を使う */
async function putUpload(token, bytes, contentType = 'image/png') {
  const res = await fetch(UPLOAD_URL, {
    method: 'PUT',
    headers: { 'content-type': contentType, authorization: `Bearer ${token}` },
    body: bytes,
  })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

async function readImage(page, auth, nodeId, imageId) {
  const rpc = await callMcp(page, auth, {
    jsonrpc: '2.0',
    id: 'read-image',
    method: 'tools/call',
    params: { name: 'read_node_image', arguments: { node_id: nodeId, image_id: imageId } },
  })
  expect(rpc.result.isError).toBeFalsy()
  return rpc.result
}

test.describe('MCP create_node_image_upload（アップロード先を返す方式）', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
    await testLogin(page, 1)
  })

  test('TC-MCP-UPLOAD-001: 発行した curl コマンドで画像を送ると登録され、read_node_image で同じ画像が取れる', async ({ page }) => {
    const tree = await createTree(page, 'Upload Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const auth = await issueMcpAuth(page, tree.id, 'full_access')
    const png = makePng(2000)

    const issued = await issueUpload(page, auth, rootNodeId, png)
    expect(Object.keys(issued).sort()).toEqual(['curl_command', 'expires_at', 'upload_token', 'upload_url'])
    expect(issued.upload_url).toBe(UPLOAD_URL)
    expect(issued.curl_command).toContain('<FILE_PATH>')
    expect(issued.curl_command).toContain(`Bearer ${issued.upload_token}`)

    // 合鍵は平文で保存しない（SHA-256 のみ）
    expect(dbQuery(`SELECT COUNT(*) FROM mcp_image_uploads WHERE token_hash='${issued.upload_token}'`)).toBe('0')
    expect(dbQuery(`SELECT COUNT(*) FROM mcp_image_uploads WHERE token_hash='${sha256Hex(issued.upload_token)}'`)).toBe('1')

    // AI が実行するのと同じく、返された curl コマンドのファイルパスだけを差し替えて実行する
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-upload-'))
    const filePath = path.join(dir, 'upload-sample.png')
    fs.writeFileSync(filePath, png)
    const curlOut = execSync(issued.curl_command.replace('<FILE_PATH>', filePath), { encoding: 'utf-8' })
    const uploaded = JSON.parse(curlOut)
    expect(uploaded.success).toBe(true)
    expect(Object.keys(uploaded.data).sort()).toEqual(['file_name', 'image_id', 'markdown', 'size_bytes', 'url'])
    expect(uploaded.data.size_bytes).toBe(png.length)
    expect(uploaded.data.url).toContain(`/nodes/${rootNodeId}/images/${uploaded.data.image_id}/file`)
    expect(uploaded.data.markdown).toBe(`![${uploaded.data.file_name}](${uploaded.data.url})`)

    const read = await readImage(page, auth, rootNodeId, uploaded.data.image_id)
    expect(read.content[0]).toEqual({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' })
  })

  test('TC-MCP-UPLOAD-002: 合鍵は1回しか使えない。未知の合鍵・合鍵なし・Content-Length なしも拒否する', async ({ page }) => {
    const tree = await createTree(page, 'Upload Reuse Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const auth = await issueMcpAuth(page, tree.id, 'full_access')
    const png = makePng()

    const issued = await issueUpload(page, auth, rootNodeId, png)
    const first = await putUpload(issued.upload_token, png)
    expect(first.status).toBe(200)

    const second = await putUpload(issued.upload_token, png)
    expect(second.status).toBe(401)
    expect(second.body.success).toBe(false)
    // エラーに合鍵を含めない
    expect(JSON.stringify(second.body)).not.toContain(issued.upload_token)

    const unknown = await putUpload('zmu_unknown-token', png)
    expect(unknown.status).toBe(401)

    const noAuth = await fetch(UPLOAD_URL, { method: 'PUT', body: png })
    expect(noAuth.status).toBe(401)

    // Content-Length の無い送信（chunked）は、本体を読む前に 411 で拒否し、合鍵を消費しない
    const issued2 = await issueUpload(page, auth, rootNodeId, png)
    const chunked = await fetch(UPLOAD_URL, {
      method: 'PUT',
      headers: { authorization: `Bearer ${issued2.upload_token}` },
      body: new ReadableStream({ start(controller) { controller.enqueue(png); controller.close() } }),
      duplex: 'half',
    })
    expect(chunked.status).toBe(411)
    const afterChunked = await putUpload(issued2.upload_token, png)
    expect(afterChunked.status).toBe(200)
  })

  test('TC-MCP-UPLOAD-003: 送ったバイト数が発行時の size_bytes と違うと拒否し、合鍵は使用済みになる', async ({ page }) => {
    const tree = await createTree(page, 'Upload Size Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const auth = await issueMcpAuth(page, tree.id, 'full_access')
    const png = makePng(100)

    const issued = await issueUpload(page, auth, rootNodeId, png, { size_bytes: png.length + 1 })
    const mismatch = await putUpload(issued.upload_token, png)
    expect(mismatch.status).toBe(400)
    expect(mismatch.body.error).toContain('size')

    const retry = await putUpload(issued.upload_token, png)
    expect(retry.status).toBe(401)
  })

  test('TC-MCP-UPLOAD-004: 期限切れの合鍵は拒否する', async ({ page }) => {
    const tree = await createTree(page, 'Upload Expiry Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const auth = await issueMcpAuth(page, tree.id, 'full_access')
    const png = makePng()

    const issued = await issueUpload(page, auth, rootNodeId, png)
    dbQuery(`UPDATE mcp_image_uploads SET expires_at = datetime('now', '-1 minute') WHERE token_hash='${sha256Hex(issued.upload_token)}'`)

    const expired = await putUpload(issued.upload_token, png)
    expect(expired.status).toBe(401)
  })

  test('TC-MCP-UPLOAD-005: 発行時の入力を検査する（MIME・サイズ・閲覧のみの権限）', async ({ page }) => {
    const tree = await createTree(page, 'Upload Validation Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const auth = await issueMcpAuth(page, tree.id, 'full_access')

    const svg = await callMcp(page, auth, issueRpc(rootNodeId, { content_type: 'image/svg+xml', size_bytes: 100 }))
    expect(svg.result.isError).toBe(true)

    const tooLarge = await callMcp(page, auth, issueRpc(rootNodeId, { size_bytes: 5 * 1024 * 1024 + 1 }))
    expect(tooLarge.result.isError).toBe(true)

    const zero = await callMcp(page, auth, issueRpc(rootNodeId, { size_bytes: 0 }))
    expect(zero.result.isError).toBe(true)

    const readOnly = await issueMcpAuth(page, tree.id, 'read_only')
    const denied = await callMcpWithBearer(page, tree.id, readOnly.key, issueRpc(rootNodeId, { size_bytes: 100 }))
    expect(denied.status()).toBe(403)
  })

  test('TC-MCP-UPLOAD-006: 中身が画像でないと拒否する', async ({ page }) => {
    const tree = await createTree(page, 'Upload Content Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const auth = await issueMcpAuth(page, tree.id, 'full_access')
    const notPng = Buffer.from('this is not a png file at all')

    const issued = await issueUpload(page, auth, rootNodeId, notPng)
    const res = await putUpload(issued.upload_token, notPng)
    expect(res.status).toBe(400)
  })

  test('TC-MCP-UPLOAD-007: 発行後に編集権限を失ったユーザーの合鍵は拒否する', async ({ page }) => {
    const tree = await createTree(page, 'Upload Member Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    await testLogin(page, 2)
    await testLogin(page, 1)
    const addRes = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/members`, { data: { user_id: 2, role: 'editor' } })
    expect(addRes.ok()).toBeTruthy()

    await testLogin(page, 2)
    const { token } = await completeAuthorizationCodeFlow(page, tree.id)
    const png = makePng()
    const issueRes = await callMcpWithBearer(page, tree.id, token.access_token, issueRpc(rootNodeId, { size_bytes: png.length }))
    const issued = (await issueRes.json()).result.structuredContent

    await testLogin(page, 1)
    const roleRes = await page.request.put(`${BASE_URL}/api/trees/${tree.id}/members/2/role`, { data: { role: 'viewer' } })
    expect(roleRes.ok()).toBeTruthy()

    const res = await putUpload(issued.upload_token, png)
    expect(res.status).toBe(403)
  })

  test('TC-MCP-UPLOAD-008: base64 版の上限（約4.4MB）を超える画像も送れる', async ({ page }) => {
    const tree = await createTree(page, 'Upload Large Tree')
    const rootNodeId = await getTreeRootNodeId(page, tree.id)
    const auth = await issueMcpAuth(page, tree.id, 'full_access')
    const png = makePng(5 * 1024 * 1024 - 1024)

    const issued = await issueUpload(page, auth, rootNodeId, png)
    const res = await putUpload(issued.upload_token, png)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.size_bytes).toBe(png.length)

    const read = await readImage(page, auth, rootNodeId, res.body.data.image_id)
    expect(read.structuredContent.size_bytes).toBe(png.length)
  })
})
