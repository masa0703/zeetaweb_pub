import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

const BASE_URL = 'http://localhost:3000'

async function login(page) {
  await page.context().clearCookies()
  await page.goto(`${BASE_URL}/auth/test-login?user_id=1`)
  await waitForAppReady(page)
}

const DEFAULT_DIAGRAMS = [
  'flowchart LR\n  FirstStart[FIRST_DIAGRAM] --> FirstEnd[FIRST_TARGET]',
  'flowchart TD\n  SecondStart[SECOND_DIAGRAM] --> SecondEnd[SECOND_TARGET]',
]

async function createMermaidNode(page, diagrams = DEFAULT_DIAGRAMS) {
  const treeResponse = await page.request.post(`${BASE_URL}/api/trees`, {
    data: { name: 'Mermaid Viewer Test', description: 'Mermaid viewer E2E' },
  })
  expect(treeResponse.ok()).toBeTruthy()
  const tree = (await treeResponse.json()).data

  const content = diagrams.map(diagram => ['```mermaid', diagram, '```'].join('\n')).join('\n\n')
  const nodeResponse = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes`, {
    data: { title: 'Mermaid Viewer Node', content, author_user_id: 1 },
  })
  expect(nodeResponse.ok()).toBeTruthy()
  const node = (await nodeResponse.json()).data

  const relationResponse = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/relations`, {
    data: { parent_node_id: tree.root_node_id, child_node_id: node.id },
  })
  expect(relationResponse.ok()).toBeTruthy()

  await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
  await page.locator(`.tree-item[data-node-id="${node.id}"]`).click()
  const rendered = page.locator('.bytemd-preview .bytemd-mermaid[data-mermaid-viewer-ready="true"]')
  await expect(rendered).toHaveCount(diagrams.length, { timeout: 30000 })
  return rendered
}

function parseViewBox(value) {
  const numbers = String(value).trim().split(/[\s,]+/).map(Number)
  expect(numbers).toHaveLength(4)
  expect(numbers.every(Number.isFinite)).toBeTruthy()
  return { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] }
}

test.describe('Mermaid preview viewer', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.delete(`${BASE_URL}/api/test/clear`)
    await login(page)
  })

  test('TC-FUNC-056: Previewで選んだMermaid図だけを別タブに表示する', async ({ page }) => {
    const diagrams = await createMermaidNode(page)

    await expect(diagrams.first()).toHaveCSS('cursor', 'pointer')
    await expect(diagrams.first()).toHaveAttribute('title', 'クリックして別タブで拡大表示')
    await expect(diagrams.first()).toHaveAttribute('tabindex', '0')

    let popupCount = 0
    page.on('popup', () => { popupCount += 1 })
    await page.locator('.bytemd-editor .CodeMirror').click()
    await page.waitForTimeout(250)
    expect(popupCount).toBe(0)

    const popupPromise = page.waitForEvent('popup')
    await diagrams.nth(1).click()
    const viewer = await popupPromise
    await expect(viewer).toHaveURL(/\/mermaid-viewer\?channel=/)

    const viewerSvg = viewer.locator('#mermaid-canvas > svg')
    await expect(viewerSvg).toBeVisible({ timeout: 10000 })
    await expect(viewerSvg).toContainText('SECOND_DIAGRAM')
    await expect(viewerSvg).not.toContainText('FIRST_DIAGRAM')
    await expect(page.locator('.bytemd-preview .bytemd-mermaid')).toHaveCount(2)
  })

  // ラベルの `<br/>` は foreignObject 内のXHTML `<br>` として描画される。
  // 受け渡しをHTMLシリアライズ（outerHTML）で行うと閉じタグが落ち、
  // viewer側の厳格なXMLパースが parsererror になって図が表示できなくなる。
  test('TC-FUNC-056: ラベルに<br/>を含むMermaid図も別タブで表示できる', async ({ page }) => {
    const diagrams = await createMermaidNode(page, [
      'flowchart TD\n  BrStart["BR_DIAGRAM<br/>(1行目)"] --> BrEnd["BR_TARGET<br/>(2行目)"]',
    ])

    const popupPromise = page.waitForEvent('popup')
    await diagrams.first().click()
    const viewer = await popupPromise

    const viewerSvg = viewer.locator('#mermaid-canvas > svg')
    await expect(viewerSvg).toBeVisible({ timeout: 10000 })
    await expect(viewerSvg).toContainText('BR_TARGET')
    await expect(viewer.locator('#viewer-status')).toBeHidden()
  })

  test('TC-FUNC-056: 別タブでMermaid図を拡大・縮小・全体表示できる', async ({ page }) => {
    const diagrams = await createMermaidNode(page)
    const popupPromise = page.waitForEvent('popup')
    await diagrams.first().click()
    const viewer = await popupPromise

    const viewerSvg = viewer.locator('#mermaid-canvas > svg')
    await expect(viewerSvg).toBeVisible({ timeout: 10000 })
    const initial = parseViewBox(await viewerSvg.getAttribute('viewBox'))
    await expect(viewer.locator('#zoom-level')).toHaveText('100%')

    await viewer.locator('#zoom-in').click()
    await expect(viewer.locator('#zoom-level')).toHaveText('125%')
    const zoomedIn = parseViewBox(await viewerSvg.getAttribute('viewBox'))
    expect(zoomedIn.width).toBeLessThan(initial.width)
    expect(zoomedIn.height).toBeLessThan(initial.height)

    await viewer.locator('#zoom-out').click()
    await expect(viewer.locator('#zoom-level')).toHaveText('100%')
    const zoomedOut = parseViewBox(await viewerSvg.getAttribute('viewBox'))
    expect(zoomedOut.width).toBeCloseTo(initial.width, 5)
    expect(zoomedOut.height).toBeCloseTo(initial.height, 5)

    await viewer.locator('#zoom-in').click()
    await viewer.locator('#fit-view').click()
    await expect(viewer.locator('#zoom-level')).toHaveText('100%')
    expect(parseViewBox(await viewerSvg.getAttribute('viewBox'))).toEqual(initial)
  })
})
