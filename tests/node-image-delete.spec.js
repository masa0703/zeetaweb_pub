import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

const BASE_URL = 'http://localhost:3000'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

async function clearTestData(page) {
  await page.request.delete(`${BASE_URL}/api/test/clear`)
}

async function testLogin(page, userId = 1) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
}

async function createNodeWithImages(page, imageNames, savedContent) {
  const treeRes = await page.request.post(`${BASE_URL}/api/trees`, { data: { name: 'Image Delete Tree' } })
  const tree = (await treeRes.json()).data
  const rootRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes`)
  const rootId = String((await rootRes.json()).root_node_id)
  const nodeRes = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes/with-parent`, {
    data: { title: 'Image node', content: '', author_user_id: 1, parent_node_id: rootId }
  })
  const node = (await nodeRes.json()).data.node

  const images = []
  for (const name of imageNames) {
    const res = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/images`, {
      multipart: { file: { name, mimeType: 'image/png', buffer: PNG } }
    })
    images.push((await res.json()).data)
  }
  if (savedContent) {
    const putRes = await page.request.put(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}`, {
      data: { content: savedContent(images), author_user_id: 1 }
    })
    expect(putRes.ok()).toBeTruthy()
  }
  return { tree, node, images }
}

async function getSavedContent(page, treeId, nodeId) {
  const res = await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes/${nodeId}`)
  return (await res.json()).data.content
}

test.describe('画像削除時の content の扱い', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
    await testLogin(page, 1)
  })

  test('TC-IMGDEL-001: DELETE に現在の content を渡すと、除去後の文字列を editor_content で返し、DBには保存しない', async ({ page }) => {
    const { tree, node, images } = await createNodeWithImages(page, ['a.png', 'b.png'], ([a]) => a.markdown)
    const [a, b] = images
    const editorContent = `${a.markdown}\n${b.markdown}\n未保存の追記`

    const res = await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/images/${a.id}`, {
      data: { content: editorContent }
    })
    expect(res.ok()).toBeTruthy()
    const body = (await res.json()).data
    expect(body.editor_content).toBe(`${b.markdown}\n未保存の追記`)
    expect(body.content_updated).toBe(true)
    // DB の content は「保存済みの content」から対象だけを取り除いたもの（渡した content は保存されない）
    expect(await getSavedContent(page, tree.id, node.id)).toBe('')
  })

  test('TC-IMGDEL-002: content を渡さない従来の呼び出しでは editor_content を返さない', async ({ page }) => {
    const { tree, node, images } = await createNodeWithImages(page, ['a.png'], ([a]) => a.markdown)

    const res = await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/images/${images[0].id}`)
    expect(res.ok()).toBeTruthy()
    expect((await res.json()).data.editor_content).toBeUndefined()
  })

  test('TC-IMGDEL-003: content が文字列でなければ400（画像は削除されない）', async ({ page }) => {
    const { tree, node, images } = await createNodeWithImages(page, ['a.png'], ([a]) => a.markdown)

    const res = await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/images/${images[0].id}`, {
      data: { content: 123 }
    })
    expect(res.status()).toBe(400)
    const listRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes/${node.id}/images`)
    expect(((await listRes.json()).data || []).length).toBe(1)
  })

  async function openNodeEditor(page, treeId, nodeId, firstImageId) {
    await page.goto(`${BASE_URL}/index.html?tree=${treeId}&node=${nodeId}`)
    await page.waitForFunction(() => window.currentEditor && typeof window.currentEditor.value === 'function', null, { timeout: 15000 })
    await page.waitForSelector(`.node-image-icon-item[data-image-id="${firstImageId}"]`, { timeout: 15000 })
  }

  async function deleteImageFromMenu(page, imageId) {
    page.once('dialog', dialog => dialog.accept())
    await page.locator(`.node-image-icon-item[data-image-id="${imageId}"]`).click({ force: true })
    await page.locator(`.node-image-menu-action[data-action="delete"][data-image-id="${imageId}"]`).click({ force: true })
    await expect(page.locator(`.node-image-icon-item[data-image-id="${imageId}"]`)).toHaveCount(0)
  }

  test('TC-IMGDEL-004: 画像を削除しても、エディタの未保存の編集（別の画像タグ・追記）は消えず、未保存のまま残る', async ({ page }) => {
    const { tree, node, images } = await createNodeWithImages(page, ['a.png', 'b.png'], ([a]) => a.markdown)
    const [a, b] = images
    await openNodeEditor(page, tree.id, node.id, a.id)

    // b は画像のみアップロード済みで、タグはエディタ上にだけある（未保存）状態
    const unsaved = `${a.markdown}\n${b.markdown}\n未保存の追記テキスト`
    await page.evaluate((value) => window.currentEditor.value(value), unsaved)

    await deleteImageFromMenu(page, a.id)

    await expect.poll(() => page.evaluate(() => window.currentEditor.value()))
      .toBe(`${b.markdown}\n未保存の追記テキスト`)
    expect(await page.evaluate(() => isDirty)).toBe(true)
    expect(await getSavedContent(page, tree.id, node.id)).toBe('')
    await expect(page.locator(`.node-image-icon-item[data-image-id="${b.id}"]`)).toHaveCount(1)
  })

  test('TC-IMGDEL-005: 未保存の編集が無いときは、エディタが削除後の content になり未保存にならない', async ({ page }) => {
    const { tree, node, images } = await createNodeWithImages(page, ['a.png', 'b.png'], ([a, b]) => `${a.markdown}\n${b.markdown}`)
    const [a, b] = images
    await openNodeEditor(page, tree.id, node.id, a.id)

    await deleteImageFromMenu(page, a.id)

    await expect.poll(() => page.evaluate(() => window.currentEditor.value())).toBe(b.markdown)
    expect(await page.evaluate(() => isDirty)).toBe(false)
    expect(await getSavedContent(page, tree.id, node.id)).toBe(b.markdown)
  })
})
