import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

const BASE_URL = 'http://localhost:3000'
const FAKE_STAMP = '0101-0000'
const DIALOG = '[data-version-reload-dialog]'
const BADGE = '#update-badge'

async function login(page) {
  await page.context().clearCookies()
  await page.goto(`${BASE_URL}/auth/test-login?user_id=1`)
  await waitForAppReady(page)
}

async function createTree(page, name) {
  const response = await page.request.post(`${BASE_URL}/api/trees`, {
    data: { name, description: '' }
  })
  expect(response.ok()).toBe(true)
  return (await response.json()).data
}

async function createNode(page, treeId, title) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes`, {
    data: { title, content: '', author_user_id: 1 }
  })
  expect(response.ok()).toBe(true)
  return (await response.json()).data
}

/**
 * テスト用に visibilitychange を発生させる。
 * 実タブの表示状態に関係なく visible 扱いでイベントを飛ばす。
 */
async function triggerVisibilityChange(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

/** テスト用に window focus（別アプリからの復帰）を発生させる */
async function triggerWindowFocus(page) {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
}

function mockMismatch(page, { count = () => {} } = {}) {
  return page.route('**/api/version', (route) => {
    count()
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ build: FAKE_STAMP })
    })
  })
}

/**
 * 「何も起きない」ことを確かめるための bounded wait。
 * 発生しないことを待つ手段はこれ以外にないため許容する。
 */
const QUIET_WAIT_MS = 500

test('不一致検知でupdateバッジが表示される。ダイアログは自動では開かない', async ({ page }) => {
  let fetchCount = 0
  await page.addInitScript(() => {
    window.__VERSION_CHECK_CONFIG__ = { throttleMs: 0 }
  })
  await mockMismatch(page, { count: () => fetchCount++ })

  await login(page)
  expect(fetchCount).toBe(0) // ページ読み込み自体ではチェックしない（visibilitychange / focus のみが起点）

  await triggerVisibilityChange(page)

  await expect(page.locator(BADGE)).toBeVisible()
  await expect(page.locator(BADGE)).toHaveText('new ver.')
  await expect(page.locator(DIALOG)).toHaveCount(0)
})

test('バッジをクリックするとダイアログが開き、「リロードする」でリロードされる', async ({ page }) => {
  await page.addInitScript(() => {
    window.__VERSION_CHECK_CONFIG__ = { throttleMs: 0 }
    const n = parseInt(sessionStorage.getItem('__loadCount') || '0', 10) + 1
    sessionStorage.setItem('__loadCount', String(n))
  })
  await mockMismatch(page)

  await login(page)
  await triggerVisibilityChange(page)
  await page.locator(BADGE).click()

  const dialog = page.locator(DIALOG)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'リロードする' })).toBeVisible()
  await dialog.getByRole('button', { name: 'リロードする' }).click()
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('__loadCount')))
    .toBe('2')
})

test('「後で」を選ぶとダイアログは閉じるがバッジは残り、再クリックでまた開ける', async ({ page }) => {
  await page.addInitScript(() => {
    window.__VERSION_CHECK_CONFIG__ = { throttleMs: 0 }
  })
  await mockMismatch(page)

  await login(page)
  await triggerVisibilityChange(page)
  const dialog = page.locator(DIALOG)
  await page.locator(BADGE).click()
  await expect(dialog).toBeVisible()

  await dialog.getByRole('button', { name: '後で' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator(BADGE)).toBeVisible()

  await page.locator(BADGE).click()
  await expect(dialog).toBeVisible()
})

test('スロットル中の再アクティブでは再チェックしない', async ({ page }) => {
  let fetchCount = 0
  await page.addInitScript(() => {
    window.__VERSION_CHECK_CONFIG__ = { throttleMs: 60 * 1000 }
  })
  await mockMismatch(page, { count: () => fetchCount++ })

  await login(page)
  await triggerVisibilityChange(page)
  await expect(page.locator(BADGE)).toBeVisible()
  await expect.poll(() => fetchCount).toBe(1)

  // 60秒以内の再アクティブでは fetch しない
  await triggerVisibilityChange(page)
  await page.waitForTimeout(QUIET_WAIT_MS)
  expect(fetchCount).toBe(1)
})

test('スタンプ一致時はバッジを出さない', async ({ page }) => {
  let fetchCount = 0
  let serverStamp = FAKE_STAMP
  await page.addInitScript(() => {
    window.__VERSION_CHECK_CONFIG__ = { throttleMs: 0 }
  })
  await page.route('**/api/version', (route) => {
    fetchCount++
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ build: serverStamp }) })
  })

  await login(page)
  serverStamp = await page.evaluate(() => window.__BUILD_STAMP__)
  await triggerVisibilityChange(page)
  await expect.poll(() => fetchCount).toBe(1)
  await page.waitForTimeout(QUIET_WAIT_MS)
  await expect(page.locator(BADGE)).toHaveCount(0)
  await expect(page.locator(DIALOG)).toHaveCount(0)
})

test('window focus（別アプリからの復帰）でもチェックしてバッジを出す', async ({ page }) => {
  let fetchCount = 0
  await page.addInitScript(() => {
    window.__VERSION_CHECK_CONFIG__ = { throttleMs: 0 }
  })
  await mockMismatch(page, { count: () => fetchCount++ })

  await login(page)
  expect(fetchCount).toBe(0)

  await triggerWindowFocus(page)

  await expect.poll(() => fetchCount).toBe(1)
  await expect(page.locator(BADGE)).toBeVisible()
})

test('初期クールダウンは無い。ロード直後の focus でも即チェックしてバッジを出す', async ({ page }) => {
  let fetchCount = 0
  await page.addInitScript(() => {
    window.__VERSION_CHECK_CONFIG__ = { throttleMs: 0 }
  })
  await mockMismatch(page, { count: () => fetchCount++ })

  await login(page)
  // ページ遷移直後（＝新しいタブを開いた直後）でも待たずに反応することを確認する
  await triggerWindowFocus(page)
  await expect.poll(() => fetchCount).toBe(1)
  await expect(page.locator(BADGE)).toBeVisible()
})

test('エディタ画面にもビルド日時グローバルとversion-checkが読み込まれる', async ({ page }) => {
  await login(page)
  await page.goto(`${BASE_URL}/`)
  const stamp = await page.evaluate(() => window.__BUILD_STAMP__)
  expect(stamp).toMatch(/^\d{4}-\d{4}$/)
  const src = await page.evaluate(() => {
    const el = document.querySelector('script[src*="version-check.js"]')
    return el ? el.getAttribute('src') : null
  })
  expect(src).not.toBeNull()
})

test.describe('編集画面のバッジ・リロード時のノード復元', () => {
  test.beforeEach(async ({ page }) => {
    const response = await page.request.delete(`${BASE_URL}/api/test/clear`)
    expect(response.ok()).toBe(true)
  })

  test('編集画面: バッジはロール表示の右隣に出て、ヘッダー再描画後も維持される', async ({ page }) => {
    await page.addInitScript(() => {
      window.__VERSION_CHECK_CONFIG__ = { throttleMs: 0 }
    })
    await mockMismatch(page)

    await login(page)
    const tree = await createTree(page, `version-badge-${Date.now()}`)
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForSelector('#tree-header')

    await triggerVisibilityChange(page)

    const slot = page.locator('#tree-header #update-badge-slot')
    await expect(slot.locator(BADGE)).toBeVisible()

    // ツリー切替等によるヘッダー再描画をシミュレートし、バッジが消えず復元されることを確認
    await page.evaluate(() => updateTreeHeader())
    await expect(slot.locator(BADGE)).toBeVisible()
  })

  test('編集画面: 選択中ノードがあればリロード後もそのノードを開き直す', async ({ page }) => {
    await page.addInitScript(() => {
      window.__VERSION_CHECK_CONFIG__ = { throttleMs: 0 }
    })
    await mockMismatch(page)

    await login(page)
    const tree = await createTree(page, `version-reload-${Date.now()}`)
    const node = await createNode(page, tree.id, 'reload-target')

    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${node.id}`)
    await expect(page.locator('#node-title')).toHaveValue('reload-target', { timeout: 15000 })

    // 選択はURLからではなくJSメモリ上（selectedNodeId）で保持される想定なので、
    // URLの node パラメータを剥がしてから検証する（クリック選択でURLが更新されない現行実装を模す）
    await page.evaluate(() => {
      const url = new URL(window.location.href)
      url.searchParams.delete('node')
      history.replaceState(null, '', url)
    })
    expect(new URL(page.url()).searchParams.get('node')).toBeNull()

    await triggerVisibilityChange(page)
    await page.locator(BADGE).click()
    const dialog = page.locator(DIALOG)
    await expect(dialog).toBeVisible()

    await Promise.all([
      page.waitForURL((url) => url.searchParams.get('node') === String(node.id)),
      dialog.getByRole('button', { name: 'リロードする' }).click()
    ])
    await expect(page.locator('#node-title')).toHaveValue('reload-target', { timeout: 15000 })
  })

  // root 直下に X・Z、A は Z の下が STRUCTURAL・X の下が REFERENCE
  async function createSharedChildTree(page) {
    const tree = await createTree(page, `version-reload-path-${Date.now()}`)
    const rootRes = await page.request.get(`${BASE_URL}/api/trees/${tree.id}/nodes`)
    const rootId = String((await rootRes.json()).root_node_id)
    const child = async (title, parentId) => {
      const res = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/nodes/with-parent`, {
        data: { title, content: '', author_user_id: 1, parent_node_id: parentId }
      })
      expect(res.status()).toBe(201)
      return (await res.json()).data.node
    }
    const x = await child('X', rootId)
    const z = await child('Z', rootId)
    const a = await child('A', z.id)
    const ref = await page.request.post(`${BASE_URL}/api/trees/${tree.id}/relations`, {
      data: { parent_node_id: x.id, child_node_id: a.id, relation_type_id: 3 }
    })
    expect(ref.status()).toBe(201)
    return { tree, x, z, a }
  }

  // URL で A を開き（Z>A が選ばれる）、X を開いて REFERENCE 側の X>A を選び直す
  async function selectReferencePosition(page, { tree, x, a }) {
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}&node=${a.id}`)
    await waitForAppReady(page)
    await page.locator(`.tree-item[data-node-path="${x.id}"] .toggle-btn`).click()
    await page.locator(`.tree-item[data-node-path="${x.id}-${a.id}"] .tree-item-title`).click()
    await expect(page.locator(`.tree-item[data-node-path="${x.id}-${a.id}"]`)).toHaveClass(/(^|\s)active(\s|$)/)
  }

  async function reloadFromBadge(page, nodeId) {
    await triggerVisibilityChange(page)
    await page.locator(BADGE).click()
    const dialog = page.locator(DIALOG)
    await expect(dialog).toBeVisible()
    await Promise.all([
      page.waitForURL((url) => url.searchParams.get('node') === String(nodeId)),
      dialog.getByRole('button', { name: 'リロードする' }).click()
    ])
    await waitForAppReady(page)
  }

  test('TC-VERRELOAD-001: リロード前と同じパス（REFERENCE 側の X>A）で開き直し、STRUCTURAL 側の Z は開かない', async ({ page }) => {
    await page.addInitScript(() => {
      window.__VERSION_CHECK_CONFIG__ = { throttleMs: 0 }
    })
    await mockMismatch(page)
    await login(page)
    const nodes = await createSharedChildTree(page)
    const { x, z, a } = nodes
    await selectReferencePosition(page, nodes)

    await reloadFromBadge(page, a.id)

    await expect(page.locator('#node-title')).toHaveValue('A', { timeout: 15000 })
    const reloaded = page.locator(`.tree-item[data-node-path="${x.id}-${a.id}"]`)
    await expect(reloaded).toHaveClass(/(^|\s)active(\s|$)/)
    await expect(reloaded).toBeVisible()
    await expect(page.locator(`.tree-item[data-node-path="${z.id}-${a.id}"]`)).toBeHidden()
  })

  test('TC-VERRELOAD-002: リロードまでにパスが成り立たなくなったら STRUCTURAL の経路（Z>A）で開く', async ({ page }) => {
    await page.addInitScript(() => {
      window.__VERSION_CHECK_CONFIG__ = { throttleMs: 0 }
    })
    await mockMismatch(page)
    await login(page)
    const nodes = await createSharedChildTree(page)
    const { tree, x, z, a } = nodes
    await selectReferencePosition(page, nodes)
    const unlink = await page.request.delete(`${BASE_URL}/api/trees/${tree.id}/relations/${x.id}/${a.id}`)
    expect(unlink.ok()).toBe(true)

    await reloadFromBadge(page, a.id)

    await expect(page.locator('#node-title')).toHaveValue('A', { timeout: 15000 })
    const structural = page.locator(`.tree-item[data-node-path="${z.id}-${a.id}"]`)
    await expect(structural).toHaveClass(/(^|\s)active(\s|$)/)
    await expect(structural).toBeVisible()
  })
})
