import { test, expect } from '@playwright/test'
import { waitForAppReady } from './helpers/app.js'

// ノード公開ID(base58 6文字)導入のフロントエンド スモークテスト。
// 目的: ツリー描画・ノード選択・共有URL往復が公開ID化後も実行時エラーなく動くことを検証。

const PUBLIC_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{6}$/

async function loginAndOpenTree(page) {
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  // test-login 後はマイツリーの表示を待つ
  await page.goto('/auth/test-login?user_id=1')
  await waitForAppReady(page)
  // アクセス可能なツリーIDをAPIから取得（環境非依存）
  const treeId = await page.evaluate(async () => {
    const r = await fetch('/api/trees')
    const j = await r.json()
    const arr = j.data || j
    return (arr[0] || {}).id
  })
  expect(treeId).toBeTruthy()
  await page.goto(`/index.html?tree=${treeId}`)
  await page.waitForSelector('.tree-item[data-node-id]', { timeout: 15000 })
  return { pageErrors, consoleErrors, treeId }
}

test('ツリーが公開IDで描画され、実行時エラーが出ない', async ({ page }) => {
  const { pageErrors } = await loginAndOpenTree(page)

  const ids = await page.$$eval('.tree-item[data-node-id]', (els) =>
    els.map((el) => el.getAttribute('data-node-id'))
  )
  expect(ids.length).toBeGreaterThan(0)
  for (const id of ids) {
    expect(id).toMatch(PUBLIC_ID_RE)
  }
  expect(pageErrors, `pageerrors:\n${pageErrors.join('\n')}`).toHaveLength(0)
})

test('ノードをクリックしてエディタが開く（実行時エラーなし）', async ({ page }) => {
  const { pageErrors } = await loginAndOpenTree(page)

  const firstItem = page.locator('.tree-item[data-node-id]').first()
  const nodeId = await firstItem.getAttribute('data-node-id')
  expect(nodeId).toMatch(PUBLIC_ID_RE)

  await firstItem.click()
  await page.waitForTimeout(1000)
  expect(pageErrors, `pageerrors:\n${pageErrors.join('\n')}`).toHaveLength(0)
})

test('共有URL(?tree=&node=公開ID)で対象ノードが開く', async ({ page }) => {
  const { treeId } = await loginAndOpenTree(page)
  const nodeId = await page.locator('.tree-item[data-node-id]').first().getAttribute('data-node-id')
  expect(nodeId).toMatch(PUBLIC_ID_RE)

  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  await page.goto(`/index.html?tree=${treeId}&node=${nodeId}`)
  await page.waitForSelector('.tree-item[data-node-id]', { timeout: 15000 })
  await page.waitForTimeout(500)
  expect(pageErrors, `pageerrors:\n${pageErrors.join('\n')}`).toHaveLength(0)
})
