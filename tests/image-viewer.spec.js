import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'
import zlib from 'node:zlib'

const BASE_URL = 'http://localhost:3000'
const PNG_WIDTH = 400
const PNG_HEIGHT = 300
const BIG_PNG_WIDTH = 8000
const BIG_PNG_HEIGHT = 5000

async function login(page) {
  await page.context().clearCookies()
  await page.goto(`${BASE_URL}/auth/test-login?user_id=1`)
  await waitForAppReady(page)
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(body) >>> 0)
  return Buffer.concat([length, body, crc])
}

// zlibで最小構成のPNG（黒一色）を生成する。外部フィクスチャに頼らず
// naturalWidth/naturalHeightが確定する画像を用意するため。
function createPng(width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  const stride = width * 3 + 1 // 先頭1バイトはフィルタ種別(0=None)
  const raw = Buffer.alloc(stride * height)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

async function createImageNode(page, width = PNG_WIDTH, height = PNG_HEIGHT) {
  const treeResponse = await page.request.post(`${BASE_URL}/api/trees`, {
    data: { name: 'Image Viewer Test', description: 'Image viewer E2E' },
  })
  expect(treeResponse.ok()).toBeTruthy()
  const tree = (await treeResponse.json()).data

  const nodeResponse = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes`, {
    data: { title: 'Image Viewer Node', content: '', author_user_id: 1 },
  })
  expect(nodeResponse.ok()).toBeTruthy()
  const node = (await nodeResponse.json()).data

  const relationResponse = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/relations`, {
    data: { parent_node_id: tree.root_node_id, child_node_id: node.id },
  })
  expect(relationResponse.ok()).toBeTruthy()

  const uploadResponse = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/images`, {
    multipart: {
      file: { name: 'viewer-test.png', mimeType: 'image/png', buffer: createPng(width, height) },
    },
  })
  expect(uploadResponse.ok()).toBeTruthy()
  const image = (await uploadResponse.json()).data
  expect(image.url).toContain('/images/')

  const content = image.markdown
  const updateResponse = await page.request.put(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}`, {
    data: { title: 'Image Viewer Node', content, author_user_id: 1, version: node.version },
  })
  expect(updateResponse.ok()).toBeTruthy()

  await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
  await page.locator(`.tree-item[data-node-id="${node.id}"]`).click()
  const previewImage = page.locator('.bytemd-preview .markdown-body img[data-image-viewer-ready="true"]')
  await expect(previewImage).toBeVisible({ timeout: 30000 })
  return { tree, node, image, previewImage }
}

function readZoomLevel(percentText) {
  const percent = parseInt(percentText, 10)
  expect(Number.isFinite(percent)).toBeTruthy()
  return percent
}

test.describe('Image preview viewer', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.delete(`${BASE_URL}/api/test/clear`)
    await login(page)
  })

  test('TC-FUNC-069: preview中の画像をクリックすると別タブのビューアで表示する', async ({ page }) => {
    const { previewImage } = await createImageNode(page)

    await expect(previewImage).toHaveCSS('cursor', 'pointer')
    await expect(previewImage).toHaveAttribute('title', 'クリックして別タブで拡大表示')
    await expect(previewImage).toHaveAttribute('tabindex', '0')

    const popupPromise = page.waitForEvent('popup')
    await previewImage.click()
    const viewer = await popupPromise
    await expect(viewer).toHaveURL(/\/image-viewer\?channel=/)

    const viewerImage = viewer.locator('#image-element')
    await expect(viewerImage).toBeVisible({ timeout: 10000 })
    await expect(viewerImage).toHaveAttribute('src', /\/api\/trees\/.+\/images\/.+\/file/, { timeout: 10000 })
    await expect(viewerImage).toHaveAttribute('alt', 'viewer-test.png')
    await expect(viewer.locator('#viewer-status')).toBeHidden()
    // payloadのtitleにはノードタイトルが入り「{ノード名} - 画像」になる
    await expect(viewer).toHaveTitle(/画像$/)
  })

  test('TC-FUNC-070: 別タブのビューアで画像を拡大・縮小・全体表示できる', async ({ page }) => {
    const { previewImage } = await createImageNode(page)

    const popupPromise = page.waitForEvent('popup')
    await previewImage.click()
    const viewer = await popupPromise
    await expect(viewer.locator('#image-element')).toBeVisible({ timeout: 10000 })

    const zoomLevel = viewer.locator('#zoom-level')
    await expect(zoomLevel).toHaveText(/^\d+%$/, { timeout: 10000 })
    const fitPercent = readZoomLevel(await zoomLevel.textContent())

    await viewer.locator('#zoom-in').click()
    expect(readZoomLevel(await zoomLevel.textContent())).toBeGreaterThan(fitPercent)

    await viewer.locator('#zoom-out').click()
    await viewer.locator('#zoom-out').click()
    expect(readZoomLevel(await zoomLevel.textContent())).toBeLessThan(fitPercent)

    await viewer.locator('#fit-view').click()
    expect(readZoomLevel(await zoomLevel.textContent())).toBe(fitPercent)
  })

  test('TC-FUNC-078: 大きい画像も全体表示でビューポートに収まる', async ({ page }) => {
    const { previewImage } = await createImageNode(page, BIG_PNG_WIDTH, BIG_PNG_HEIGHT)

    const popupPromise = page.waitForEvent('popup')
    await previewImage.click()
    const viewer = await popupPromise
    const zoomLevel = viewer.locator('#zoom-level')
    await expect(zoomLevel).toHaveText(/^\d+%$/, { timeout: 10000 })
    const fitPercent = readZoomLevel(await zoomLevel.textContent())

    // 巨大画像は旧下限(25%)未満のフィット倍率で開く
    expect(fitPercent).toBeLessThan(25)

    // scale × 自然サイズがビューポートに収まり、画像全体が見えている
    const geometry = await viewer.evaluate(() => {
      const viewport = document.getElementById('image-viewport')
      const match = document.getElementById('image-element').style.transform.match(/scale\(([\d.]+)\)/)
      return {
        viewportWidth: viewport.clientWidth,
        viewportHeight: viewport.clientHeight,
        naturalWidth: document.getElementById('image-element').naturalWidth,
        naturalHeight: document.getElementById('image-element').naturalHeight,
        scale: match ? parseFloat(match[1]) : 0,
      }
    })
    expect(Math.round(geometry.scale * 100)).toBe(fitPercent)
    expect(geometry.naturalWidth * geometry.scale).toBeLessThanOrEqual(geometry.viewportWidth + 1)
    expect(geometry.naturalHeight * geometry.scale).toBeLessThanOrEqual(geometry.viewportHeight + 1)

    // ズーム下限はフィット倍率（これ以上縮小しない）
    await viewer.locator('#zoom-out').click()
    expect(readZoomLevel(await zoomLevel.textContent())).toBe(fitPercent)

    await viewer.locator('#fit-view').click()
    expect(readZoomLevel(await zoomLevel.textContent())).toBe(fitPercent)
  })

  test('TC-FUNC-071: 画像アイコンの「別タブで表示」もビューアで開く', async ({ page }) => {
    const { node, image } = await createImageNode(page)

    await page.locator(`.node-image-icon-item[data-image-id="${image.id}"]`).click()
    const openAction = page.locator(`.node-image-menu-action[data-action="open"][data-image-id="${image.id}"]`)
    await expect(openAction).toBeVisible()

    const popupPromise = page.waitForEvent('popup')
    await openAction.click()
    const viewer = await popupPromise
    await expect(viewer).toHaveURL(/\/image-viewer\?channel=/)
    await expect(viewer.locator('#image-element')).toBeVisible({ timeout: 10000 })
    await expect(viewer.locator('#image-element')).toHaveAttribute('src', /\/api\/trees\/.+\/images\/.+\/file/, { timeout: 10000 })
    // メニューを開いたままにしない
    await expect(page.locator(`.node-image-icon-item[data-image-id="${image.id}"][aria-expanded="true"]`)).toHaveCount(0)
  })

  test('TC-FUNC-072: リンク付き画像のクリックはリンクを優先しビューアを開かない', async ({ page }) => {
    // [![alt](image)](/help) 形式のノードを専用に作る
    const treeResponse = await page.request.post(`${BASE_URL}/api/trees`, {
      data: { name: 'Linked Image Test', description: 'Image viewer E2E' },
    })
    expect(treeResponse.ok()).toBeTruthy()
    const tree = (await treeResponse.json()).data

    const nodeResponse = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes`, {
      data: { title: 'Linked Image Node', content: '', author_user_id: 1 },
    })
    const node = (await nodeResponse.json()).data
    const relationResponse = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/relations`, {
      data: { parent_node_id: tree.root_node_id, child_node_id: node.id },
    })
    expect(relationResponse.ok()).toBeTruthy()

    const uploadResponse = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/images`, {
      multipart: {
        file: { name: 'linked.png', mimeType: 'image/png', buffer: createPng(PNG_WIDTH, PNG_HEIGHT) },
      },
    })
    expect(uploadResponse.ok()).toBeTruthy()
    const image = (await uploadResponse.json()).data

    const updateResponse = await page.request.put(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}`, {
      data: {
        title: 'Linked Image Node',
        content: `[![linked](${image.url})](/help)`,
        author_user_id: 1,
        version: node.version,
      },
    })
    expect(updateResponse.ok()).toBeTruthy()

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.locator(`.tree-item[data-node-id="${node.id}"]`).click()
    const linkedImage = page.locator('.bytemd-preview .markdown-body a > img[data-image-viewer-ready="true"]')
    await expect(linkedImage).toBeVisible({ timeout: 30000 })

    let popupCount = 0
    page.on('popup', () => { popupCount += 1 })
    await linkedImage.click()
    await page.waitForURL(/\/help/)
    expect(popupCount).toBe(0)
  })
})
