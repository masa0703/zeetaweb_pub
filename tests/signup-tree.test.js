import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Miniflare } from 'miniflare'

const dir = await mkdtemp(join(tmpdir(), 'zeeta-signup-'))
const bundle = join(dir, 'database.mjs')
await build({ entryPoints: ['src/utils/database.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { upsertOAuthUser } = await import(pathToFileURL(bundle).href)
await rm(dir, { recursive: true, force: true })

const schema = `PRAGMA foreign_keys=ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY, oauth_provider TEXT NOT NULL, oauth_provider_id TEXT NOT NULL, email TEXT NOT NULL, display_name TEXT, avatar_url TEXT, last_login_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(oauth_provider, oauth_provider_id));
    CREATE TABLE trees (id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_user_id INTEGER NOT NULL REFERENCES users(id), root_node_id INTEGER, trash_root_node_id INTEGER);
    CREATE TABLE tree_members (tree_id INTEGER REFERENCES trees(id), user_id INTEGER REFERENCES users(id), role TEXT, added_by_user_id INTEGER REFERENCES users(id));
    CREATE TABLE nodes (id INTEGER PRIMARY KEY, tree_id INTEGER REFERENCES trees(id), title TEXT, content TEXT, author_user_id INTEGER REFERENCES users(id), created_by_user_id INTEGER REFERENCES users(id), updated_by_user_id INTEGER REFERENCES users(id), public_id TEXT UNIQUE NOT NULL, child_sort_mode TEXT DEFAULT 'manual', child_sort_direction TEXT DEFAULT 'asc');
    CREATE TABLE node_relations (parent_node_id INTEGER REFERENCES nodes(id), child_node_id INTEGER REFERENCES nodes(id), relation_type_id INTEGER, position INTEGER);
  `

function makeDb() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(schema)
  let failBatch = false
  const db = {
    prepare(sql) { return { bind(...values) { return { sql, values, async first() { return sqlite.prepare(sql).get(...values) ?? null }, async run() { sqlite.prepare(sql).run(...values) } } } } },
    async batch(statements) {
      sqlite.exec('BEGIN')
      try {
        for (let i = 0; i < statements.length; i++) {
          const s = statements[i]
          sqlite.prepare(s.sql).run(...s.values)
          if (failBatch && i === 5) throw new Error('injected failure')
        }
        sqlite.exec('COMMIT')
      } catch (e) { sqlite.exec('ROLLBACK'); throw e }
    },
    setFail(value) { failBatch = value }, sqlite,
  }
  return db
}
const user = { provider: 'google', id: 'test-user', email: 'test@example.com', name: 'Test', picture: null }

test('signup creates a complete independent tree and login does not duplicate it', async () => {
  const db = makeDb()
  const created = await upsertOAuthUser(db, user)
  await upsertOAuthUser(db, user)
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM trees').get().n, 1)
  assert.equal(db.sqlite.prepare('SELECT role FROM tree_members WHERE user_id=?').get(created.id).role, 'owner')
  const roots = db.sqlite.prepare(`SELECT child.title FROM trees t JOIN node_relations r ON r.parent_node_id=t.root_node_id JOIN nodes child ON child.id=r.child_node_id ORDER BY r.position`).all()
  assert.deepEqual(roots.map(x => x.title), ['Hello:JP', 'Hello:EN'])
  const multi = db.sqlite.prepare(`SELECT count(*) n FROM (SELECT child_node_id FROM node_relations GROUP BY child_node_id HAVING count(*) > 1)`).get().n
  assert.ok(multi >= 4)
  const mcp = db.sqlite.prepare("SELECT public_id, content FROM nodes WHERE title='MCP'").all()
  assert.equal(mcp.length, 2)
  for (const node of mcp) assert.ok(node.content.includes(`id:${node.public_id}`))
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM nodes WHERE public_id IS NULL').get().n, 0)
})

test('failure rolls back signup and permits retry', async () => {
  const db = makeDb()
  db.setFail(true)
  await assert.rejects(upsertOAuthUser(db, user), /injected failure/)
  for (const table of ['users', 'trees', 'nodes', 'tree_members']) assert.equal(db.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0)
  db.setFail(false)
  await upsertOAuthUser(db, user)
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM trees').get().n, 1)
})


test('signup runs against a real local D1 binding', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response() } }', d1Databases: ['DB'] })
  try {
    const db = await mf.getD1Database('DB')
    await db.exec(schema)
    await upsertOAuthUser(db, user)
    await upsertOAuthUser(db, user)
    assert.equal((await db.prepare('SELECT count(*) n FROM trees').first()).n, 1)
    assert.equal((await db.prepare('SELECT count(*) n FROM nodes').first()).n, 86)
    assert.equal((await db.prepare('SELECT count(*) n FROM node_relations').first()).n, 116)
  } finally { await mf.dispose() }
})
