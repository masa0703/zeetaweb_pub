import { test, expect } from './helpers/fixtures.js'
import { testLogin, openTreeEditor } from './helpers/app.js'

test.use({ viewport: { width: 1280, height: 800 } })
const ACTIVE = /(^|\s)active(\s|$)/
const fixtures = new WeakMap()
const item = (page, path) => page.locator(`.tree-item[data-node-path="${path}"]`)

async function child(page, tree, parent, title) {
  const res = await page.request.post(`/api/trees/${tree.id}/nodes/with-parent`, {
    data: { title, content: `${title} content`, parent_node_id: parent, author_user_id: 1 }
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()).data.node
}

async function collapse(page, path) {
  const toggle = item(page, path).locator('.toggle-btn')
  if (await toggle.locator('.caret-expanded').count()) await toggle.click()
  await expect(toggle.locator('.caret-expanded')).toHaveCount(0)
}

async function editDraft(page) {
  await page.locator('#node-title').fill('Unsaved title')
  await page.evaluate(() => {
    window.currentEditor.value('Unsaved body')
    checkDirty()
    window.__revealTitle = document.getElementById('node-title')
    window.__revealEditor = window.currentEditor
    window.__revealHistory = JSON.stringify([nodeNavHistory, nodeNavHistoryIndex])
  })
}

async function expectDraftPreserved(page) {
  await expect(page.locator('#node-title')).toHaveValue('Unsaved title')
  expect(await page.evaluate(() => ({
    sameTitle: window.__revealTitle === document.getElementById('node-title'),
    sameEditor: window.__revealEditor === window.currentEditor,
    body: window.currentEditor.value(),
    dirty: isDirty,
    sameHistory: window.__revealHistory === JSON.stringify([nodeNavHistory, nodeNavHistoryIndex])
  }))).toEqual({ sameTitle: true, sameEditor: true, body: 'Unsaved body', dirty: true, sameHistory: true })
}

test.beforeEach(async ({ page }) => {
  await testLogin(page)
  const res = await page.request.post('/api/trees', { data: { name: 'Reveal displayed node test' } })
  expect(res.ok(), await res.text()).toBeTruthy()
  const tree = (await res.json()).data
  fixtures.set(page, { tree })
  const x = await child(page, tree, tree.root_node_id, 'X')
  const z = await child(page, tree, tree.root_node_id, 'Z')
  const a = await child(page, tree, z.id, 'A')
  const reference = await page.request.post(`/api/trees/${tree.id}/relations`, {
    data: { parent_node_id: x.id, child_node_id: a.id, relation_type_id: 3 }
  })
  expect(reference.ok()).toBeTruthy()
  fixtures.set(page, { tree, x, z, a })
  await openTreeEditor(page, tree.id, a.id)
  await expect(page.locator('#node-title')).toHaveValue('A')
  await expect(page.locator('#node-content-editor .bytemd')).toBeVisible()
})

test.afterEach(async ({ page }) => {
  const fixture = fixtures.get(page)
  if (fixture) {
    const res = await page.request.delete(`/api/trees/${fixture.tree.id}`)
    expect(res.ok(), await res.text()).toBeTruthy()
  }
})

test('TC-REVEAL-001: expands only the target path, scrolls into view and preserves drafts/history', async ({ page }) => {
  const { tree, x } = fixtures.get(page)
  // Place the selected branch below the visible tree viewport.
  for (let i = 0; i < 30; i++) await child(page, tree, tree.root_node_id, `Filler ${i}`)
  const z = await child(page, tree, tree.root_node_id, 'Late parent')
  const a = await child(page, tree, z.id, 'Late child')
  await openTreeEditor(page, tree.id, a.id)
  await expect(page.locator('#node-title')).toHaveValue('Late child')
  await collapse(page, x.id)
  await collapse(page, z.id)
  await editDraft(page)
  await page.locator('#tree-pane-scroll').evaluate(el => { el.scrollTop = 0 })
  await expect(item(page, z.id)).not.toBeInViewport()
  const reads = []
  page.on('request', req => {
    if (new RegExp(`/nodes/${a.id}(?:/parents)?(?:\\?|$)`).test(req.url())) reads.push(req.url())
  })
  await page.locator('#show-in-tree-btn').click()
  const target = item(page, `${z.id}-${a.id}`)
  await expect(target).toBeVisible()
  await expect(target).toHaveClass(ACTIVE)
  await expect(target).toBeInViewport()
  await expect(item(page, `${x.id}-${a.id}`)).toBeHidden()
  await expectDraftPreserved(page)
  expect(reads).toEqual([])
})

test('TC-REVEAL-002: retains the original reference path instead of opening all parents', async ({ page }) => {
  const { x, z, a } = fixtures.get(page)
  await item(page, x.id).locator('.toggle-btn').click()
  await item(page, `${x.id}-${a.id}`).locator('.tree-item-title').click()
  await expect(item(page, `${x.id}-${a.id}`)).toHaveClass(ACTIVE)
  await collapse(page, x.id)
  await collapse(page, z.id)
  await page.locator('#show-in-tree-btn').click()
  await expect(item(page, `${x.id}-${a.id}`)).toBeVisible()
  await expect(item(page, `${x.id}-${a.id}`)).toHaveClass(ACTIVE)
  await expect(item(page, `${z.id}-${a.id}`)).toBeHidden()
})

test('TC-REVEAL-003: falls back to the structural path when the original relation no longer exists', async ({ page }) => {
  const { tree, x, z, a } = fixtures.get(page)
  await item(page, x.id).locator('.toggle-btn').click()
  await item(page, `${x.id}-${a.id}`).locator('.tree-item-title').click()
  await expect(item(page, `${x.id}-${a.id}`)).toHaveClass(ACTIVE)
  const res = await page.request.delete(`/api/trees/${tree.id}/relations/${x.id}/${a.id}`)
  expect(res.ok(), await res.text()).toBeTruthy()
  // Simulate the relationship refresh while the existing editor remains open.
  await page.evaluate(({ x, a }) => {
    relations = relations.filter(rel => !(rel.parent_node_id === x && rel.child_node_id === a))
    rebuildRelationIndexes()
  }, { x: x.id, a: a.id })
  await collapse(page, z.id)
  await editDraft(page)
  await page.locator('#show-in-tree-btn').click()
  await expect(item(page, `${z.id}-${a.id}`)).toBeVisible()
  await expect(item(page, `${z.id}-${a.id}`)).toHaveClass(ACTIVE)
  await expectDraftPreserved(page)
})

test('TC-REVEAL-004: keeps the reverse root, selected ancestor, drafts and history', async ({ page }) => {
  const { z, a } = fixtures.get(page)
  await page.locator('[data-view="reverse"]').click()
  await expect(item(page, `${a.id}-${z.id}`)).toBeVisible()
  await item(page, `${a.id}-${z.id}`).locator('.tree-item-title').click()
  await expect(page.locator('#node-title')).toHaveValue('Z')
  await collapse(page, a.id)
  await editDraft(page)
  await page.locator('#show-in-tree-btn').click()
  await expect(page.locator('[data-view="reverse"]')).toHaveClass(ACTIVE)
  await expect(item(page, `${a.id}-${z.id}`)).toBeVisible()
  await expect(item(page, `${a.id}-${z.id}`)).toHaveClass(ACTIVE)
  expect(await page.evaluate(() => selectedNodeId)).toBe(a.id)
  await expectDraftPreserved(page)
})

test('TC-REVEAL-005: reveals a trash descendant and preserves trash mode', async ({ page }) => {
  const { tree, z, a } = fixtures.get(page)
  // Remove the reference so A is only reachable from the trashed branch.
  const { x } = fixtures.get(page)
  await page.request.delete(`/api/trees/${tree.id}/relations/${x.id}/${a.id}`)
  const deleted = await page.request.delete(`/api/trees/${tree.id}/nodes/${z.id}`)
  expect(deleted.ok()).toBeTruthy()
  await page.reload()
  await page.locator('[data-view="trash"]').click()
  await item(page, z.id).locator('.toggle-btn').click()
  await item(page, `${z.id}-${a.id}`).locator('.tree-item-title').click()
  await expect(page.locator('#node-title')).toHaveValue('A')
  await collapse(page, z.id)
  // Trash nodes are read-only; preserve their displayed editor and history.
  await expect(page.locator('#node-title')).toBeDisabled()
  const titleElement = await page.locator('#node-title').elementHandle()
  const history = await page.evaluate(() => JSON.stringify([nodeNavHistory, nodeNavHistoryIndex]))
  await page.locator('#show-in-tree-btn').click()
  await expect(page.locator('[data-view="trash"]')).toHaveClass(ACTIVE)
  await expect(item(page, `${z.id}-${a.id}`)).toBeVisible()
  await expect(item(page, `${z.id}-${a.id}`)).toHaveClass(ACTIVE)
  await expect(page.locator('#node-title')).toHaveValue('A')
  expect(await titleElement.evaluate(el => el === document.getElementById('node-title'))).toBe(true)
  expect(await page.evaluate(() => JSON.stringify([nodeNavHistory, nodeNavHistoryIndex]))).toBe(history)
})

test('TC-REVEAL-006: button placement, tooltip, dark/mobile layout and unavailable view', async ({ page }) => {
  const button = page.getByRole('button', { name: 'ツリー上に表示', exact: true })
  await expect(button).toHaveText('←')
  await expect(button).toHaveAttribute('title', 'ツリー上に表示')
  const placement = await button.evaluate(el => {
    const label = el.previousElementSibling
    return { label: label.textContent.trim(), right: el.getBoundingClientRect().left >= label.getBoundingClientRect().right }
  })
  expect(placement).toEqual({ label: 'TITLE', right: true })
  for (const dark of [false, true]) {
    await page.locator('html').evaluate((el, dark) => el.classList.toggle('theme-dark', dark), dark)
    await page.setViewportSize({ width: 390, height: 800 })
    await expect(button).toBeVisible()
    await expect(button).toBeEnabled()
    await button.click()
    await expect(page.locator('.tree-item.active')).toBeInViewport()
    await page.setViewportSize({ width: 1280, height: 800 })
  }
  await page.locator('[data-view="trash"]').click()
  await editDraft(page)
  await button.click()
  await expect(page.getByText('この表示モードには対象ノードがありません', { exact: true })).toBeVisible()
  await expect(page.locator('[data-view="trash"]')).toHaveClass(ACTIVE)
  await expectDraftPreserved(page)
})
