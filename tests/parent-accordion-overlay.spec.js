import { test, expect } from '@playwright/test';
import { waitForAppReady } from './helpers/app.js';

const BASE_URL = 'http://localhost:3000';

async function testLogin(page, userId) {
  await page.goto(`${BASE_URL}/auth/test-login?user_id=${userId}`);
  await waitForAppReady(page);
}

async function createTree(page, name) {
  const response = await page.request.post(`${BASE_URL}/api/trees`, {
    data: { name, description: 'Test tree' }
  });
  const data = await response.json();
  return data.data;
}

async function createNodeAPI(page, treeId, nodeData) {
  const response = await page.request.post(`${BASE_URL}/api/trees/${treeId}/nodes`, {
    data: { author_user_id: 1, ...nodeData }
  });
  const data = await response.json();
  return data.data;
}

async function addRelationAPI(page, treeId, parentId, childId) {
  await page.request.post(`${BASE_URL}/api/trees/${treeId}/relations`, {
    data: { parent_node_id: parentId, child_node_id: childId }
  });
}

test('親ノードアコーディオンから遷移してもオーバーレイが残らない', async ({ page }) => {
  await testLogin(page, 1);

  const tree = await createTree(page, 'parent-overlay-test');
  const treeId = tree.id;

  const parent = await createNodeAPI(page, treeId, { title: 'Parent Node', content: 'parent content' });
  const child = await createNodeAPI(page, treeId, { title: 'Child Node', content: 'child content' });
  await addRelationAPI(page, treeId, parent.id, child.id);

  // 子ノードを開く
  await page.goto(`${BASE_URL}/?tree=${treeId}&node=${child.id}`);
  await page.waitForSelector('#editor-panel');
  await expect(page.locator('#node-title')).toHaveValue('Child Node');

  // 親アコーディオンを開く
  const accordionToggle = page.locator('button.parents-chip-toggle');
  await expect(accordionToggle).toBeVisible();
  await accordionToggle.click();

  // オーバーレイが表示されることを確認
  const overlay = page.locator('#parents-accordion-overlay');
  await expect(overlay).toBeVisible();

  // 親ノード名をクリックして遷移
  const parentLink = page.locator('.parent-name-link');
  await expect(parentLink).toBeVisible();
  await parentLink.click();

  // 親ノードに遷移したことを確認
  await expect(page.locator('#node-title')).toHaveValue('Parent Node');

  // オーバーレイが削除されていることを確認
  await expect(overlay).toHaveCount(0);
});
