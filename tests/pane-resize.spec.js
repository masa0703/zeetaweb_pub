// @ts-check
import { test, expect } from '@playwright/test'
import { testLogin, openTreeEditor } from './helpers/app.js'

test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true })
const testTrees = new WeakMap()

async function width(page) {
  return page.locator('#tree-pane').evaluate(el => el.getBoundingClientRect().width)
}

async function handlePoint(page, offset = 0) {
  const box = await page.locator('#resize-handle').boundingBox()
  if (!box) throw new Error('Resize handle is hidden')
  return { x: box.x + box.width / 2 + offset, y: box.y + 120 }
}

async function touch(cdp, type, point) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: point ? [{ x: point.x, y: point.y, id: 1 }] : []
  })
}

test.beforeEach(async ({ page }) => {
  await testLogin(page)
  const response = await page.request.post('/api/trees', {
    data: { name: 'Pane Resize Test', description: 'Touch and mouse regression' }
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const { data: tree } = await response.json()
  testTrees.set(page, tree.id)
  await openTreeEditor(page, tree.id, tree.root_node_id)
  await expect(page.locator('#resize-handle')).toBeVisible()
  await expect(page.locator('#node-content-editor .bytemd')).toBeVisible()
})

test.afterEach(async ({ page }) => {
  const treeId = testTrees.get(page)
  if (treeId) {
    const response = await page.request.delete(`/api/trees/${treeId}`)
    expect(response.ok(), await response.text()).toBeTruthy()
  }
})

test('TC-PANE-001: mouse drag tracks outside the handle and stops on release', async ({ page }) => {
  const start = await handlePoint(page)
  const before = await width(page)
  await page.mouse.move(start.x, start.y)
  await expect(page.locator('#resize-handle')).toHaveCSS('cursor', 'col-resize')
  await page.mouse.down()
  await page.mouse.move(start.x + 160, start.y + 60, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => width(page)).toBeCloseTo(before + 160, 0)
  await page.mouse.move(start.x + 250, start.y)
  expect(await width(page)).toBeCloseTo(before + 160, 0)
  await expect(page.locator('body')).toHaveCSS('user-select', 'auto')
})

test('TC-PANE-002: real touch starts beyond the visible line and captures drag', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page)
  const start = await handlePoint(page, -8)
  const before = await width(page)
  const scrollBefore = await page.evaluate(() => window.scrollY)
  await touch(cdp, 'touchStart', start)
  await touch(cdp, 'touchMove', { x: start.x + 180, y: start.y + 80 })
  await expect.poll(() => width(page)).toBeCloseTo(before + 180, 0)
  await touch(cdp, 'touchEnd')
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore)
  await expect(page.locator('body')).toHaveCSS('user-select', 'auto')
  // A tap elsewhere must not leave resizing active.
  await touch(cdp, 'touchStart', { x: start.x + 300, y: start.y })
  await touch(cdp, 'touchMove', { x: start.x + 350, y: start.y })
  await touch(cdp, 'touchEnd')
  expect(await width(page)).toBeCloseTo(before + 180, 0)
})

test('TC-PANE-003: touch cancel and capture loss end dragging and allow restart', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page)
  for (const end of ['cancel', 'capture-loss']) {
    const start = await handlePoint(page)
    const before = await width(page)
    await touch(cdp, 'touchStart', start)
    await touch(cdp, 'touchMove', { x: start.x + 50, y: start.y })
    await expect.poll(() => width(page)).toBeCloseTo(before + 50, 0)
    if (end === 'cancel') await touch(cdp, 'touchCancel')
    else {
      // The browser owns capture; explicitly release the actual active touch.
      await page.locator('#resize-handle').evaluate(el => {
        // Use the active pointer ID assigned by Chromium.
        el.addEventListener('pointermove', event => {
          el.releasePointerCapture(event.pointerId)
        }, { once: true })
      })
      await touch(cdp, 'touchMove', { x: start.x + 60, y: start.y })
      await touch(cdp, 'touchEnd')
    }
    await expect(page.locator('body')).toHaveCSS('user-select', 'auto')
    const stopped = await width(page)
    const next = await handlePoint(page)
    await touch(cdp, 'touchStart', next)
    await touch(cdp, 'touchMove', { x: next.x + 40, y: next.y })
    await touch(cdp, 'touchEnd')
    await expect.poll(() => width(page)).toBeCloseTo(stopped + 40, 0)
  }
})

test('TC-PANE-003: a second finger cannot take over or end the first drag', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page)
  const start = await handlePoint(page)
  const before = await width(page)
  const first = { x: start.x, y: start.y, id: 1 }
  const second = { x: start.x, y: start.y + 70, id: 2 }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first, second] })
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove', touchPoints: [first, { ...second, x: second.x + 100 }]
  })
  expect(await width(page)).toBeCloseTo(before, 0)
  // CDP touchEnd points identify the contacts being released.
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd', touchPoints: [{ ...second, x: second.x + 100 }]
  })
  await touch(cdp, 'touchMove', { x: start.x + 80, y: start.y })
  await touch(cdp, 'touchEnd')
  await expect.poll(() => width(page)).toBeCloseTo(before + 80, 0)
})

test('TC-PANE-004: width bounds and right mouse button are respected', async ({ page }) => {
  const start = await handlePoint(page)
  const before = await width(page)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(start.x + 80, start.y)
  await page.mouse.up({ button: 'right' })
  expect(await width(page)).toBeCloseTo(before, 0)
  await page.keyboard.press('Escape')
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(1, start.y)
  await page.mouse.up()
  const min = await width(page)
  const container = await page.locator('#main-container').evaluate(el => el.clientWidth)
  expect(min).toBeGreaterThanOrEqual(container * 0.2 - 1)
  const next = await handlePoint(page)
  await page.mouse.move(next.x, next.y)
  await page.mouse.down()
  await page.mouse.move(1279, next.y)
  await page.mouse.up()
  const rail = await page.locator('#tree-rail').evaluate(el => el.clientWidth)
  expect(await width(page)).toBeLessThanOrEqual(container * 0.8 - rail + 1)
})

test('TC-PANE-005: split bar stays hidden on mobile width', async ({ page }) => {
  await page.setViewportSize({ width: 767, height: 800 })
  await expect(page.locator('#resize-handle')).toBeHidden()
  await page.reload()
  await expect(page.locator('#resize-handle')).toBeHidden()
})

for (const dark of [false, true]) {
  const theme = dark ? 'dark' : 'light'
  const idleColor = dark ? 'rgb(75, 85, 99)' : 'rgb(209, 213, 219)'
  const blue = 'rgb(59, 130, 246)'

  test(`TC-PANE-006: ${theme} hover turns blue and restores the idle color`, async ({ page }) => {
    await page.locator('html').evaluate((el, enabled) => el.classList.toggle('theme-dark', enabled), dark)
    const handle = page.locator('#resize-handle')
    await page.mouse.move(0, 0)
    await expect(handle).toHaveCSS('background-color', idleColor)
    const start = await handlePoint(page, -8)
    await page.mouse.move(start.x, start.y)
    await expect(handle).toHaveCSS('background-color', blue)
    await page.mouse.move(0, 0)
    await expect(handle).toHaveCSS('background-color', idleColor)
  })

  test(`TC-PANE-006: ${theme} touch drag stays blue until release or cancellation`, async ({ page, context }) => {
    await page.locator('html').evaluate((el, enabled) => el.classList.toggle('theme-dark', enabled), dark)
    const cdp = await context.newCDPSession(page)
    const handle = page.locator('#resize-handle')
    for (const end of ['up', 'cancel', 'capture-loss']) {
      const start = await handlePoint(page)
      await touch(cdp, 'touchStart', start)
      await touch(cdp, 'touchMove', { x: start.x + 40, y: start.y + 50 })
      await expect(handle).toHaveCSS('background-color', blue)
      if (end === 'capture-loss') {
        await handle.evaluate(el => {
          el.addEventListener('pointermove', event => el.releasePointerCapture(event.pointerId), { once: true })
        })
        await touch(cdp, 'touchMove', { x: start.x + 50, y: start.y + 50 })
        // Capture loss is delivered before the next pointer event.
        await touch(cdp, 'touchMove', { x: start.x + 90, y: start.y + 60 })
        await expect(handle).not.toHaveClass(/dragging/)
        await touch(cdp, 'touchEnd')
      } else await touch(cdp, end === 'up' ? 'touchEnd' : 'touchCancel')
      await expect(handle).not.toHaveClass(/dragging/)
      // Clear any touch-emulated hover before checking the idle state.
      await page.mouse.move(0, 0)
      await expect(handle).toHaveCSS('background-color', idleColor)
    }
  })
}
