import { expect } from './fixtures.js'

export async function createPublicIdTree(page) {
  const response = await page.request.post('/api/trees', { data: { name: 'Public ID fixture' } })
  expect(response.ok(), await response.text()).toBeTruthy()
  const { data: tree } = await response.json()
  const node = await page.request.post(`/api/trees/${tree.id}/nodes/with-parent`, {
    data: { title: 'Public ID child', content: 'Fixture', parent_node_id: tree.root_node_id, author_user_id: 1 }
  })
  expect(node.ok(), await node.text()).toBeTruthy()
  return tree
}
