// @ts-check
import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

/**
 * テストスイート: エディタ本文エリアのスクロール連動拡大 + 作成者メタの固定ヘッダ表示
 *
 * テスト対象:
 * 1. TC-FUNC-015: 作成者メタ情報の固定ヘッダ表示
 *    （<作成者>  C <作成日時>  U <更新日時> 形式・「作成者」キャプション無し）
 * 2. TC-FUNC-058: スクロール連動の本文エリア拡大
 *    （#editor-scroll-area をスクロールすると本文エリアが伸び、title ブロックが隠れ、
 *     本文キャプションが上端に張り付く。戻すと元の高さに戻る）
 */

const BASE_URL = 'http://localhost:3000'

// ===========================
// ヘルパー関数
// ===========================

async function testLogin(page, userId) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`)
  await waitForAppReady(page)
}

async function createTree(page, name) {
  const response = await page.request.post(`${BASE_URL}/api/trees`, {
    data: { name, description: 'Test tree' }
  })
  const data = await response.json()
  return data.data
}

async function createNode(page, treeId, nodeData) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes`, {
    data: nodeData
  })
  const data = await response.json()
  return data.data
}

async function addRelationAPI(page, treeId, parentId, childId) {
  await page.request.post(`${BASE_URL}/api/trees/${treeId}/relations`, {
    data: { parent_node_id: parentId, child_node_id: childId }
  })
}

async function clearTestData(page) {
  try {
    await page.request.delete(`${BASE_URL}/api/test/clear`)
  } catch (e) {
    // Ignore errors
  }
}

/**
 * テスト用ツリー + 子ノードを作成し、エディタでそのノードを開く。
 * 戻り値: { tree, node }
 */
async function openEditorWithNode(page, title) {
  await testLogin(page, 1)
  const tree = await createTree(page, 'Editor Expand Test Tree')
  const node = await createNode(page, tree.id, {
    title,
    content: 'Test content',
    author_user_id: 1
  })
  await addRelationAPI(page, tree.id, tree.root_node_id, node.id)

  await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
  await page.waitForSelector('.tree-item[data-node-id]')
  await page.click(`.tree-item[data-node-id="${node.id}"]`)
  await page.waitForSelector('#node-content-editor .bytemd', { timeout: 15000 })
  await page.waitForSelector('#node-detail-btn', { timeout: 10000 })
  // レイアウト同期（高さ計算）が落ち着くまで待つ
  await page.waitForTimeout(600)
  return { tree, node }
}

/**
 * #editor-scroll-area をスクロールし、レイアウト同期（rAFスロットル）の
 * 反映を待ってから各要素の状態を返す。
 */
async function scrollTo(page, scrollTop) {
  return await page.evaluate(async (st) => {
    const sa = document.getElementById('editor-scroll-area')
    sa.scrollTop = st
    // syncContentEditorHeight は rAF スロットルで動くので2フレーム待つ
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const cm = document.getElementById('node-content-editor')
    const header = document.getElementById('content-editor-header')
    const title = document.getElementById('node-title')
    const saRect = sa.getBoundingClientRect()
    return {
      scrollTop: sa.scrollTop,
      contentHeight: Math.round(cm.getBoundingClientRect().height),
      // 本文キャプション(#content-editor-header)の上端がスクロール領域上端に張り付いているか
      headerPinnedToTop: Math.round(header.getBoundingClientRect().top - saRect.top) <= 2,
      // title 入力欄がスクロール領域の上端より上に隠れたか
      titleOutOfView: title.getBoundingClientRect().bottom <= saRect.top,
    }
  }, scrollTop)
}

// ===========================
// TC-FUNC-015: node detail ダイアログのメタ情報表示
// ===========================

test.describe('node detail ダイアログのメタ情報表示', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-FUNC-015: 作成者・作成日・更新日が node detail ダイアログに表示される', async ({ page }) => {
    await openEditorWithNode(page, 'Meta Dialog Node')

    // 固定ヘッダにメタ情報は出さない（ダイアログへ移設済み）
    await expect(page.locator('#editor-node-meta')).toHaveCount(0)

    // detail ボタンは `id:` とゴミ箱の中間にあり、ツールチップは node detail
    const btn = page.locator('#node-detail-btn')
    await expect(btn).toBeVisible()
    await expect(btn).toHaveAttribute('title', 'node detail')
    // 見た目の位置で判定する。間隔の微調整に負のマージンを使っているため、
    // ボタンの box 同士は重なることがある（glyph は重ならない）
    const position = await page.evaluate(() => {
      const idLabel = document.querySelector('#editor-panel .ml-auto span')
      const circle = document.querySelector('#node-detail-btn i')
      const trashIcon = document.querySelector('#delete-node-btn i')
      return {
        afterId: idLabel.getBoundingClientRect().right <= circle.getBoundingClientRect().left,
        beforeTrash: circle.getBoundingClientRect().right <= trashIcon.getBoundingClientRect().left
      }
    })
    expect(position.afterId).toBe(true)
    expect(position.beforeTrash).toBe(true)

    // detail / ゴミ箱 / 保存 の見た目の間隔は揃える。id と detail の間は
    // 他の 1/3 に、id の右に置いた 1 文字分（margin-right: 1ch）を足した幅にする
    const gaps = await page.evaluate(() => {
      const R = el => el.getBoundingClientRect()
      const id = R(document.querySelector('#editor-panel .ml-auto span'))
      const circle = R(document.querySelector('#node-detail-btn i'))
      const trash = R(document.querySelector('#delete-node-btn i'))
      const save = R(document.getElementById('save-node-btn'))
      return {
        idToDetail: circle.left - id.right,
        detailToTrash: trash.left - circle.right,
        trashToSave: save.left - trash.right
      }
    })
    expect(Math.abs(gaps.detailToTrash - gaps.trashToSave)).toBeLessThanOrEqual(1)
    const oneCh = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('node-id-copy')).marginRight))
    expect(oneCh).toBeGreaterThan(0)
    expect(gaps.idToDetail).toBeGreaterThan(gaps.trashToSave / 3 + oneCh - 3)
    expect(gaps.idToDetail).toBeLessThan(gaps.trashToSave / 3 + oneCh + 3)
    // 「id:」とノードIDの間に空白を入れない
    await expect(page.locator('#node-id-copy')).toHaveText(/^id:\S+$/)

    // ダイアログに作成者・作成日・更新日が1行で出る
    await btn.click()
    await expect(page.locator('#node-detail-dialog')).toBeVisible()
    await expect(page.locator('#node-detail-author')).toHaveText('Test User 1')
    await expect(page.locator('#node-detail-created-at')).toHaveText(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/)
    await expect(page.locator('#node-detail-updated-at')).toHaveText(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/)

    // 初期サイズはビューポートに対する割合（幅90% / 高さ85%）。
    // 履歴一覧と preview の比率は 45:55
    const size = await page.evaluate(() => {
      const panel = document.getElementById('node-detail-dialog-panel').getBoundingClientRect()
      const list = document.querySelector('.node-detail-history-layout > div').getBoundingClientRect()
      const preview = document.getElementById('node-detail-preview').getBoundingClientRect()
      return {
        widthRatio: panel.width / window.innerWidth,
        heightRatio: panel.height / window.innerHeight,
        listShare: list.width / (list.width + preview.width)
      }
    })
    expect(size.widthRatio).toBeGreaterThan(0.88)
    expect(size.widthRatio).toBeLessThan(0.92)
    expect(size.heightRatio).toBeGreaterThan(0.83)
    expect(size.heightRatio).toBeLessThan(0.87)
    expect(size.listShare).toBeGreaterThan(0.40)
    expect(size.listShare).toBeLessThan(0.50)

    // 作成者IDは保存用の hidden input として残っている
    const authorField = page.locator('#node-author')
    await expect(authorField).toHaveAttribute('type', 'hidden')
    await expect(authorField).toHaveValue('1')

    console.log('✅ TC-FUNC-015: Node detail dialog shows author and timestamps')
  })

  test('TC-FUNC-079: detail ボタンのホバー枠が id に重ならず、id をクリックすると「id:xxxxxx」をコピーする', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL })
    const { node } = await openEditorWithNode(page, 'Copy Id Node')

    // ホバーで出る detail ボタンの枠（ボタンの box）が id ラベルに被らない
    const overlap = await page.evaluate(() => {
      const id = document.getElementById('node-id-copy').getBoundingClientRect()
      const btn = document.getElementById('node-detail-btn').getBoundingClientRect()
      return btn.left - id.right
    })
    expect(overlap).toBeGreaterThanOrEqual(0)

    await page.click('#node-id-copy')
    await expect(page.getByText('IDをコピーしました')).toBeVisible()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toBe(`id:${node.id}`)
  })
})

// ===========================
// TC-FUNC-058: スクロール連動の本文エリア拡大
// ===========================

test.describe('スクロール連動の本文エリア拡大', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-FUNC-058: スクロールで本文エリアが伸び、titleが隠れ、キャプションが上端に張り付く', async ({ page }) => {
    await openEditorWithNode(page, 'Scroll Expand Node')

    const initial = await scrollTo(page, 0)
    expect(initial.headerPinnedToTop).toBe(false)
    expect(initial.titleOutOfView).toBe(false)

    // スクロール領域を最大までスクロール
    const maxScroll = await page.evaluate(() => {
      const sa = document.getElementById('editor-scroll-area')
      return sa.scrollHeight - sa.clientHeight
    })
    expect(maxScroll).toBeGreaterThan(0)

    const max = await scrollTo(page, maxScroll)

    // 本文エリア（#node-content-editor）の高さが伸びている
    expect(max.contentHeight).toBeGreaterThan(initial.contentHeight + 40)

    // title 入力欄がスクロールで隠れている
    expect(max.titleOutOfView).toBe(true)

    // 本文キャプション（#content-editor-header）がスクロール領域上端に張り付いている
    expect(max.headerPinnedToTop).toBe(true)

    // 先頭に戻すと高さが元に戻る
    const restored = await scrollTo(page, 0)
    expect(Math.abs(restored.contentHeight - initial.contentHeight)).toBeLessThanOrEqual(2)
    expect(restored.titleOutOfView).toBe(false)

    console.log('✅ TC-FUNC-058: Content editor expands on scroll and restores')
  })
})

// ===========================
// TC-FUNC-059: エディタペインが狭いときのヘッダ1行維持
// ===========================

test.describe('エディタペインが狭いときのヘッダ', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-FUNC-059: ペインを狭めてもヘッダは1行のままで本文の高さが変わらない', async ({ page }) => {
    await openEditorWithNode(page, 'Narrow Pane Node')

    const probe = async (width) => await page.evaluate(async (w) => {
      document.getElementById('tree-pane').style.width = w
      window.dispatchEvent(new Event('resize'))
      await new Promise(resolve => setTimeout(resolve, 400))
      const chip = document.querySelector('.parents-chip-toggle').getBoundingClientRect()
      const actions = document.querySelector('#editor-panel .ml-auto').getBoundingClientRect()
      const save = document.getElementById('save-node-btn').getBoundingClientRect()
      const pane = document.getElementById('editor-pane').getBoundingClientRect()
      return {
        chipHeight: Math.round(chip.height),
        gapChipToActions: Math.round(actions.left - chip.right),
        contentHeight: Math.round(document.getElementById('node-content-editor').getBoundingClientRect().height),
        saveInsidePane: save.right <= pane.right + 1,
        saveOverflow: Math.round(save.right - pane.right)
      }
    }, width)

    const base = await probe('33.333%')

    for (const width of ['60%', '70%']) {
      const narrow = await probe(width)
      // 親ノードチップは折り返さない。折り返すとヘッダが2〜3行になり、その分本文が縮む
      expect(narrow.chipHeight).toBe(base.chipHeight)
      // 本文の高さはペイン幅に関係なく維持される
      expect(narrow.contentHeight).toBe(base.contentHeight)
      // 保存ボタンは押し出されない
      expect(narrow.saveInsidePane).toBe(true)
      // チップはアイコンと余白の分（約22px）までしか縮められないため、
      // 左の領域が尽きるとその分だけはみ出す。数px の接触は許容する
      expect(narrow.gapChipToActions).toBeGreaterThanOrEqual(-4)
    }

    // ツリー80%（編集ペイン約20%）は、id・detail・ゴミ箱・保存の固定幅（約228px）が
    // ペイン幅を超えるため保存ボタンがわずかにはみ出す。ヘッダが1行であることと
    // 本文の高さが変わらないことは維持し、はみ出し量が広がっていないことだけ見る
    // 実際のドラッグでは最大幅から左バーの幅を引いている（app.js setupPaneResize）ので同じ上限で測る
    const extreme = await probe('calc(80% - 56px)')
    expect(extreme.chipHeight).toBe(base.chipHeight)
    expect(extreme.contentHeight).toBe(base.contentHeight)
    // チップの最小幅（アイコンと余白で約22px）が残るため、はみ出しは
    // 「固定幅の超過分」で有界になる。広がっていないことだけを見る
    expect(extreme.gapChipToActions).toBeGreaterThanOrEqual(-16)
    expect(extreme.saveOverflow).toBeLessThanOrEqual(16)

    console.log('✅ TC-FUNC-059: Header stays on one line when the editor pane is narrow')
  })
})

// ===========================
// TC-FUNC-060: モバイル幅で下端に無駄な空白を作らない
// ===========================

test.describe('モバイル幅の本文エリア', () => {
  test.use({ viewport: { width: 390, height: 664 } })

  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  test('TC-FUNC-060: モバイルではスペーサーを持たず、本文の高さがビューポート基準になる', async ({ page }) => {
    await openEditorWithNode(page, 'Mobile Node')

    const layout = await page.evaluate(() => {
      const sa = document.getElementById('editor-scroll-area')
      const spacer = document.getElementById('editor-scroll-spacer')
      const content = document.getElementById('node-content-editor')
      return {
        isMobileCss: matchMedia('(max-width: 767px)').matches,
        spacerHeight: Math.round(spacer.getBoundingClientRect().height),
        contentHeight: Math.round(content.getBoundingClientRect().height),
        expectedContentHeight: Math.max(180, Math.round(window.innerHeight * 0.55)),
        // モバイルでは編集ペインが独立スクロールしない（ページ全体がスクロールする）
        paneMaxScroll: sa.scrollHeight - sa.clientHeight,
        // 本文の下端からページ末尾までの余白
        gapBelowContent: Math.round(
          document.getElementById('editor-pane').getBoundingClientRect().bottom -
          content.getBoundingClientRect().bottom
        )
      }
    })

    expect(layout.isMobileCss).toBe(true)
    // スペーサーは持たない（持つと下端がそのまま無駄な空白になる）
    expect(layout.spacerHeight).toBe(0)
    // 本文の高さはビューポート基準。スクロール領域の高さから求めると
    // ペイン高と循環参照になり、描画のたびに伸びてしまう
    expect(layout.contentHeight).toBe(layout.expectedContentHeight)
    expect(layout.paneMaxScroll).toBe(0)
    // 本文の下に余計な空白が残らない
    expect(layout.gapBelowContent).toBeLessThanOrEqual(24)

    console.log('✅ TC-FUNC-060: Mobile layout keeps no dead space below the content editor')
  })
})

test.describe('Mobile content swipe to fullscreen', () => {
  test.use({ viewport: { width: 390, height: 664 }, hasTouch: true })

  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
  })

  async function swipe(page, cdp, x, fromY, toY) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: fromY }] })
    const steps = 5
    for (let i = 1; i <= steps; i++) {
      const y = fromY + ((toY - fromY) * i) / steps
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(300)
  }

  const contentState = page => page.evaluate(() => {
    const bytemd = document.querySelector('.bytemd')
    const rect = bytemd.getBoundingClientRect()
    const header = document.getElementById('tree-header')
    return {
      fullscreen: bytemd.classList.contains('bytemd-fullscreen'),
      top: Math.round(rect.top),
      height: Math.round(rect.height),
      viewportHeight: window.innerHeight,
      headerVisible: !!header && getComputedStyle(header).display !== 'none'
    }
  })

  test('TC-FUNC-061: 本文を上へスワイプすると画面全体に広がり、先頭で下へ引くと戻る', async ({ page }) => {
    await testLogin(page, 1)
    const tree = await createTree(page, 'Mobile Swipe Tree')
    const content = Array.from({ length: 60 }, (_, i) => `## 見出し ${i + 1}\n本文の行 ${i + 1}`).join('\n\n')
    const node = await createNode(page, tree.id, { title: 'Long Node', content, author_user_id: 1 })
    await addRelationAPI(page, tree.id, tree.root_node_id, node.id)
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForSelector('.tree-item[data-node-id]')
    await page.click(`.tree-item[data-node-id="${node.id}"]`)
    await page.waitForSelector('#node-content-editor .bytemd .bytemd-preview', { timeout: 15000 })
    await page.waitForTimeout(600)

    const cdp = await page.context().newCDPSession(page)
    const preview = page.locator('.bytemd-preview')
    // 本文の欄が画面に入るまでページをスクロールしておく
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight))
    await page.waitForTimeout(200)
    const box = await preview.boundingBox()
    const x = Math.round(box.x + box.width / 2)
    const y = Math.round(box.y + Math.min(box.height - 10, 120))

    expect((await contentState(page)).fullscreen).toBe(false)

    // 上へスワイプ（本文の下端まで見えている状態から）→ 全画面。ヘッダーも隠れ、本文が画面の上端から下端まで広がる
    await swipe(page, cdp, x, y, y - 80)
    const expanded = await contentState(page)
    expect(expanded.fullscreen).toBe(true)
    expect(expanded.headerVisible).toBe(false)
    expect(expanded.top).toBe(0)
    expect(expanded.height).toBe(expanded.viewportHeight)

    // 本文が途中までスクロールされているときに下へ引いても戻らない（本文を戻すだけ）
    await page.evaluate(() => { document.querySelector('.bytemd-preview').scrollTop = 200 })
    await swipe(page, cdp, x, 300, 380)
    expect((await contentState(page)).fullscreen).toBe(true)

    // 本文が先頭にある状態で下へ引くと元に戻る
    await page.evaluate(() => { document.querySelector('.bytemd-preview').scrollTop = 0 })
    await swipe(page, cdp, x, 300, 380)
    const restored = await contentState(page)
    expect(restored.fullscreen).toBe(false)
    expect(restored.headerVisible).toBe(true)

    // PC 幅ではスワイプしても全画面にしない
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.waitForTimeout(400)
    const wideBox = await page.locator('.bytemd-preview').boundingBox()
    const wx = Math.round(wideBox.x + wideBox.width / 2)
    const wy = Math.round(wideBox.y + Math.min(wideBox.height - 10, 120))
    await swipe(page, cdp, wx, wy, wy - 80)
    expect((await contentState(page)).fullscreen).toBe(false)
  })

  test('TC-FUNC-062: ホイールで上へスクロールしても広がり、本文の先頭で下へスクロールすると戻る', async ({ page }) => {
    await testLogin(page, 1)
    const tree = await createTree(page, 'Mobile Wheel Tree')
    const content = Array.from({ length: 60 }, (_, i) => `## 見出し ${i + 1}\n本文の行 ${i + 1}`).join('\n\n')
    const node = await createNode(page, tree.id, { title: 'Long Node', content, author_user_id: 1 })
    await addRelationAPI(page, tree.id, tree.root_node_id, node.id)
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForSelector('.tree-item[data-node-id]')
    await page.click(`.tree-item[data-node-id="${node.id}"]`)
    await page.waitForSelector('#node-content-editor .bytemd .bytemd-preview', { timeout: 15000 })
    await page.waitForTimeout(600)

    // 本文の下端が見えていないうちは、上へスクロールしてもページが送られるだけ
    await page.mouse.move(195, 500)
    await page.mouse.wheel(0, 60)
    await page.waitForTimeout(400)
    expect((await contentState(page)).fullscreen).toBe(false)

    // 本文の下端まで見えた状態で、TITLE 欄の上でさらに上へスクロールすると広がる
    // （本文の外でも編集ペインなら反応する）
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight))
    await page.waitForTimeout(300)
    const title = await page.locator('#node-title').boundingBox()
    await page.mouse.move(title.x + 20, title.y + title.height / 2)
    await page.mouse.wheel(0, 120)
    await page.waitForTimeout(400)
    const expanded = await contentState(page)
    expect(expanded.fullscreen).toBe(true)
    expect(expanded.top).toBe(0)
    expect(expanded.height).toBe(expanded.viewportHeight)

    // 本文が先頭にある状態で上へホイール → 戻る
    await page.evaluate(() => { document.querySelector('.bytemd-preview').scrollTop = 0 })
    await page.mouse.move(195, 400)
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(400)
    const restored = await contentState(page)
    expect(restored.fullscreen).toBe(false)
    expect(restored.headerVisible).toBe(true)

    // 戻したあとツリーが見える位置までページを戻すと、上へスクロールしても再び広がらない
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(300)
    await page.mouse.move(195, 500)
    await page.mouse.wheel(0, 60)
    await page.waitForTimeout(400)
    expect((await contentState(page)).fullscreen).toBe(false)

    // ツリーペインでのホイールは反応しない
    const treeBox = await page.locator('#tree-pane').boundingBox()
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.mouse.move(treeBox.x + 50, treeBox.y + 80)
    await page.mouse.wheel(0, 120)
    await page.waitForTimeout(400)
    expect((await contentState(page)).fullscreen).toBe(false)
  })

  test('TC-FUNC-063: 全画面の本文は見えている範囲（visualViewport）に合わせ、キーボードで縮んでもツールバーと下端が見える', async ({ page }) => {
    // iOS のバー・キーボードは Chromium では再現できないので、visualViewport を差し替えて再現する
    await page.addInitScript(() => {
      const fake = new EventTarget()
      Object.assign(fake, { height: 600, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 })
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake })
      window.__setViewport = (height, offsetTop) => {
        fake.height = height
        fake.offsetTop = offsetTop
        fake.dispatchEvent(new Event('resize'))
      }
    })
    await testLogin(page, 1)
    const tree = await createTree(page, 'Mobile Viewport Tree')
    const content = Array.from({ length: 60 }, (_, i) => `## 見出し ${i + 1}\n本文の行 ${i + 1}`).join('\n\n')
    const node = await createNode(page, tree.id, { title: 'Long Node', content, author_user_id: 1 })
    await addRelationAPI(page, tree.id, tree.root_node_id, node.id)
    await page.goto(`${BASE_URL}/index.html?tree=${tree.id}`)
    await page.waitForSelector('.tree-item[data-node-id]')
    await page.click(`.tree-item[data-node-id="${node.id}"]`)
    await page.waitForSelector('#node-content-editor .bytemd .bytemd-preview', { timeout: 15000 })
    await page.waitForTimeout(600)
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight))
    await page.waitForTimeout(300)
    await page.mouse.move(195, 400)
    await page.mouse.wheel(0, 120)
    await page.waitForTimeout(400)

    const measure = () => page.evaluate(() => {
      const bytemd = document.querySelector('.bytemd')
      const rect = bytemd.getBoundingClientRect()
      const toolbar = bytemd.querySelector('.bytemd-toolbar').getBoundingClientRect()
      const status = bytemd.querySelector('.bytemd-status').getBoundingClientRect()
      return {
        fullscreen: bytemd.classList.contains('bytemd-fullscreen'),
        top: Math.round(rect.top),
        height: Math.round(rect.height),
        toolbarTop: Math.round(toolbar.top),
        statusBottom: Math.round(status.bottom),
        pageLocked: getComputedStyle(document.documentElement).overflow === 'hidden'
      }
    })

    // バーで隠れた分を除いた高さ（600px）に収まり、ツールバーが上端・ステータス行が下端に見える
    const full = await measure()
    expect(full.fullscreen).toBe(true)
    expect(full.top).toBe(0)
    expect(full.height).toBe(600)
    expect(full.toolbarTop).toBe(0)
    expect(full.statusBottom).toBeLessThanOrEqual(600)
    // 裏のページはスクロールさせない
    expect(full.pageLocked).toBe(true)

    // キーボードが出て見えている範囲が縮み、ずれた（offsetTop）ときも追従する
    await page.evaluate(() => window.__setViewport(320, 40))
    await page.waitForTimeout(200)
    const keyboard = await measure()
    expect(keyboard.top).toBe(40)
    expect(keyboard.height).toBe(320)
    expect(keyboard.toolbarTop).toBe(40)
    expect(keyboard.statusBottom).toBeLessThanOrEqual(360)

    // 全画面を抜けると元に戻る
    await page.evaluate(() => window.__setViewport(600, 0))
    await page.evaluate(() => { document.querySelector('.bytemd-preview').scrollTop = 0 })
    await page.mouse.move(195, 300)
    await page.mouse.wheel(0, -120)
    await page.waitForTimeout(400)
    const restored = await page.evaluate(() => ({
      fullscreen: document.querySelector('.bytemd').classList.contains('bytemd-fullscreen'),
      inlineHeight: document.querySelector('.bytemd').style.height,
      pageLocked: document.documentElement.classList.contains('mobile-content-fullscreen')
    }))
    expect(restored.fullscreen).toBe(false)
    expect(restored.inlineHeight).toBe('')
    expect(restored.pageLocked).toBe(false)
  })
})
