// 編集画面（/index.html）の共通ヘルパー。
// マイページ廃止後はログイン直後も編集画面に着地するため、URL ではなく
// 初期化完了の印（<html data-app-ready="true">）で待ち合わせる。
// ツリー0件の空画面でも同じ印が立つ。

const READY_SELECTOR = 'html[data-app-ready="true"]'

export async function waitForAppReady(page, { timeout = 15000 } = {}) {
  await page.locator(READY_SELECTOR).waitFor({ state: 'attached', timeout })
}

export async function testLogin(page, userId = 1) {
  await page.goto(`/auth/test-login?user_id=${userId}`)
  await waitForAppReady(page)
}

export async function openTreeEditor(page, treeId, nodeId = null) {
  const query = nodeId ? `tree=${treeId}&node=${nodeId}` : `tree=${treeId}`
  await page.goto(`/index.html?${query}`)
  await waitForAppReady(page)
}

export async function openTreeDrawer(page) {
  const drawer = page.locator('#tree-drawer')
  if (await drawer.evaluate(el => el.classList.contains('open'))) return
  await page.locator('#app-menu-btn').click()
  await page.locator('#tree-drawer.open').waitFor({ state: 'visible' })
  // 開くときのスライドが終わるまで待つ（途中だと要素の位置がずれてつかみ損ねる）
  await drawer.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)))
}

export function drawerRow(page, treeName) {
  return page.locator('#tree-drawer .tree-drawer-row', { hasText: treeName }).first()
}

// 左バーを開き、ツリーの ⋯ メニューから項目（edit / mcp / members / delete）を選ぶ
export async function chooseTreeMenu(page, treeName, action) {
  await openTreeDrawer(page)
  const row = drawerRow(page, treeName)
  await row.locator('.tree-drawer-more').click()
  await row.locator(`.tree-drawer-menu [data-action="${action}"]`).click()
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ヘッダーのツリー名が完全一致するまで待つ（遷移前の画面で誤って一致しないよう完全一致にする）
export async function waitForTreeTitle(page, name) {
  await page.locator('#tree-header-title').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(name)}\\s*$`) }).waitFor({ state: 'visible' })
}

// 左バーの「新しいツリー」から作成する。作成後は新しいツリーの編集画面へ移る
export async function createTreeViaUi(page, name, description = '') {
  const railCreate = page.locator('#tree-rail-create-btn')
  if (await railCreate.isVisible()) await railCreate.click()
  else if (await page.locator('#tree-empty-create-btn').isVisible()) await page.locator('#tree-empty-create-btn').click()
  else {
    await openTreeDrawer(page)
    await page.locator('#tree-drawer-create-btn').click()
  }
  await page.locator('#create-tree-modal.active').waitFor({ state: 'visible' })
  await page.fill('#tree-name', name)
  await page.fill('#tree-description', description)
  await page.click('#create-tree-form button[type="submit"]')
  await waitForTreeTitle(page, name)
  await waitForAppReady(page)
  return Number(new URL(page.url()).searchParams.get('tree'))
}

// 左バーを開いてツリー名をクリックし、そのツリーの編集画面へ移る
export async function openTreeByName(page, name) {
  await openTreeDrawer(page)
  await drawerRow(page, name).locator('.tree-drawer-open').click()
  await waitForTreeTitle(page, name)
  await waitForAppReady(page)
  return Number(new URL(page.url()).searchParams.get('tree'))
}

// ヘッダーの設定メニュー（テーマ・言語・プロフィール）を開く
export async function openSettingsMenu(page) {
  if (await page.locator('#settings-menu').isVisible()) return
  await page.locator('#settings-btn').click()
  await page.locator('#settings-menu').waitFor({ state: 'visible' })
}
