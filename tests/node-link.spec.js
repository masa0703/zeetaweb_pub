import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

const BASE_URL = 'http://localhost:3000'

async function login(page, userId) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
}

async function createTree(page, name) {
  const response = await page.request.post(`${BASE_URL}/api/trees`, { data: { name } })
  expect(response.ok()).toBe(true)
  return (await response.json()).data
}

async function createNode(page, treeId, rootId, title, content) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes`, {
    data: { title, content, author_user_id: 1 }
  })
  expect(response.ok()).toBe(true)
  const node = (await response.json()).data
  const relation = await page.request.post(`${BASE_URL}/api/trees/${treeId}/relations`, {
    data: { parent_node_id: rootId, child_node_id: node.id }
  })
  expect(relation.ok()).toBe(true)
  return node
}

async function saveContent(page, treeId, nodeId, content) {
  const current = await (await page.request.get(`${BASE_URL}/api/trees/${treeId}/nodes/${nodeId}`)).json()
  const response = await page.request.put(`${BASE_URL}/api/trees/${treeId}/nodes/${nodeId}`, {
    data: { content, version: current.data.version }
  })
  expect(response.ok()).toBe(true)
  return (await response.json()).data
}

async function openNode(page, treeId, nodeId) {
  await page.goto(`${BASE_URL}/index.html?tree=${treeId}&node=${nodeId}`)
  await page.waitForSelector('.bytemd-preview', { timeout: 15000 })
}

test.describe('Node link notation [title (id:xxxxxx)]', () => {
  let tree
  let targetNode
  let sourceNode

  test.beforeEach(async ({ page }) => {
    await page.request.delete(`${BASE_URL}/api/test/clear`)
    await login(page, 1)
    tree = await createTree(page, 'Node link tree')
    targetNode = await createNode(page, tree.id, tree.root_node_id, 'Link target', 'target body')
    sourceNode = await createNode(page, tree.id, tree.root_node_id, 'Link source', '')
    const content = [
      `通常: [Link target (id:${targetNode.id})]`,
      `スペース0個: [Link target(id:${targetNode.id})]`,
      `スペース2個: [Link target  (id:${targetNode.id})]`,
      `インラインコード: \`[Link target (id:${targetNode.id})]\``,
      'コードブロック:',
      '```',
      `[Link target (id:${targetNode.id})]`,
      '```',
      `存在しないID: [Ghost (id:ZZZ999)]`
    ].join('\n\n')
    await saveContent(page, tree.id, sourceNode.id, content)
  })

  test('リンク化され、表示はブラケットを除いた形・コード内と未存在IDは素のテキスト', async ({ page }) => {
    await openNode(page, tree.id, sourceNode.id)

    const links = page.locator('.bytemd-preview .zeeta-node-link')
    await expect(links).toHaveCount(3)
    // スペースの個数（0・1・2）に関係なく、表示はスペース1個に正規化される
    const expectedText = `Link target (id:${targetNode.id})`
    await expect(links).toHaveText([expectedText, expectedText, expectedText])
    const hrefs = await links.evaluateAll((els) => els.map((el) => el.getAttribute('href')))
    for (const href of hrefs) {
      expect(href).toContain(`tree=${tree.id}`)
      expect(href).toContain(`node=${targetNode.id}`)
    }
    // 表示は外側のブラケットのみ除く（IDは隠さない）+ 下線 + ブランド紫
    const styles = await links.first().evaluate((el) => {
      const cs = getComputedStyle(el)
      return { color: cs.color, textDecoration: cs.textDecorationLine, cursor: cs.cursor }
    })
    expect(styles.color).toBe('rgb(102, 126, 234)')
    expect(styles.textDecoration).toContain('underline')
    expect(styles.cursor).toBe('pointer')

    // コードブロック・インラインコード内はリンク化されない
    await expect(page.locator('.bytemd-preview code .zeeta-node-link')).toHaveCount(0)
    await expect(page.locator('.bytemd-preview pre .zeeta-node-link')).toHaveCount(0)

    // 存在しないIDは素のテキストのまま
    const previewText = await page.locator('.bytemd-preview').textContent()
    expect(previewText).toContain(`[Ghost (id:ZZZ999)]`)
  })

  test('クリックで同一タブ内の該当ノードが開く', async ({ page }) => {
    await openNode(page, tree.id, sourceNode.id)

    const link = page.locator('.bytemd-preview .zeeta-node-link')
    await expect(link).toHaveCount(3)
    await link.first().click()

    await expect(page.locator('#node-title')).toHaveValue('Link target', { timeout: 15000 })
    // 同一タブ内の遷移（ページ遷移していない）
    expect(page.url()).toContain(`node=${sourceNode.id}`)
  })

  test('未保存の編集があるときはガードが出て、破棄を選ぶと遷移する', async ({ page }) => {
    await openNode(page, tree.id, sourceNode.id)

    const link = page.locator('.bytemd-preview .zeeta-node-link')
    await expect(link).toHaveCount(3)

    await page.locator('#node-title').fill('Link source (dirty)')
    await link.first().click()

    const modal = page.locator('#unsaved-confirm-modal')
    await expect(modal).toBeVisible()
    await modal.locator('.confirm-no').click()

    await expect(page.locator('#node-title')).toHaveValue('Link target', { timeout: 15000 })
  })

  test('ゴミ箱のノードへのリンクはゴミ箱ビューへ切り替わってから開く', async ({ page }) => {
    const trashResponse = await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${targetNode.id}`)
    expect(trashResponse.ok()).toBe(true)

    await openNode(page, tree.id, sourceNode.id)

    const link = page.locator('.bytemd-preview .zeeta-node-link')
    await expect(link).toHaveCount(3)
    await link.first().click()

    await expect(page.locator('.tree-view-tab[data-view="trash"]')).toHaveClass(/active/, { timeout: 15000 })
    await expect(page.locator('#node-title')).toHaveValue('Link target', { timeout: 15000 })
  })

  test('URL直接表示でもゴミ箱のノードはゴミ箱ビューで開く', async ({ page }) => {
    const trashResponse = await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/nodes/${targetNode.id}`)
    expect(trashResponse.ok()).toBe(true)

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${targetNode.id}`)

    await expect(page.locator('.tree-view-tab[data-view="trash"]')).toHaveClass(/active/, { timeout: 15000 })
    await expect(page.locator('#node-title')).toHaveValue('Link target', { timeout: 15000 })
  })
})
