import { test, expect } from '@playwright/test'
import { waitForAppReady, testLogin, openTreeEditor, openTreeDrawer, drawerRow, chooseTreeMenu, waitForTreeTitle } from './helpers/app.js'

// マイページ廃止: ツリーの一覧・切替・管理を編集画面の左バーへ集約した仕様の検証。
// 仕様の正は zeeta「マイページを廃止 (id:bj2Qkb)」の実装計画。

async function clearTestData(page) {
  await page.request.delete('/api/test/clear')
}

async function createTree(page, name) {
  const response = await page.request.post('/api/trees', { data: { name } })
  expect(response.status()).toBe(201)
  return (await response.json()).data
}

async function createChildNode(page, treeId, title) {
  const rootRes = await page.request.get(`/api/trees/${treeId}/nodes`)
  const rootNodeId = String((await rootRes.json()).root_node_id)
  const me = (await (await page.request.get('/auth/me')).json()).data
  const res = await page.request.post(`/api/trees/${treeId}/nodes/with-parent`, {
    data: { title, content: '', author_user_id: me.id, parent_node_id: rootNodeId }
  })
  expect(res.status()).toBe(201)
  return (await res.json()).data.node
}

async function shareTree(ownerPage, browser, treeId, userId, role) {
  const invite = await ownerPage.request.post(`/api/trees/${treeId}/invitations`, {
    data: { email: `test-user-${userId}@example.com`, role }
  })
  expect(invite.status()).toBe(201)
  const token = (await invite.json()).data.token
  const memberPage = await browser.newPage()
  await testLogin(memberPage, userId)
  const accept = await memberPage.request.post(`/api/invitations/${token}/accept`, { data: {} })
  expect(accept.status()).toBe(200)
  return memberPage
}

test.describe('左バー（ツリー切替・管理）', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-RAIL-001: 既存のノードURL（?tree=&node=）はそのまま該当ノードを開く', async ({ page }) => {
    await testLogin(page, 1)
    const tree = await createTree(page, 'Legacy Link Tree')
    const node = await createChildNode(page, tree.id, 'リンク先ノード')

    const response = await page.goto(`/index.html?tree=${tree.id}&node=${node.id}`)
    expect(response.status()).toBe(200)
    await waitForAppReady(page)
    expect(new URL(page.url()).search).toBe(`?tree=${tree.id}&node=${node.id}`)
    await expect(page.locator('#node-title')).toHaveValue('リンク先ノード')
  })

  test('TC-RAIL-002: /my-page と /my-page.html は最後に開いたツリーへ着地する', async ({ page }) => {
    await testLogin(page, 1)
    const first = await createTree(page, 'First Tree')
    const second = await createTree(page, 'Second Tree')
    await openTreeEditor(page, second.id)
    await openTreeEditor(page, first.id)

    for (const path of ['/my-page', '/my-page.html']) {
      const res = await page.request.get(path, { maxRedirects: 0 })
      expect(res.status()).toBe(302)
      expect(res.headers().location).toBe('/index.html')

      await page.goto(path)
      await waitForAppReady(page)
      expect(new URL(page.url()).pathname).toBe('/index.html')
      expect(new URL(page.url()).searchParams.get('tree')).toBe(String(first.id))
      await expect(page.locator('#tree-header h1')).toHaveText('First Tree')
    }
  })

  test('TC-RAIL-003: ログイン直後は最後に開いたツリー、記録が無ければ一覧の先頭に着地する', async ({ page }) => {
    await testLogin(page, 1)
    await createTree(page, 'Alpha')
    const beta = await createTree(page, 'Beta')

    await page.evaluate(() => localStorage.removeItem('zeeta:last-accessed-trees'))
    await testLogin(page, 1)
    const landedId = new URL(page.url()).searchParams.get('tree')
    expect(landedId).not.toBeNull()

    await openTreeEditor(page, beta.id)
    await testLogin(page, 1)
    expect(new URL(page.url()).searchParams.get('tree')).toBe(String(beta.id))
  })

  test('TC-RAIL-004: ツリー0件では作成を促す空画面を出し、作成するとそのツリーを開く', async ({ page }) => {
    await testLogin(page, 1)

    await expect(page.locator('#tree-empty-state')).toBeVisible()
    await expect(page.locator('#tree-pane')).toBeHidden()
    await page.locator('#tree-empty-create-btn').click()
    await expect(page.locator('#create-tree-modal')).toHaveClass(/active/)
    await page.locator('#tree-name').fill('はじめてのツリー')
    await page.locator('#create-tree-form button[type="submit"]').click()

    await waitForAppReady(page)
    await expect(page.locator('#tree-header h1')).toHaveText('はじめてのツリー')
    await expect(page.locator('#tree-empty-state')).toBeHidden()
  })

  test('TC-RAIL-005: 閉じた左バーに全ツリーの頭文字アイコンが並び、クリックで切り替わる', async ({ page }) => {
    await testLogin(page, 1)
    const alpha = await createTree(page, 'alpha')
    const beta = await createTree(page, 'Beta')
    await openTreeEditor(page, alpha.id)

    const chips = page.locator('#tree-rail-list .tree-rail-chip')
    await expect(chips).toHaveCount(2)
    const alphaChip = page.locator(`#tree-rail-list .tree-rail-chip[data-tree-id="${alpha.id}"]`)
    await expect(alphaChip).toHaveClass(/current/)
    await expect(alphaChip).toHaveText('A')
    await expect(alphaChip).toHaveAttribute('aria-label', 'alpha')

    await page.locator(`#tree-rail-list .tree-rail-chip[data-tree-id="${beta.id}"]`).click()
    await waitForAppReady(page)
    expect(new URL(page.url()).searchParams.get('tree')).toBe(String(beta.id))
    await expect(page.locator('#tree-header h1')).toHaveText('Beta')
  })

  test('TC-RAIL-006: ☰ で左バーが重なって開き、外側クリックと Esc で閉じる', async ({ page }) => {
    await testLogin(page, 1)
    const tree = await createTree(page, 'Drawer Tree')
    await openTreeEditor(page, tree.id)

    const paneBox = await page.locator('#tree-pane').boundingBox()
    await openTreeDrawer(page)
    await expect(page.locator('#app-menu-btn')).toHaveAttribute('aria-expanded', 'true')
    // 重ねて表示するので、ツリーペインは押し出されない
    expect(await page.locator('#tree-pane').boundingBox()).toEqual(paneBox)
    await expect(drawerRow(page, 'Drawer Tree')).toHaveClass(/current/)

    await page.locator('#tree-drawer-scrim').click({ position: { x: 600, y: 300 } })
    await expect(page.locator('#tree-drawer')).not.toHaveClass(/open/)

    await openTreeDrawer(page)
    await page.keyboard.press('Escape')
    await expect(page.locator('#tree-drawer')).not.toHaveClass(/open/)
    await expect(page.locator('#app-menu-btn')).toHaveAttribute('aria-expanded', 'false')
  })

  test('TC-RAIL-007: ⋯ メニューの項目がロールで出し分けられる', async ({ page, browser }) => {
    await testLogin(page, 1)
    const owned = await createTree(page, 'Owned Tree')
    const editorPage = await shareTree(page, browser, owned.id, 2, 'editor')
    const viewerPage = await shareTree(page, browser, owned.id, 3, 'viewer')

    const menuActions = async (p) => {
      await openTreeEditor(p, owned.id)
      await openTreeDrawer(p)
      const row = drawerRow(p, 'Owned Tree')
      await row.locator('.tree-drawer-more').click()
      return row.locator('.tree-drawer-menu [data-action]').evaluateAll(els => els.map(el => el.dataset.action))
    }

    expect(await menuActions(page)).toEqual(['edit', 'mcp', 'members', 'delete'])
    expect(await menuActions(editorPage)).toEqual(['members'])
    expect(await menuActions(viewerPage)).toEqual([])
    await expect(drawerRow(viewerPage, 'Owned Tree').locator('.tree-drawer-menu')).toContainText('Test User 1')

    // 共有ツリーは行の E/V 表示で見分ける（区画は分けない）
    await expect(drawerRow(editorPage, 'Owned Tree').locator('.tree-role-mini.editor')).toHaveText('E')
    await editorPage.close()
    await viewerPage.close()
  })

  test('TC-RAIL-008: ツリーが多いとき、＋ボタンを固定したまま一覧だけスクロールする', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 })
    await testLogin(page, 1)
    let first
    for (let i = 0; i < 25; i++) {
      const tree = await createTree(page, `Many ${String(i).padStart(2, '0')}`)
      first = first || tree
    }
    await openTreeEditor(page, first.id)

    const list = page.locator('#tree-rail-list')
    const createBtn = page.locator('#tree-rail-create-btn')
    const before = await createBtn.boundingBox()
    expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    await list.evaluate(el => { el.scrollTop = el.scrollHeight })
    expect(await createBtn.boundingBox()).toEqual(before)
    await expect(page.locator('#tree-rail-list .tree-rail-chip').last()).toBeInViewport()

    await openTreeDrawer(page)
    const drawerList = page.locator('#tree-drawer-list')
    const drawerCreate = page.locator('#tree-drawer-create-btn')
    const drawerBefore = await drawerCreate.boundingBox()
    expect(await drawerList.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    await drawerList.evaluate(el => { el.scrollTop = el.scrollHeight })
    expect(await drawerCreate.boundingBox()).toEqual(drawerBefore)
  })

  test('TC-RAIL-009: スマホ幅では左バーを出さず、☰ で重ねて開く', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 })
    await testLogin(page, 1)
    const tree = await createTree(page, 'Mobile Tree')
    await openTreeEditor(page, tree.id)

    await expect(page.locator('#tree-rail')).toBeHidden()
    await openTreeDrawer(page)
    await expect(drawerRow(page, 'Mobile Tree')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test('TC-RAIL-010: 存在しない・権限の無いツリーはエラーを出して最後に開いたツリーへ切り替える', async ({ page }) => {
    await testLogin(page, 1)
    const tree = await createTree(page, 'Fallback Tree')
    await openTreeEditor(page, tree.id)

    await openTreeEditor(page, 999999)
    await expect(page.locator('.toast').first()).toBeVisible()
    expect(new URL(page.url()).searchParams.get('tree')).toBe(String(tree.id))
    await expect(page.locator('#tree-header h1')).toHaveText('Fallback Tree')
  })

  test('TC-RAIL-011: ツリーの名前変更と削除を ⋯ メニューから行える', async ({ page }) => {
    await testLogin(page, 1)
    const keep = await createTree(page, 'Keep Tree')
    await createTree(page, 'Rename Me')
    await openTreeEditor(page, keep.id)

    await chooseTreeMenu(page, 'Rename Me', 'edit')
    await expect(page.locator('#edit-tree-modal')).toHaveClass(/active/)
    await page.locator('#edit-tree-name').fill('Renamed Tree')
    await page.locator('#edit-tree-form button[type="submit"]').click()
    await expect(page.locator('#edit-tree-modal')).not.toHaveClass(/active/)
    await openTreeDrawer(page)
    await expect(drawerRow(page, 'Renamed Tree')).toBeVisible()

    await chooseTreeMenu(page, 'Renamed Tree', 'delete')
    await expect(page.locator('#delete-tree-modal')).toHaveClass(/active/)
    await page.locator('#delete-tree-modal button.bg-red-600').click()
    await expect(page.locator('#delete-tree-modal')).not.toHaveClass(/active/)
    await expect(page.locator('#tree-drawer .tree-drawer-row', { hasText: 'Renamed Tree' })).toHaveCount(0)
    await expect(page.locator('#tree-rail-list .tree-rail-chip')).toHaveCount(1)
  })

  test('TC-RAIL-012: 通知・設定・ログアウトはヘッダーにあり、ユーザー表示は出さない', async ({ page }) => {
    await testLogin(page, 1)
    const tree = await createTree(page, 'Header Tree')
    await openTreeEditor(page, tree.id)

    const header = page.locator('#tree-header')
    await expect(header.locator('#notification-bell-btn')).toBeVisible()
    await header.locator('#notification-bell-btn').click()
    await expect(page.locator('#notification-dropdown')).toHaveClass(/active/)

    await header.locator('#settings-btn').click()
    await expect(page.locator('#settings-menu')).toBeVisible()
    await expect(page.locator('#theme-switcher')).toBeVisible()
    await expect(page.locator('#lang-switcher')).toBeVisible()
    await expect(page.locator('#profile-link')).toHaveAttribute('href', '/profile.html')

    // ユーザーアイコン・表示名・メールアドレスはヘッダーに出さない（2026-10-30 ユーザー判断）
    await expect(header.locator('.header-user, #user-avatar, #user-name, #user-email')).toHaveCount(0)
    await header.locator('#logout-btn').click()
    await page.waitForURL(/\/login(?:\.html)?/)
  })

  test('TC-RAIL-013: 一覧には出るがツリー詳細を開けないときも、エラーを出して別のツリーへ切り替える', async ({ page }) => {
    await testLogin(page, 1)
    const keep = await createTree(page, 'Keep Tree')
    const broken = await createTree(page, 'Broken Tree')
    await openTreeEditor(page, keep.id)

    // 一覧取得の直後に削除・権限変更された状態を再現する（詳細だけ 404）
    await page.route(`**/api/trees/${broken.id}`, route => (
      route.request().method() === 'GET'
        ? route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Tree not found' }) })
        : route.continue()
    ))
    await openTreeEditor(page, broken.id)

    await expect(page.locator('.toast').first()).toBeVisible()
    expect(new URL(page.url()).searchParams.get('tree')).toBe(String(keep.id))
    await expect(page.locator('#tree-header-title')).toHaveText('Keep Tree')
  })

  test('TC-RAIL-014: 記録が無いときの着地先は左バーの先頭（自分・共有を問わず作成順で最初）', async ({ page, browser }) => {
    // 共有ツリーの方が ID が小さくなるよう、先に user 2 が作る
    const ownerPage = await browser.newPage()
    await testLogin(ownerPage, 2)
    const shared = await ownerPage.request.post('/api/trees', { data: { name: 'Older Shared Tree' } })
    const sharedTree = (await shared.json()).data
    const invite = await ownerPage.request.post(`/api/trees/${sharedTree.id}/invitations`, {
      data: { email: 'test-user-1@example.com', role: 'editor' }
    })
    const token = (await invite.json()).data.token

    await testLogin(page, 1)
    await page.request.post(`/api/invitations/${token}/accept`, { data: {} })
    const mine = await createTree(page, 'Newer Own Tree')
    expect(mine.id).toBeGreaterThan(sharedTree.id)

    await page.evaluate(() => localStorage.removeItem('zeeta:last-accessed-trees'))
    await testLogin(page, 1)
    // 開いた記録が無いので作成順。共有ツリーの方が古いので先頭に来て、そこに着地する
    expect(new URL(page.url()).searchParams.get('tree')).toBe(String(sharedTree.id))
    await expect(page.locator('#tree-rail-list .tree-rail-chip').first()).toHaveAttribute('data-tree-id', String(sharedTree.id))
    await ownerPage.close()
  })

  test('TC-RAIL-015: スマホ幅でツリー名が長くても、通知・設定・ログアウトが画面内に収まる', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 })
    await testLogin(page, 1)
    const tree = await createTree(page, 'とても長いツリー名のテスト用ツリー version-reload-1793368830252')
    await openTreeEditor(page, tree.id)

    for (const id of ['#notification-bell-btn', '#settings-btn', '#logout-btn']) {
      const box = await page.locator(id).boundingBox()
      expect(box, id).toBeTruthy()
      expect(box.x + box.width, id).toBeLessThanOrEqual(375)
    }
  })

  test('TC-RAIL-016: 開いた左バーは右端のつまみで幅を変えられ、上下限で止まり、再読み込み後も維持される', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await testLogin(page, 1)
    const tree = await createTree(page, 'Resizable Drawer Tree')
    await openTreeEditor(page, tree.id)
    await page.evaluate(() => localStorage.removeItem('zeeta:tree-drawer-width'))
    await page.reload()
    await waitForAppReady(page)

    const drawer = page.locator('#tree-drawer')
    const handle = page.locator('#tree-drawer-resize')
    const paneBefore = await page.locator('#tree-pane').boundingBox()
    await openTreeDrawer(page)
    const initial = (await drawer.boundingBox()).width

    const dragBy = async (dx) => {
      const box = await handle.boundingBox()
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + dx, y, { steps: 5 })
      await page.mouse.up()
    }

    await dragBy(100)
    expect(Math.round((await drawer.boundingBox()).width)).toBe(Math.round(initial + 100))
    // 重ねて表示しているので後ろのペインは動かない
    expect(await page.locator('#tree-pane').boundingBox()).toEqual(paneBefore)
    // つまみを離しても一覧は開いたまま
    await expect(drawer).toHaveClass(/open/)

    await dragBy(1000)
    expect(Math.round((await drawer.boundingBox()).width)).toBe(480)
    await dragBy(-1000)
    expect(Math.round((await drawer.boundingBox()).width)).toBe(220)

    // キーボードでも変えられる
    await handle.focus()
    await page.keyboard.press('ArrowRight')
    expect(Math.round((await drawer.boundingBox()).width)).toBe(236)

    await page.reload()
    await waitForAppReady(page)
    await openTreeDrawer(page)
    expect(Math.round((await drawer.boundingBox()).width)).toBe(236)

    // スマホ幅では今のまま（画面幅の85%・最大300px）で、つまみを出さない
    await page.setViewportSize({ width: 375, height: 740 })
    await expect(handle).toBeHidden()
    expect(Math.round((await drawer.boundingBox()).width)).toBe(300)
  })

  test('TC-RAIL-017: 左バーは最後に開いた順に並び、未オープンは作成順で後ろ、共有ツリーも区切らずに混ざる', async ({ page, browser }) => {
    const ownerPage = await browser.newPage()
    await testLogin(ownerPage, 2)
    const sharedRes = await ownerPage.request.post('/api/trees', { data: { name: 'Shared S' } })
    const shared = (await sharedRes.json()).data
    const invite = await ownerPage.request.post(`/api/trees/${shared.id}/invitations`, {
      data: { email: 'test-user-1@example.com', role: 'viewer' }
    })
    const token = (await invite.json()).data.token
    await ownerPage.close()

    await testLogin(page, 1)
    await page.request.post(`/api/invitations/${token}/accept`, { data: {} })
    const a = await createTree(page, 'Tree A')
    const b = await createTree(page, 'Tree B')
    const c = await createTree(page, 'Tree C')
    await page.evaluate(() => localStorage.removeItem('zeeta:last-accessed-trees'))

    // B → 共有S → A の順に開く。C は開かない
    await openTreeEditor(page, b.id)
    await openTreeEditor(page, shared.id)
    await openTreeEditor(page, a.id)

    const railOrder = await page.locator('#tree-rail-list .tree-rail-chip').evaluateAll(els => els.map(el => Number(el.dataset.treeId)))
    expect(railOrder).toEqual([a.id, shared.id, b.id, c.id])
    await expect(page.locator('#tree-rail-list .tree-rail-sep')).toHaveCount(0)

    await openTreeDrawer(page)
    const drawerOrder = await page.locator('#tree-drawer .tree-drawer-row').evaluateAll(els => els.map(el => Number(el.dataset.treeId)))
    expect(drawerOrder).toEqual([a.id, shared.id, b.id, c.id])
    await expect(page.locator('#tree-drawer .tree-drawer-group-label')).toHaveCount(0)
  })

  test('TC-RAIL-018: 読み込みが速いときは起動時の暗い覆い（読み込み中）を出さず、遅いときだけ出す', async ({ page }) => {
    // ツリー切替のアニメーションに暗い覆いが写り込み、画面が一瞬暗くなるのを防ぐ
    await testLogin(page, 1)
    const tree = await createTree(page, 'Loading Overlay Tree')
    await page.addInitScript(() => {
      window.__loadingOverlayShown = false
      new MutationObserver(() => {
        const overlay = document.getElementById('loading-overlay')
        if (overlay && getComputedStyle(overlay).display !== 'none') window.__loadingOverlayShown = true
      }).observe(document, { subtree: true, childList: true, attributes: true })
    })

    await openTreeEditor(page, tree.id)
    expect(await page.evaluate(() => window.__loadingOverlayShown)).toBe(false)

    await page.route('**/api/trees', async (route) => {
      await new Promise(resolve => setTimeout(resolve, 1200))
      await route.continue()
    })
    await openTreeEditor(page, tree.id)
    expect(await page.evaluate(() => window.__loadingOverlayShown)).toBe(true)
    await expect(page.locator('#loading-overlay')).toBeHidden()
  })

  test('TC-RAIL-019: ツリー切替はアニメーションでつながり、アイコンの移動が最後まで再生される（動きを減らす設定では付けない）', async ({ page }) => {
    await testLogin(page, 1)
    const a = await createTree(page, 'Motion A')
    const b = await createTree(page, 'Motion B')
    await page.addInitScript(() => {
      window.__vt = { revealed: false, chipAnimations: 0, durationMs: 0 }
      window.addEventListener('pagereveal', (event) => {
        const transition = event.viewTransition
        if (!transition) return
        window.__vt.revealed = true
        transition.ready.then(() => {
          const startedAt = performance.now()
          window.__vt.chipAnimations = document.getAnimations()
            .filter(animation => String(animation.effect?.pseudoElement || '').includes('tree-chip-')).length
          transition.finished.then(() => { window.__vt.durationMs = performance.now() - startedAt })
        }).catch(() => {})
      })
    })
    await openTreeEditor(page, a.id)
    await openTreeEditor(page, a.id)

    // 左バーから B に切り替える（B は先頭へ移動する）
    await page.locator(`#tree-rail-list .tree-rail-chip[data-tree-id="${b.id}"]`).click()
    await waitForTreeTitle(page, 'Motion B')
    await expect.poll(() => page.evaluate(() => window.__vt.durationMs)).toBeGreaterThan(0)
    const vt = await page.evaluate(() => window.__vt)
    expect(vt.revealed).toBe(true)
    expect(vt.chipAnimations).toBeGreaterThan(0)
    // 途中で打ち切られていない（アイコンの移動は 280ms）
    expect(vt.durationMs).toBeGreaterThanOrEqual(240)
    await expect(page.locator(`#tree-rail-list .tree-rail-chip`).first()).toHaveAttribute('data-tree-id', String(b.id))

    // 動きを減らす設定ではアニメーションを付けない
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.locator(`#tree-rail-list .tree-rail-chip[data-tree-id="${a.id}"]`).click()
    await waitForTreeTitle(page, 'Motion A')
    await waitForAppReady(page)
    expect(await page.evaluate(() => window.__vt.revealed)).toBe(false)
  })

  test('TC-RAIL-020: アイコン・色を設定したツリーでも切替アニメーションが打ち切られず、最初の描画からアイコンと色が出る', async ({ page }) => {
    await testLogin(page, 1)
    const a = await createTree(page, 'Icon A')
    const b = await createTree(page, 'Icon B')
    await page.request.put(`/api/trees/${a.id}`, { data: { icon: '📚', color: 'pink' } })
    await page.request.put(`/api/trees/${b.id}`, { data: { icon: '🧪' } })
    await page.addInitScript((treeA) => {
      window.__vt = { durationMs: 0, firstChip: null }
      window.addEventListener('pagereveal', (event) => {
        const transition = event.viewTransition
        if (!transition) return
        // 切替先ページの最初の描画（一時保存した一覧から描いたもの）
        const chip = document.querySelector(`#tree-rail-list .tree-rail-chip[data-tree-id="${treeA}"]`)
        window.__vt.firstChip = chip && { text: chip.textContent, background: chip.style.background }
        transition.ready.then(() => {
          const startedAt = performance.now()
          transition.finished.then(() => { window.__vt.durationMs = performance.now() - startedAt })
        }).catch(() => {})
      })
    }, a.id)
    await openTreeEditor(page, a.id)
    await openTreeEditor(page, a.id)

    await page.locator(`#tree-rail-list .tree-rail-chip[data-tree-id="${b.id}"]`).click()
    await waitForTreeTitle(page, 'Icon B')
    await expect.poll(() => page.evaluate(() => window.__vt.durationMs)).toBeGreaterThan(0)
    const vt = await page.evaluate(() => window.__vt)
    // 一覧の取り直しで左バーを描き直すと、アニメーションが途中で打ち切られる（dev では数十ms になる）
    expect(vt.durationMs).toBeGreaterThanOrEqual(240)
    expect(vt.firstChip).toEqual({ text: '📚', background: 'rgb(236, 72, 153)' })
  })
})
