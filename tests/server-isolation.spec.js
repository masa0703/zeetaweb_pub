import { test, expect } from './helpers/fixtures.js'
import { request as playwrightRequest } from '@playwright/test'
import { access } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { startTestServer } from './helpers/test-server.js'
import { TEST_DB_PATH } from './helpers/test-environment.js'

test('TC-TEST-ISOLATION-001: clearing one DB preserves the other DB and session', async ({ request }) => {
  test.setTimeout(90000)
  const second = await startTestServer()
  const other = await playwrightRequest.newContext({ baseURL: second.baseURL })
  try {
    for (const client of [request, other]) {
      expect((await client.get('/auth/test-login?user_id=1', { maxRedirects: 0 })).status()).toBe(302)
    }
    const created = []
    for (const [index, client] of [request, other].entries()) {
      const response = await client.post('/api/trees', { data: { name: `Private worker ${index}` } })
      expect(response.ok(), await response.text()).toBeTruthy()
      created.push((await response.json()).data)
    }
    expect(second.dbPath).not.toBe(TEST_DB_PATH)
    const db = new DatabaseSync(second.dbPath, { readOnly: true })
    try {
      expect(db.prepare('SELECT name FROM trees WHERE id = ?').get(created[1].id).name).toBe('Private worker 1')
    } finally { db.close() }
    expect((await request.delete('/api/test/clear')).ok()).toBeTruthy()
    expect((await request.get('/api/trees')).status()).toBe(401)
    const surviving = await other.get('/api/trees')
    expect(surviving.status()).toBe(200)
    expect((await surviving.json()).data.map(tree => tree.name)).toEqual(['Private worker 1'])
    const nodes = await other.get(`/api/trees/${created[1].id}/nodes`)
    expect(nodes.status()).toBe(200)
    expect((await nodes.json()).data.some(node => node.id === created[1].root_node_id)).toBeTruthy()
  } finally {
    await other.dispose()
    await second.stop()
  }
  await expect(access(second.directory)).rejects.toThrow()
  await expect(fetch(second.baseURL, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
})

// These cases intentionally leave their trees to the shared fixture. With no
// cleanup, the second case would hit the 20-tree quota on its first creation.
for (const iteration of [1, 2]) {
  test(`TC-TEST-ISOLATION-002: quota starts empty on iteration ${iteration}`, async ({ request }) => {
    expect((await request.get('/auth/test-login?user_id=1', { maxRedirects: 0 })).status()).toBe(302)
    expect((await (await request.get('/api/trees')).json()).data).toEqual([])
    for (let index = 0; index < 20; index++) {
      const response = await request.post('/api/trees', { data: { name: `Quota isolation ${iteration}-${index}` } })
      expect(response.status(), await response.text()).toBe(201)
    }
  })
}
