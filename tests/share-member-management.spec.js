import { test, expect } from '@playwright/test'
import { waitForAppReady, openTreeEditor, openTreeDrawer, drawerRow, chooseTreeMenu } from './helpers/app.js'

const BASE_URL = 'http://localhost:3000'

async function clearTestData(page) {
  await page.request.delete(`${BASE_URL}/api/test/clear`)
}

async function testLogin(page, userId) {
  await page.context().clearCookies()
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`)
  await waitForAppReady(page)
}

async function createTree(page, name) {
  const response = await page.request.post(`${BASE_URL}/api/trees`, {
    data: { name, description: 'share member management test' }
  })
  expect(response.status()).toBe(201)
  const data = await response.json()
  expect(data.success).toBeTruthy()
  return data.data
}

async function sendInvitation(page, treeId, email, role) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/invitations`, {
    data: { email, role }
  })
  expect(response.status()).toBe(201)
  const data = await response.json()
  expect(data.success).toBeTruthy()
  return data.data
}

async function acceptInvitation(page, token) {
  const response = await page.request.post(`${BASE_URL}/api/invitations/${token}/accept`, {
    data: {}
  })
  expect(response.status()).toBe(200)
}

async function getTreeMembers(page, treeId) {
  const response = await page.request.get(`${BASE_URL}/api/trees/${treeId}/members`)
  expect(response.status()).toBe(200)
  const data = await response.json()
  expect(data.success).toBeTruthy()
  return data.data
}

// 左バーの ⋯ メニュー「メンバー管理」から共有ダイアログを開く
async function openShareDialog(page, treeName) {
  await expect(drawerRow(page, treeName)).toBeAttached()
  await chooseTreeMenu(page, treeName, 'members')
  await expect(page.locator('#member-modal.active')).toBeVisible()
}

test.describe('Share / Member Management', () => {
  test.beforeEach(async ({ page }) => {
    await clearTestData(page)
    page.on('dialog', async dialog => {
      await dialog.accept()
    })
  })

  test('owner can cancel pending invitation and cancelled token becomes unusable', async ({ page }) => {
    await testLogin(page, 1)
    const tree = await createTree(page, 'Invitation Cancel Tree')
    const invitation = await sendInvitation(page, tree.id, 'test-user-2@example.com', 'editor')

    await openTreeEditor(page, tree.id)
    await openShareDialog(page, 'Invitation Cancel Tree')

    await expect(page.locator('#pending-invitations-list')).toContainText('test-user-2@example.com')
    const cancelResponsePromise = page.waitForResponse(response =>
      response.url().endsWith(`/api/trees/${tree.id}/invitations/${invitation.id}`) &&
      response.request().method() === 'DELETE'
    )
    await page.locator('#pending-invitations-list button[title="招待を取り消す"]').click()
    const cancelResponse = await cancelResponsePromise
    expect(cancelResponse.status()).toBe(200)
    await expect(page.locator('#pending-invitations-section')).toBeHidden()

    const invitationDetailsResponse = await page.request.get(`${BASE_URL}/api/invitations/${invitation.token}`)
    expect(invitationDetailsResponse.status()).toBe(400)
    const invitationDetailsData = await invitationDetailsResponse.json()
    expect(invitationDetailsData.error).toContain('used or cancelled')
  })

  test('shared editor can open read-only share dialog while viewer cannot open it', async ({ page, browser }) => {
    await testLogin(page, 1)
    const tree = await createTree(page, 'Shared Read Only Tree')
    const editorInvitation = await sendInvitation(page, tree.id, 'test-user-2@example.com', 'editor')
    const viewerInvitation = await sendInvitation(page, tree.id, 'test-user-3@example.com', 'viewer')
    await sendInvitation(page, tree.id, 'pending@example.com', 'viewer')

    const editorPage = await browser.newPage()
    editorPage.on('dialog', async dialog => {
      await dialog.accept()
    })
    await testLogin(editorPage, 2)
    await acceptInvitation(editorPage, editorInvitation.token)
    await openTreeEditor(editorPage, tree.id)
    await openShareDialog(editorPage, 'Shared Read Only Tree')

    await expect(editorPage.locator('#members-list')).toContainText('test-user-2@example.com')
    await expect(editorPage.locator('#pending-invitations-section')).toBeVisible()
    await expect(editorPage.locator('#pending-invitations-list')).toContainText('pending@example.com')
    await expect(editorPage.locator('#invite-section')).toBeHidden()
    await expect(editorPage.locator('#pending-invitations-list button[title="招待を取り消す"]')).toHaveCount(0)
    await expect(editorPage.locator('#members-list button[title="メンバーを削除"]')).toHaveCount(0)
    await expect(editorPage.locator('#members-list select')).toHaveCount(0)

    const editorInviteResponse = await editorPage.request.post(`${BASE_URL}/api/trees/${tree.id}/invitations`, {
      data: { email: 'blocked@example.com', role: 'viewer' }
    })
    expect(editorInviteResponse.status()).toBe(403)

    const viewerPage = await browser.newPage()
    viewerPage.on('dialog', async dialog => {
      await dialog.accept()
    })
    await testLogin(viewerPage, 3)
    await acceptInvitation(viewerPage, viewerInvitation.token)
    await openTreeEditor(viewerPage, tree.id)

    // 閲覧者の ⋯ メニューには「メンバー管理」が出ない
    await openTreeDrawer(viewerPage)
    const viewerRow = drawerRow(viewerPage, 'Shared Read Only Tree')
    await expect(viewerRow).toBeVisible()
    await viewerRow.locator('.tree-drawer-more').click()
    await expect(viewerRow.locator('.tree-drawer-menu [data-action="members"]')).toHaveCount(0)

    await editorPage.close()
    await viewerPage.close()
  })

  test('owner can change member roles and editor cannot change roles directly', async ({ page, browser }) => {
    await testLogin(page, 1)
    const tree = await createTree(page, 'Owner Role Change Tree')
    const editorInvitation = await sendInvitation(page, tree.id, 'test-user-2@example.com', 'editor')
    const viewerInvitation = await sendInvitation(page, tree.id, 'test-user-3@example.com', 'viewer')

    const editorPage = await browser.newPage()
    editorPage.on('dialog', async dialog => {
      await dialog.accept()
    })
    await testLogin(editorPage, 2)
    await acceptInvitation(editorPage, editorInvitation.token)

    const viewerPage = await browser.newPage()
    viewerPage.on('dialog', async dialog => {
      await dialog.accept()
    })
    await testLogin(viewerPage, 3)
    await acceptInvitation(viewerPage, viewerInvitation.token)
    await viewerPage.close()

    await openTreeEditor(page, tree.id)
    await openShareDialog(page, 'Owner Role Change Tree')

    const editorRow = page.locator('#members-list > div', { hasText: 'test-user-2@example.com' }).first()
    const viewerRow = page.locator('#members-list > div', { hasText: 'test-user-3@example.com' }).first()
    const ownerRow = page.locator('#members-list > div', { hasText: 'test-user-1@example.com' }).first()

    await expect(editorRow.locator('select')).toHaveValue('editor')
    await editorRow.locator('select').selectOption('viewer')
    await expect(page.locator('#members-list > div', { hasText: 'test-user-2@example.com' }).first().locator('select')).toHaveValue('viewer')

    await expect(viewerRow.locator('select')).toHaveValue('viewer')
    await viewerRow.locator('select').selectOption('editor')
    await expect(page.locator('#members-list > div', { hasText: 'test-user-3@example.com' }).first().locator('select')).toHaveValue('editor')

    await expect(ownerRow.locator('select')).toHaveCount(0)

    const members = await getTreeMembers(page, tree.id)
    expect(members.find(member => member.user_id === 2)?.role).toBe('viewer')
    expect(members.find(member => member.user_id === 3)?.role).toBe('editor')

    const forbiddenRoleChange = await editorPage.request.put(`${BASE_URL}/api/trees/${tree.id}/members/3/role`, {
      data: { role: 'viewer' }
    })
    expect(forbiddenRoleChange.status()).toBe(403)

    await editorPage.close()
  })
})
